/**
 * Reads the full text of a Plurk Paste: first without the user's cookies, and for a Paste that needs login by opening it in a background tab with the user's own session.
 *
 * Created once by background.js with `createPlurkPaste(deps)`; `deps` carries the shared services
 * (storage, the Notion request function, the queue) so this file has no globals of its own.
 */
(function attachSavourBackgroundPlurkPaste(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourBackgroundPlurkPaste = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundPlurkPasteModule() {
  "use strict";

  /**
   * @param {Pick<import("../types").Services, "S" | "sendToTabWhenReady">} deps services from background.js
   */
  function createPlurkPaste(deps) {
    const { S, sendToTabWhenReady } = deps;

    // Reads a public Plurk Paste without the user's cookies. Only paste.plurk.com/show/<id> is allowed.
    async function fetchPlurkPaste(/** @type {string} */ url) {
      if (!S.isPlurkPasteUrl(url)) throw new Error(S.t("不是 Plurk Paste 網址"));
      const response = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", redirect: "follow" });
      if (!response.ok || !S.isPlurkPasteUrl(response.url || url)) return { html: "" };
      const html = await response.text();
      return { html: html.length <= 5 * 1024 * 1024 ? html : "" };
    }

    // Fallback for a Paste that needs login: open it in a background tab with the user's own session,
    // read the text the user could see, then close the tab.
    async function readPlurkPasteInTab(/** @type {string} */ url) {
      if (!S.isPlurkPasteUrl(url)) throw new Error(S.t("不是 Plurk Paste 網址"));
      let tabId = 0;
      try {
        tabId = (await chrome.tabs.create({ url, active: false })).id ?? 0;
        // The Paste page script only answers once the page has loaded.
        return await sendToTabWhenReady(tabId, { type: "READ_PLURK_PASTE" }, 20000);
      } finally {
        if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
      }
    }

    return {
      fetchPlurkPaste,
      readPlurkPasteInTab
    };
  }

  return { createPlurkPaste };
});
