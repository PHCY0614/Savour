/**
 * Instagram capture: finds the main post in the data the page embeds (not the "more posts" ones)
 * and returns its caption, author, date and media.
 */
(function initializeSavourInstagramCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourInstagramCapture = api;
})(globalThis, function createSavourInstagramCaptureModule() {
  "use strict";

  const CAPTURE_VALIDATION_VERSION = 2;
  const MAX_SEARCH_DEPTH = 80;
  // Where the page keeps the post it is about (logged out / logged in / older pages). The same page
  // also holds other posts ("more posts from"), which can share fields but not these keys.
  const MAIN_POST_KEY = /^(?:xig_polaris_media|xdt_api__v1__media__shortcode__web_info|shortcode_media|xdt_shortcode_media)$/;

  // Reads an Instagram post from the data the page itself was rendered from (JSON in
  // <script type="application/json">), found by the post's shortcode. The visible page only shows a
  // shortened caption and mixes in other posts' thumbnails, so it is not read.
  function createInstagramCapture(/** @type {any} */ options) {
    const S = options.shared;

    // After moving between posts inside Instagram, the page holds a partial copy of the new post
    // (no photos, no time); only a complete one is used, otherwise the page is reloaded first.
    function isPostItem(/** @type {any} */ value, /** @type {any} */ code) {
      return value.code === code
        && typeof value.user?.username === "string"
        && Number(value.taken_at) > 0
        && postMedia(value).length > 0;
    }

    /**
     * Finds the post with this shortcode in the JSON the page embeds, or null.
     * @param {string} code the shortcode from /p/<code>/ or /reel/<code>/
     * @param {Document} [doc]
     */
    function findPost(code, doc = document) {
      if (!code) return null;
      for (const script of doc.querySelectorAll("script[type='application/json']")) {
        const text = script.textContent ?? "";
        if (!text.includes(`"${code}"`)) continue;
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          continue;
        }
        const stack = [[data, 0, false]];
        while (stack.length) {
          const [value, depth, underMainPost] = /** @type {[any, number, boolean]} */ (stack.pop());
          if (!value || typeof value !== "object" || depth > MAX_SEARCH_DEPTH) continue;
          if (underMainPost && !Array.isArray(value) && isPostItem(value, code)) return value;
          for (const [key, child] of Object.entries(value)) {
            if (child && typeof child === "object") stack.push([child, depth + 1, underMainPost || MAIN_POST_KEY.test(key)]);
          }
        }
      }
      return null;
    }

    function largestImage(/** @type {any} */ versions) {
      const candidates = (versions?.candidates ?? []).filter((/** @type {any} */ item) => /^https:\/\//i.test(item?.url ?? ""));
      candidates.sort((/** @type {any} */ left, /** @type {any} */ right) => (Number(right.width) || 0) - (Number(left.width) || 0));
      return candidates[0]?.url ?? "";
    }

    function isVideo(/** @type {any} */ item) {
      return Number(item?.media_type) === 2 || Boolean(item?.video_versions?.length);
    }

    // Every photo of a carousel in order; a video contributes its cover picture.
    function postMedia(/** @type {any} */ item) {
      const parts = Array.isArray(item.carousel_media) && item.carousel_media.length ? item.carousel_media : [item];
      return parts
        .map((/** @type {any} */ part) => largestImage(part.image_versions2))
        .filter(Boolean)
        .map((/** @type {string} */ url) => ({ type: "image", url }));
    }

    function baseCapture(/** @type {any} */ code) {
      return {
        platform: "instagram",
        captureType: "post",
        sourceUrl: S.normalizeThreadsUrl(location.href),
        links: /** @type {any[]} */ ([]),
        threadPosition: "",
        topicTag: "",
        quotedPosts: /** @type {any[]} */ ([]),
        continuations: /** @type {any[]} */ ([]),
        authorReplies: /** @type {any[]} */ ([]),
        titleHint: document.title,
        captureValidation: { version: CAPTURE_VALIDATION_VERSION, source: "instagram-page", postId: code, validated: true }
      };
    }

    function meta(/** @type {any} */ name) {
      return document.querySelector(`meta[property='${name}'], meta[name='${name}']`)?.getAttribute("content") ?? "";
    }

    // When the page data has no post (Instagram changed its format), the page's own summary still
    // has the caption, between the first ': "' and the last '"', and the first photo.
    function fromSummary(/** @type {any} */ code) {
      if (S.instagramPostCode(meta("og:url")) !== code) return null;
      const description = meta("og:description");
      const start = description.indexOf(': "');
      const end = description.lastIndexOf('"');
      const text = start !== -1 && end > start + 3 ? S.cleanText(description.slice(start + 3, end)) : "";
      const image = /^https:\/\//i.test(meta("og:image")) ? meta("og:image") : "";
      if (!text && !image) return null;
      return {
        ...baseCapture(code),
        text,
        media: image ? [{ type: "image", url: image }] : [],
        author: "",
        publishedAt: "",
        reviewFlags: ["正文疑似遺漏"],
        captureNotes: [S.t("沒有讀到這則 Instagram 貼文的完整資料，只保存了說明文字與第一張圖片。")]
      };
    }

    /**
     * Captures the open Instagram post: caption, author, date and every picture or video in a carousel. Falls back
     * to the page's summary (caption and first image) and flags it when the full data is missing.
     */
    function captureCurrentPost() {
      const code = S.instagramPostCode(location.href);
      if (!code) throw new Error(S.t("請先點開這則 Instagram 貼文（網址是 instagram.com/p/… 或 /reel/…）再保存"));
      const item = findPost(code);
      if (!item) {
        const summary = fromSummary(code);
        if (summary) return summary;
        throw new Error(S.t("讀不到這則 Instagram 貼文的資料，請重新整理頁面後再試一次"));
      }
      const takenAt = Number(item.taken_at);
      const parts = Array.isArray(item.carousel_media) && item.carousel_media.length ? item.carousel_media : [item];
      const capture = {
        ...baseCapture(code),
        author: S.cleanHandle(item.user.username),
        publishedAt: takenAt > 0 ? new Date(takenAt * 1000).toISOString() : "",
        text: S.cleanText(item.caption?.text ?? ""),
        media: postMedia(item),
        reviewFlags: /** @type {any[]} */ ([])
      };
      if (parts.some(isVideo)) /** @type {any} */ (capture).captureNotes = [S.t("影片不會保存，只保存封面圖片與說明文字。")];
      if (!capture.text && !capture.media.length) throw new Error(S.t("沒有讀到這則 Instagram 貼文的說明文字或圖片，本次已取消"));
      return capture;
    }

    // Moving between posts inside Instagram keeps the data of the first page loaded; the
    // background then reloads the tab once, like pressing F5.
    // A freshly loaded page describes its own post in og:url even when its data cannot be read.
    function pageDataStatus() {
      const code = S.instagramPostCode(location.href);
      const stale = Boolean(code) && !findPost(code) && S.instagramPostCode(meta("og:url")) !== code;
      return { stale };
    }

    return { captureCurrentPost, findPost, pageDataStatus };
  }

  return { createInstagramCapture };
});
