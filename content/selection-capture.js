/**
 * Saving a text selection: reads what the user selected on the page and builds the raw capture for it.
 *
 * Shared by every content script (web-content, instagram-content, plurk-capture, page-capture), which
 * only add what differs per site: the platform, the source URL, the author and the date.
 * It does not decide which post a selection belongs to, and it does not normalize the capture; the
 * worker does that (model/capture-model.js).
 */
(function initializeSavourSelectionCapture(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("../lib/shared.js")
    : root.SavourShared;
  const api = factory(shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourSelectionCapture = api;
})(globalThis, function createSavourSelectionCapture(/** @type {typeof import("../lib/shared.js")} */ S) {
  "use strict";

  /**
   * Links inside the selected range. With `wrappingLink`, a selection that sits entirely inside one
   * link also brings that link along, with the selected words as its text.
   * @param {Selection | null} selection
   * @param {boolean} wrappingLink
   */
  function selectionLinks(selection, wrappingLink) {
    if (!selection?.rangeCount) return [];
    const range = selection.getRangeAt(0);
    const links = [...range.cloneContents().querySelectorAll("a[href]")]
      .map(anchor => ({ text: anchor.textContent, url: anchor.href }));
    if (wrappingLink) {
      const ancestor = range.commonAncestorContainer;
      const wrapping = (ancestor instanceof Element ? ancestor : ancestor?.parentElement)?.closest("a[href]");
      if (wrapping) links.push({ text: selection.toString(), url: wrapping.href });
    }
    return S.normalizeLinks(links);
  }

  /**
   * The raw capture for the current selection. Throws when nothing is selected.
   * @param {string} selectionText the context menu's copy of the selection, used when the page has none
   * @param {{ platform?: string, sourceUrl: string, author?: string, publishedAt?: string }} fields what the
   *   site knows about where the selection came from; `platform` is left out when the site does not set one
   * @param {{ wrappingLink?: boolean }} [options] see selectionLinks
   */
  function buildSelectionCapture(selectionText, fields, { wrappingLink = false } = {}) {
    const selection = window.getSelection();
    // The page's own selection keeps line breaks; the context menu's selectionText flattens them.
    const text = S.cleanText(selection?.toString() || selectionText || "");
    if (!text) throw new Error(S.t("請先選取想保存的文字"));
    return {
      author: "",
      publishedAt: "",
      ...fields,
      captureType: "selection",
      text,
      links: selectionLinks(selection, wrappingLink),
      continuations: /** @type {any[]} */ ([]),
      titleHint: document.title
    };
  }

  return { buildSelectionCapture };
});
