/**
 * Content script that runs inside a Plurk Paste tab the extension opened, and returns its text.
 */
(function initializeSavourPlurkPaste() {
  "use strict";

  const S = globalThis.SavourShared;
  if (!S) return;

  // Answers only when the extension opened this Paste to read a plurk's long text.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "READ_PLURK_PASTE") return false;
    sendResponse({ ok: true, result: S.extractPlurkPasteFromDocument(document) });
    return false;
  });
})();
