/**
 * Content script for Plurk: answers capture messages and reads Plurk Paste text, first without the
 * user's login and then, if that fails, in a tab with their own session.
 */
(function initializeSavourPlurkContent() {
  "use strict";

  const S = globalThis.SavourShared;
  const T = globalThis.SavourToast;
  const PC = globalThis.SavourPlurkCapture;
  if (!S || !T || !PC) return;

  // Paste is read without the user's login first; only if that fails is it opened in a tab
  // with the user's own session, the same as the user clicking the link.
  async function readPaste(/** @type {string} */ url) {
    const fetched = await chrome.runtime.sendMessage({ type: "FETCH_PLURK_PASTE", url });
    if (fetched?.ok && fetched.result?.html) {
      const doc = new DOMParser().parseFromString(fetched.result.html, "text/html");
      const paste = S.extractPlurkPasteFromDocument(doc);
      if (paste.text) return paste;
    }
    const opened = await chrome.runtime.sendMessage({ type: "READ_PLURK_PASTE_IN_TAB", url });
    if (!opened?.ok) throw new Error(opened?.error || S.t("無法讀取 Plurk Paste"));
    return opened.result;
  }

  const capture = PC.createPlurkCapture({ shared: S, readPaste });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve(handleMessage(message))
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  async function handleMessage(/** @type {any} */ message) {
    // The background sends the interface language with every message.
    globalThis.SavourI18n?.setLanguage(message?.lang);
    switch (message?.type) {
      case "PING":
        return { ready: true };
      case "CAPTURE_CURRENT_THREAD":
        return capture.captureCurrentPlurk();
      case "CAPTURE_SELECTION":
        return capture.captureSelection(message.selectionText);
      case "GET_PAGE_DATA_STATUS":
        // Plurk renders a plurk's own page from its own data; nothing goes stale.
        return { stale: false };
      case "WAIT_FOR_POST":
        return { ready: Boolean(document.querySelector("#permanent-plurk")) };
      case "SHOW_TOAST":
        T.showToast(message.message, message.tone);
        return { shown: true };
      default:
        throw new Error(S.t("頁面不支援這個擷取操作"));
    }
  }
})();
