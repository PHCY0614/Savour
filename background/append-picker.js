/**
 * Adding a selection to an existing Notion page: the picker sessions (kept in session storage so a website cannot read or click them), the popup or window that shows the picker, and the search and save steps it calls.
 *
 * Created once by background.js with `createAppendPicker(deps)`; `deps` carries the shared services
 * (storage, the Notion request function, the queue) so this file has no globals of its own.
 */
(function attachSavourBackgroundAppendPicker(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourBackgroundAppendPicker = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundAppendPickerModule() {
  "use strict";

  /**
   * @param {Pick<import("../types").Services, "I" | "N" | "S" | "ensureArchiveSchema" | "enqueueCaptures" | "enqueueSelectionAppend" | "notionRequest" | "readConfig" | "readState" | "requireToken" | "sendToTab">} deps services from background.js
   */
  function createAppendPicker(deps) {
    const { I, N, S, ensureArchiveSchema, enqueueCaptures, enqueueSelectionAppend, notionRequest, readConfig, readState, requireToken, sendToTab } = deps;

    // The Notion page of the post open in the tab, when this post is already saved.
    async function currentPostAppendTarget(/** @type {string} */ sourceUrl) {
      const state = await readState();
      const local = S.localPostCaptureStatus(state, sourceUrl ?? "");
      const pageId = S.extractNotionId(local.record?.notionPageId);
      if (local.status !== "saved" || !pageId) return null;
      return { pageId, title: S.cleanText(local.record?.title) || S.t("這篇的頁面") };
    }

    // ---- Choosing the page a selection is added to ----
    // The picker is an extension window (pages/picker/picker.html), not part of the website, so the site can neither
    // read the archive's page titles nor click in it. Each picker has a session in storage.session
    // (which content scripts cannot read) holding the selection and the pages offered; only those pages
    // can be chosen.
    const PICKER_SESSIONS_KEY = "pickerSessions";

    const PICKER_SESSION_MS = 15 * 60 * 1000;

    const PICKER_PAGE = "pages/picker/picker.html";

    function assertPickerPage(/** @type {chrome.runtime.MessageSender} */ sender) {
      const pickerUrl = chrome.runtime.getURL(PICKER_PAGE);
      if (sender?.id !== chrome.runtime.id || !String(sender?.url ?? "").startsWith(pickerUrl)) {
        throw new Error(S.t("不支援的操作"));
      }
    }

    async function readPickerSessions() {
      const stored = (await chrome.storage.session.get(PICKER_SESSIONS_KEY))[PICKER_SESSIONS_KEY] ?? {};
      const now = Date.now();
      return Object.fromEntries(Object.entries(stored).filter(([, session]) => now - (session?.createdAt ?? 0) < PICKER_SESSION_MS));
    }

    async function writePickerSessions(/** @type {any} */ sessions) {
      await chrome.storage.session.set({ [PICKER_SESSIONS_KEY]: sessions });
    }

    async function pickerSession(/** @type {string} */ token) {
      const session = (await readPickerSessions())[String(token ?? "")];
      if (!session) throw new Error(S.t("這個選單已經失效，請重新選取文字"));
      return session;
    }

    async function pickerSessionView(/** @type {string} */ token) {
      const session = await pickerSession(token);
      return {
        previewText: S.cleanText(session.capture?.text).replace(/\s+/g, " ").slice(0, 80),
        choices: session.choices
      };
    }

    // Search results become choosable for this picker only.
    async function searchFromPicker(/** @type {string} */ token, /** @type {string} */ query) {
      await pickerSession(token);
      const result = await searchAppendTargets(query);
      const sessions = await readPickerSessions();
      const session = sessions[token];
      if (session) {
        const offered = new Map((session.offered ?? []).map((/** @type {any} */ item) => [item.pageId, item]));
        for (const item of result.results) offered.set(item.pageId, item);
        session.offered = [...offered.values()].slice(-200);
        await writePickerSessions(sessions);
      }
      return result;
    }

    async function chooseFromPicker(/** @type {string} */ token, /** @type {any} */ target) {
      const session = await pickerSession(token);
      let saved;
      if (target?.kind === "page") {
        const pageId = S.extractNotionId(target.pageId);
        const offered = (session.offered ?? []).find((/** @type {any} */ item) => item.pageId === pageId);
        if (!pageId || !offered) throw new Error(S.t("請從清單中選擇頁面"));
        saved = await saveSelectionToTarget(session.capture, { kind: "page", pageId, title: offered.title });
      } else {
        saved = await saveSelectionToTarget(session.capture, { kind: "new" });
      }
      const sessions = await readPickerSessions();
      delete sessions[token];
      await writePickerSessions(sessions);
      // The page only hears that the selection was queued, never which Notion page it went to.
      if (session.tabId) {
        const pageMessage = target?.kind === "page" ? selectionAppendMessage(saved, { withTitle: false }) : saved.message;
        await sendToTab(session.tabId, { type: "SHOW_TOAST", message: pageMessage }).catch(() => {});
      }
      return { message: saved.message };
    }

    // Captures the selection first (focusing the picker clears it) and returns the token of a picker session.
    async function createPickerSession(/** @type {import("../types").PageTab} */ tab, selectionText = "") {
      const capture = await sendToTab(tab.id, { type: "CAPTURE_SELECTION", selectionText });
      const state = await readState();
      const current = await currentPostAppendTarget(tab.url);
      const seen = new Set(current ? [current.pageId] : []);
      const recent = /** @type {any[]} */ ([]);
      const addRecent = (/** @type {any} */ item) => {
        const pageId = S.extractNotionId(item?.pageId);
        if (!pageId || seen.has(pageId) || recent.length >= 8) return;
        seen.add(pageId);
        recent.push({ pageId, title: S.cleanText(item?.title) || "未命名貼文" });
      };
      for (const target of state.appendTargets ?? []) addRecent(target);
      Object.values(state.saved ?? {})
        .sort((left, right) => (Date.parse(right?.savedAt) || 0) - (Date.parse(left?.savedAt) || 0))
        .forEach(record => addRecent({ pageId: record?.notionPageId, title: record?.title }));
      const lastTarget = S.extractNotionId(state.appendTargets?.[0]?.pageId);
      const choices = { current, recent, preselect: current?.pageId || (lastTarget && seen.has(lastTarget) ? lastTarget : "new") };
      const token = crypto.randomUUID();
      const sessions = await readPickerSessions();
      sessions[token] = {
        capture,
        choices,
        offered: [...(current ? [current] : []), ...recent],
        tabId: tab.id,
        createdAt: Date.now()
      };
      await writePickerSessions(sessions);
      return token;
    }

    // Then lets the user pick a page, in the toolbar popup or a small window.
    async function openAppendPicker(/** @type {import("../types").PageTab} */ tab, selectionText = "") {
      await showPicker(tab, await createPickerSession(tab, selectionText));
    }

    // The picker opens in the toolbar popup (pages/popup/popup.js switches to it when a picker is waiting for that
    // tab). Browsers without action.openPopup get a separate small window instead; some of them show
    // such windows as tabs.
    const PENDING_PICKER_KEY = "pendingPicker";

    const PENDING_PICKER_MS = 15000;

    async function showPicker(/** @type {chrome.tabs.Tab} */ tab, /** @type {string} */ token) {
      if (typeof chrome.action?.openPopup === "function") {
        await chrome.storage.session.set({ [PENDING_PICKER_KEY]: { token, tabId: tab.id, at: Date.now() } });
        try {
          await chrome.action.openPopup({ windowId: tab.windowId });
          return;
        } catch {
          await chrome.storage.session.remove(PENDING_PICKER_KEY);
        }
      }
      await chrome.windows.create({
        url: chrome.runtime.getURL(`${PICKER_PAGE}#${token}`),
        type: "popup",
        focused: true,
        ...(await pickerWindowBounds(tab.windowId))
      });
    }

    function assertPopupPage(/** @type {chrome.runtime.MessageSender} */ sender) {
      if (sender?.id !== chrome.runtime.id || !String(sender?.url ?? "").startsWith(chrome.runtime.getURL("pages/popup/popup.html"))) {
        throw new Error(S.t("不支援的操作"));
      }
    }

    // Hands a waiting picker to the popup that just opened, once, and only for the tab it belongs to.
    async function takePendingPicker() {
      /** @type {any} */
      const pending = (await chrome.storage.session.get(PENDING_PICKER_KEY))[PENDING_PICKER_KEY];
      await chrome.storage.session.remove(PENDING_PICKER_KEY);
      if (!pending?.token || Date.now() - (pending.at ?? 0) > PENDING_PICKER_MS) return { token: "" };
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return { token: tab?.id === pending.tabId ? pending.token : "" };
    }

    // A small window centred near the top of the browser window the user is in.
    async function pickerWindowBounds(/** @type {number} */ windowId) {
      const width = 440;
      const height = 520;
      try {
        const parent = await chrome.windows.get(windowId);
        return {
          width,
          height,
          left: Math.max(0, Math.round((parent.left ?? 0) + ((parent.width ?? width) - width) / 2)),
          top: Math.max(0, Math.round((parent.top ?? 0) + 80))
        };
      } catch {
        return { width, height };
      }
    }

    // withTitle: false for messages shown on the website, which must not learn archive page titles.
    function selectionAppendMessage(/** @type {any} */ result, { withTitle = true } = {}) {
      const title = withTitle && result.target?.title ? `「${I.displayTitle(result.target.title)}」` : S.t("這篇的 Notion 頁面");
      if (result.alreadyOnPage) return S.t("這段已經加到{title}了", { title });
      if (!result.added) return S.t("這段已經在等待保存");
      return S.t("已加入佇列，會接在{title}最後面", { title });
    }

    async function saveSelectionToTarget(/** @type {import("../types").Capture} */ capture, /** @type {any} */ target) {
      if (capture?.captureType !== "selection") throw new Error(S.t("請先選取想保存的文字"));
      if (target?.kind === "page") {
        const result = await enqueueSelectionAppend(capture, target);
        return { ...result, message: selectionAppendMessage(result) };
      }
      const result = await enqueueCaptures([capture], { verifyExisting: true });
      return { ...result, message: result.added ? S.t("已加入 Notion 保存佇列") : S.t("這段已經在保存紀錄中") };
    }

    // Searches only the configured archive, by page title.
    async function searchAppendTargets(/** @type {string} */ query) {
      const config = await readConfig();
      const token = await requireToken();
      if (!config.dataSourceId) throw new Error(S.t("尚未建立整理庫或填入既有 Notion 資料庫網址"));
      // The search names the archive's columns, so its column map must be in use.
      await ensureArchiveSchema(config.dataSourceId, token);
      const response = await notionRequest(`/v1/data_sources/${config.dataSourceId}/query`, {
        method: "POST",
        body: N.archivePageSearchPayload(query),
        token,
        retrySafe: true
      });
      return { results: (response.results ?? []).map(N.archivePageSummary).filter(Boolean) };
    }

    return {
      assertPickerPage,
      assertPopupPage,
      chooseFromPicker,
      currentPostAppendTarget,
      createPickerSession,
      openAppendPicker,
      pickerSessionView,
      searchFromPicker,
      selectionAppendMessage,
      takePendingPicker
    };
  }

  return { createAppendPicker };
});
