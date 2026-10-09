/**
 * Capture keys: the stable string that says "this is the same post/article" so a page is saved once.
 * Different sites build the key from different ids; selections are keyed by page and text hash.
 * Also answers, from the local index, whether the post at a URL is already saved or queued.
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
   * @param {Partial<import("../types").Capture>} capture
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

  /**
   * Whether the post at this URL is already saved, waiting in the queue, or new, from the local index only.
   * Uses the same key the capture is saved under, so a match by key and a match by URL agree.
   * @param {any} state
   * @param {string} sourceUrl
   */
  function localPostCaptureStatus(state, sourceUrl) {
    const normalized = S.normalizeThreadsUrl(sourceUrl);
    const identity = S.postIdentity(normalized);
    const targetKey = captureKey({ captureType: "post", sourceUrl: normalized });
    const samePost = (/** @type {any} */ key, /** @type {any} */ candidateUrl, captureType = "") => {
      if (String(key ?? "").startsWith("selection:") || captureType === "selection") return false;
      if (key === targetKey) return true;
      if (identity) return S.postIdentity(candidateUrl) === identity;
      return Boolean(candidateUrl) && S.normalizeThreadsUrl(candidateUrl) === normalized;
    };

    const queued = (state?.queue ?? []).find((/** @type {any} */ item) => samePost(
      item?.capture?.dedupeKey,
      item?.capture?.sourceUrl,
      item?.capture?.captureType
    ));
    if (queued) {
      return {
        status: queued.status === "failed" ? "failed" : "pending",
        key: queued.capture?.dedupeKey || targetKey,
        queueId: queued.id || ""
      };
    }

    for (const [key, record] of Object.entries(state?.saved ?? {})) {
      if (!samePost(key, record?.sourceUrl)) continue;
      return { status: "saved", key, record };
    }
    return { status: "new", key: targetKey, record: null };
  }

  return {
    captureKey,
    isSelectionKey,
    localPostCaptureStatus
  };
});
