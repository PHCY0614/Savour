/**
 * Capture keys: the stable string that says "this is the same post/article" so a page is saved once.
 * Different sites build the key from different ids; selections are keyed by page and text hash.
 */
(function attachSavourDedupeKey(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("../lib/shared.js")
    : root.SavourShared;
  const api = factory(shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourDedupeKey = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDedupeKey(/** @type {typeof import("../lib/shared.js")} */ S) {
  "use strict";

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  function isSelectionKey(value) {
    return String(value ?? "").startsWith("selection:");
  }

  /**
   * The key a capture is saved under. Selections use page + text hash; posts use the site's own id.
   * @param {import("../types").Capture} capture
   * @returns {string}
   */
  function captureKey(capture) {
    const sourceUrl = S.normalizeThreadsUrl(capture?.sourceUrl ?? capture?.canonicalUrl ?? "");
    const captureType = capture?.captureType === "selection" ? "selection" : "post";
    if (captureType === "selection") {
      return `selection:${sourceUrl}:${S.hashString(S.cleanText(capture?.text))}`;
    }

    const parsed = S.parseThreadsUrl(sourceUrl);
    if (parsed.platform === "plurk" && parsed.postId) return `plurk:${parsed.postId}`;
    if (parsed.platform === "x" && parsed.postId) return `x:${parsed.postId}`;
    if (parsed.platform === "instagram" && parsed.postId) return `ig:${parsed.postId}`;
    if (parsed.platform === "web") return S.webPageKey(sourceUrl);
    const shortcode = S.cleanText(capture?.shortcode || S.parseThreadsUrl(sourceUrl).postId);
    if (shortcode) return `tsc:${shortcode}`;
    if (sourceUrl) return `post:${sourceUrl}`;
    return `post:${S.hashString(`${capture?.author ?? ""}|${capture?.publishedAt ?? ""}|${capture?.text ?? ""}`)}`;
  }

  return {
    captureKey,
    isSelectionKey
  };
});
