/**
 * Browser tabs: finds the tab to save, makes sure its content script can answer (injecting the page's scripts when it has none), reloads a stale page, and sends messages that carry the interface language.
 *
 * Created once by background.js with `createTabs(deps)`; `deps` carries the shared services
 * (storage, the Notion request function, the queue) so this file has no globals of its own.
 */
(function attachSavourBackgroundTabs(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourBackgroundTabs = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundTabsModule() {
  "use strict";

  /**
   * @param {Pick<import("../types").Services, "I" | "S">} deps services from background.js
   */
  function createTabs(deps) {
    const { I, S } = deps;

    // No site has a content script of its own in the manifest: every page gets its files injected when the
    // user saves from it, and the activeTab permission allows exactly that tab, at that moment.
    const COMMON_SCRIPTS = ["i18n/en.js", "i18n/index.js", "lib/shared.js", "content/toast.js"];
    const SITE_SCRIPTS = [
      {
        hosts: new Set(S.THREADS_HOSTS),
        js: [
          ...COMMON_SCRIPTS,
          "content/dom-scope.js",
          "content/dom-extract.js",
          "content/legacy-discussion-dom.js",
          "content/legacy-discussion-data.js",
          "content/page-capture.js",
          "content/threads-content.js"
        ]
      },
      { hosts: new Set(["www.plurk.com", "plurk.com"]), js: [...COMMON_SCRIPTS, "content/plurk-capture.js", "content/plurk-content.js"] },
      { hosts: new Set(["www.instagram.com", "instagram.com"]), js: [...COMMON_SCRIPTS, "content/instagram-capture.js", "content/instagram-content.js"] }
    ];

    const INJECTED_SCRIPTS = [
      "i18n/en.js",
      "i18n/index.js",
      "lib/shared.js",
      "content/toast.js",
      "vendor/readability/Readability.js",
      "content/web-article.js",
      "content/x-capture.js",
      "content/youtube-capture.js",
      "content/linkedin-capture.js",
      "content/facebook-capture.js",
      "content/web-content.js"
    ];

    /**
     * Sends a message to a tab's content script and unwraps the `{ ok, result }` reply.
     * @param {number} tabId
     * @param {any} message
     * @returns {Promise<any>}
     */
    async function sendToTab(tabId, message) {
      const response = await chrome.tabs.sendMessage(tabId, { ...message, lang: I.getLanguage() });
      if (response?.ok === false) throw new Error(response.error || S.t("頁面擷取失敗"));
      return response?.result ?? response;
    }

    // Runs inside the page (chrome.scripting serializes it, so it uses nothing outside itself). The page is
    // where the image sites allow the read: Threads, Instagram, Facebook, X and Plurk serve their own
    // pictures to their own pages, not to the extension. Returns the bytes as base64.
    async function readImageInPage(/** @type {string} */ url, /** @type {number} */ maxBytes, /** @type {number} */ timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { credentials: "omit", cache: "no-store", redirect: "follow", signal: controller.signal });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
        const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!type.startsWith("image/")) return { ok: false, error: "not an image" };
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, error: "too large" };
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) return { ok: false, error: "empty" };
        if (bytes.length > maxBytes) return { ok: false, error: "too large" };
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(index, index + 0x8000)));
        }
        return { ok: true, type, size: bytes.length, base64: btoa(binary) };
      } catch (error) {
        return { ok: false, error: String(/** @type {any} */ (error)?.message ?? error) };
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Reads one image from inside the tab's page.
     * @param {number} tabId
     * @param {string} url
     * @returns {Promise<{ ok: boolean, type?: string, size?: number, base64?: string, error?: string }>}
     */
    async function fetchImageInTab(tabId, url, maxBytes = 20 * 1024 * 1024, timeoutMs = 30000) {
      try {
        const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readImageInPage, args: [url, maxBytes, timeoutMs] });
        return injection?.result ?? { ok: false, error: "no result" };
      } catch (error) {
        return { ok: false, error: String(/** @type {any} */ (error)?.message ?? error) };
      }
    }

    /** @returns {Promise<import("../types").PageTab>} */
    async function activeThreadsTab() {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !S.isSupportedSourceUrl(tab.url ?? "")) throw new Error(notAWebPage());
      return /** @type {import("../types").PageTab} */ (tab);
    }

    const notAWebPage = () => S.t("這個分頁不是網頁，請先開啟想保存的文章或貼文");

    // The files a page needs: its site's own capture scripts for Threads, Plurk and Instagram, the general ones otherwise.
    function scriptsFor(/** @type {string} */ url) {
      let hostname = "";
      try {
        hostname = new URL(url).hostname.toLowerCase();
      } catch {
        // Not an address; the general scripts are used.
      }
      const site = SITE_SCRIPTS.find(entry => entry.hosts.has(hostname));
      return { js: site?.js ?? INJECTED_SCRIPTS, css: ["content/content.css"] };
    }

    // Makes sure the tab can answer capture messages by injecting the page's scripts when it cannot yet.
    // The injected scripts guard against running twice.
    async function ensurePageScripts(/** @type {import("../types").PageTab} */ tab) {
      const url = tab?.url ?? "";
      if (!S.isSupportedSourceUrl(url)) throw new Error(notAWebPage());
      const ready = await chrome.tabs.sendMessage(tab.id, { type: "PING" })
        .then(response => Boolean(response?.ok && response.result?.ready))
        .catch(() => false);
      if (ready) return;
      const files = scriptsFor(url);
      try {
        if (files.css.length) await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: files.css });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: files.js });
      } catch {
        throw new Error(S.t("無法讀取這個頁面。Chrome 內建頁面、線上應用程式商店與部分受保護的網站不能保存；如果剛更新過擴充功能，請重新整理頁面後再試一次"));
      }
    }

    // Reloads the tab once (like pressing F5) when the page data belongs to an earlier in-site page.
    async function ensureFreshThreadPage(/** @type {number} */ tabId) {
      // A tab with no content script (or one that is still loading) cannot answer; treat it as "not stale".
      const status = await sendToTab(tabId, { type: "GET_PAGE_DATA_STATUS" }).catch(() => /** @type {any} */ (null));
      if (!status?.stale) return false;
      await reloadTabAndWait(tabId);
      // A reload drops the injected scripts; the page needs them again to answer.
      await ensurePageScripts(/** @type {import("../types").PageTab} */ (await chrome.tabs.get(tabId)));
      const ready = await sendToTabWhenReady(tabId, { type: "WAIT_FOR_POST" });
      if (!ready?.ready) throw new Error(S.t("頁面重新整理後貼文還沒載入完成，請稍候再按一次保存"));
      return true;
    }

    function reloadTabAndWait(/** @type {number} */ tabId, timeoutMs = 20000) {
      return waitForTabComplete(tabId, () => chrome.tabs.reload(tabId), timeoutMs, S.t("頁面重新整理逾時，請稍後再按一次保存"));
    }

    function waitForTabComplete(/** @type {number} */ tabId, /** @type {any} */ start, timeoutMs = 20000, timeoutMessage = "") {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(timeoutMessage || S.t("頁面載入逾時")));
        }, timeoutMs);
        function listener(/** @type {any} */ updatedTabId, /** @type {any} */ changeInfo) {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(undefined);
        }
        chrome.tabs.onUpdated.addListener(listener);
        Promise.resolve().then(start).catch(error => {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          reject(error);
        });
      });
    }

    // The content script needs a moment after a reload before it can answer.
    async function sendToTabWhenReady(/** @type {number} */ tabId, /** @type {any} */ message, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          return await sendToTab(tabId, message);
        } catch (error) {
          lastError = error;
          await S.sleep(300);
        }
      }
      throw lastError ?? new Error(S.t("頁面沒有回應，請重新整理後再試"));
    }

    function assertOwnContentScript(/** @type {chrome.runtime.MessageSender} */ sender) {
      if (sender?.id !== chrome.runtime.id || !sender?.tab?.id) throw new Error(S.t("不支援的操作"));
    }

    return {
      activeThreadsTab,
      assertOwnContentScript,
      ensureFreshThreadPage,
      ensurePageScripts,
      fetchImageInTab,
      scriptsFor,
      sendToTab,
      sendToTabWhenReady
    };
  }

  return { createTabs };
});
