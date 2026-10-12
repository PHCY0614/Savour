/**
 * Content script for Instagram: answers capture messages using content/instagram-capture.js.
 */
(function initializeSavourInstagramContent() {
  "use strict";

  const S = globalThis.SavourShared;
  const T = globalThis.SavourToast;
  const SEL = globalThis.SavourSelectionCapture;
  const IC = globalThis.SavourInstagramCapture;
  if (!S || !T || !SEL || !IC) return;
  const capture = IC.createInstagramCapture({ shared: S });

  function captureSelection(/** @type {string} */ selectionText) {
    return SEL.buildSelectionCapture(selectionText, {
      platform: "instagram",
      sourceUrl: S.normalizeThreadsUrl(location.href)
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve()
      .then(() => handleMessage(message))
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  function handleMessage(/** @type {any} */ message) {
    // The background sends the interface language with every message.
    globalThis.SavourI18n?.setLanguage(message?.lang);
    switch (message?.type) {
      case "PING":
        return { ready: true };
      case "CAPTURE_CURRENT_THREAD":
        return capture.captureCurrentPost();
      case "CAPTURE_SELECTION":
        return captureSelection(message.selectionText);
      case "GET_PAGE_DATA_STATUS":
        return capture.pageDataStatus();
      case "WAIT_FOR_POST":
        return { ready: !capture.pageDataStatus().stale };
      case "SHOW_TOAST":
        T.showToast(message.message, message.tone);
        return { shown: true };
      default:
        throw new Error(S.t("頁面不支援這個擷取操作"));
    }
  }
})();
