/**
 * LinkedIn capture: reads one post page (/feed/update/... or /posts/...) - text, images, link cards and, for a
 * repost, a link to the original - from the rendered DOM, and saves it as a web article.
 *
 * LinkedIn's class names are generated and change often, so posts are found by what stays put: the
 * data-testid of the post text, the author's /in/ or /company/ link and the post's own /feed/update/ address.
 *
 * It does not save comments, reactions, videos, or the reposted post's full text and images.
 * Created by content/web-content.js on linkedin.com post pages.
 */
(function initializeSavourLinkedInCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourLinkedInCapture = api;
})(globalThis, function createSavourLinkedInCaptureModule() {
  "use strict";

  const CAPTURE_VALIDATION_VERSION = 2;
  const POST_ITEM = "[role='listitem'][componentkey^='update-c']";
  const TEXT_BOX = "[data-testid='expandable-text-box']";
  const MORE_BUTTON = "[data-testid='expandable-text-button']";
  const AUTHOR_LINK = "a[href*='/in/'], a[href*='/company/'], a[href*='/school/']";
  const MAX_IMAGES = 40;
  const MAX_CARDS = 3;
  const EXCERPT_LENGTH = 140;

  /**
   * Creates the LinkedIn reader for the current page.
   * @param {any} options `shared`: lib/shared.js
   * @returns captureStatus, which throws when the page is not a post page, the post is not on screen,
   *   or nothing could be read from it
   */
  function createLinkedInCapture(/** @type {any} */ options) {
    const S = options.shared;

    const absolute = (/** @type {string} */ href) => S.resolveUrl(href, location.href);

    // LinkedIn sends outside links through /safety/go/?url=<target>; this is the target.
    function linkTarget(/** @type {Element} */ anchor) {
      const url = absolute(anchor.getAttribute("href") ?? "");
      if (!url) return "";
      if (url.pathname.startsWith("/safety/go")) return S.webLinkUrl(url.searchParams.get("url") ?? "");
      return S.isLinkedInUrl(url.href) ? "" : S.webLinkUrl(url.href);
    }

    // Profile and company pages of mentions keep their link; hashtags and everything else on LinkedIn do not.
    function spanLink(/** @type {Element} */ anchor) {
      const outside = linkTarget(anchor);
      if (outside) return outside;
      const url = absolute(anchor.getAttribute("href") ?? "");
      return url && /^\/(?:in|company|school)\//.test(url.pathname) ? `${url.origin}${url.pathname}` : "";
    }

    function profilePath(/** @type {Element} */ anchor) {
      return (absolute(anchor.getAttribute("href") ?? "")?.pathname ?? "").replace(/\/+$/, "");
    }

    function nameOf(/** @type {Element} */ anchor) {
      return S.cleanText(String(anchor.textContent ?? "").split(/[•·]/)[0]).replace(/\s+/g, " ").slice(0, 200);
    }

    // The text of a post's text box as spans, with links, line breaks and without the "… more" button.
    function boxSpans(/** @type {Element} */ box) {
      const spans = /** @type {any[]} */ ([]);
      const push = (/** @type {string} */ text, /** @type {string} */ href = "") => {
        if (text) spans.push(href ? { text, href } : { text });
      };
      const walk = (/** @type {Node} */ node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            push(String(child.nodeValue ?? "").replace(/\s*\n\s*/g, " "));
          } else if (child.nodeType === 1) {
            const element = /** @type {Element} */ (child);
            if (element.matches(`button, ${MORE_BUTTON}`)) continue;
            if (element.tagName === "BR") push("\n");
            else if (element.tagName === "A") push(String(element.textContent ?? ""), spanLink(element));
            else walk(element);
          }
        }
      };
      walk(box);
      return spans;
    }

    function plainText(/** @type {any[]} */ spans) {
      return S.cleanText(spans.map(span => span.text).join(""));
    }

    function postIds(/** @type {Element} */ scope) {
      const ids = new Set();
      for (const anchor of scope.querySelectorAll("a[href*='/feed/update/']")) {
        const id = S.linkedInPostInfo(absolute(anchor.getAttribute("href") ?? "")?.href).id;
        if (id) ids.add(id);
      }
      return ids;
    }

    // The first post card on a post page; the comments below it are outside of it.
    function findItem() {
      return document.querySelector(POST_ITEM);
    }

    // Photos and carousel pages of the post itself, not avatars, logos, reaction icons or the link card picture.
    function postImages(/** @type {Element} */ item, /** @type {Element | null} */ quoteRoot) {
      const seen = new Set();
      const media = [];
      for (const image of item.querySelectorAll("img")) {
        if (quoteRoot?.contains(image)) continue;
        const url = absolute(image.getAttribute("src") ?? "");
        if (!url || !/^https?:$/.test(url.protocol) || !url.pathname.includes("/dms/image/")) continue;
        if (/profile-|logo|articleshare/i.test(url.pathname) || seen.has(url.pathname)) continue;
        const size = image.naturalWidth || Number(image.getAttribute("width")) || 0;
        if (size && size < 150) continue;
        seen.add(url.pathname);
        const alt = S.cleanText(image.getAttribute("alt") ?? "");
        media.push({ type: "image", url: url.href, caption: /^view image$/i.test(alt) ? "" : alt.slice(0, 200) });
        if (media.length >= MAX_IMAGES) break;
      }
      return media;
    }

    function captureStatus() {
      const urlPost = S.linkedInPostInfo(location.href);
      if (!urlPost.id) throw new Error(S.t("請先點開一則 LinkedIn 貼文（點貼文的發布時間），再保存"));
      const item = findItem();
      if (!item) throw new Error(S.t("找不到這則 LinkedIn 貼文，請等頁面載入完成後再試一次"));

      const facepile = item.querySelector("[data-testid^='ReactionFacepileCollection-urn:li:']")
        ?? document.querySelector("[data-testid^='ReactionFacepileCollection-urn:li:']");
      const pageId = String(facepile?.getAttribute("data-testid") ?? "").match(/urn:li:(activity|share|ugcPost):(\d+)/);
      const ids = postIds(item);
      if (pageId) ids.add(pageId[2]);
      if (!ids.has(urlPost.id)) throw new Error(S.t("找不到這則 LinkedIn 貼文，請等頁面載入完成後再試一次"));
      const own = pageId ? { type: pageId[1], id: pageId[2] } : urlPost;
      const sourceUrl = `https://www.linkedin.com/feed/update/urn:li:${own.type}:${own.id}/`;

      const boxes = [...item.querySelectorAll(TEXT_BOX)];
      const authorLinks = [...item.querySelectorAll(AUTHOR_LINK)]
        .filter(anchor => nameOf(anchor) && !anchor.closest(TEXT_BOX));
      const mainAuthor = authorLinks[0];
      if (!mainAuthor) throw new Error(S.t("沒有讀到這則 LinkedIn 貼文的內容，本次已取消"));
      const authorOf = (/** @type {Element} */ node) => authorLinks
        .filter(anchor => Boolean(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
        .at(-1) ?? mainAuthor;
      const mainPath = profilePath(mainAuthor);
      const mainBoxes = boxes.filter(box => profilePath(authorOf(box)) === mainPath);
      const quoteBox = boxes.find(box => profilePath(authorOf(box)) !== mainPath);

      // The reposted post is drawn inside the reposter's card: everything from its text box up to,
      // but not including, the card's own header.
      let quoteRoot = /** @type {Element | null} */ (null);
      if (quoteBox) {
        quoteRoot = quoteBox;
        while (quoteRoot.parentElement && !quoteRoot.parentElement.contains(mainAuthor)) quoteRoot = quoteRoot.parentElement;
      }

      const blocks = /** @type {any[]} */ ([]);
      for (const box of mainBoxes) {
        for (const spans of S.splitParagraphs(boxSpans(box))) blocks.push({ type: "paragraph", spans });
      }
      blocks.push(...postImages(item, quoteRoot));

      // Link preview card of the post: an outside link that is neither in the text nor in the reposted post.
      const linked = new Set(blocks.flatMap(block => (block.spans ?? []).map((/** @type {any} */ span) => span.href)).filter(Boolean));
      const cards = [];
      for (const anchor of item.querySelectorAll("a[href]")) {
        if (anchor.closest(TEXT_BOX) || quoteRoot?.contains(anchor)) continue;
        const target = linkTarget(anchor);
        if (!target || linked.has(target)) continue;
        linked.add(target);
        cards.push({ type: "bookmark", url: target });
        if (cards.length >= MAX_CARDS) break;
      }
      blocks.push(...cards);

      let quoteName = "";
      if (quoteBox && quoteRoot) {
        const quoteAuthor = authorOf(quoteBox);
        quoteName = nameOf(quoteAuthor);
        const text = plainText(boxSpans(quoteBox)).replace(/\s+/g, " ");
        const excerpt = text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
        blocks.push({
          type: "quote",
          spans: [{ text: `${S.t("轉貼自")} ${quoteName}`, bold: true }, ...(excerpt ? [{ text: `\n${excerpt}` }] : [])]
        });
        // The reposted post's own address: the first post link inside its card that is not this post's.
        const ownIds = new Set([urlPost.id, own.id]);
        const permalink = [...quoteRoot.querySelectorAll("a[href*='/feed/update/']")]
          .map(anchor => absolute(anchor.getAttribute("href") ?? ""))
          .find(url => url && S.linkedInPostInfo(url.href).id && !ownIds.has(S.linkedInPostInfo(url.href).id));
        if (permalink) blocks.push({ type: "bookmark", url: S.normalizeThreadsUrl(permalink.href) });
      }

      const mainText = plainText(mainBoxes.flatMap(boxSpans));
      if (!blocks.length) throw new Error(S.t("沒有讀到這則 LinkedIn 貼文的內容，本次已取消"));

      const notes = [];
      if (mainBoxes.some(box => box.querySelector(MORE_BUTTON))) notes.push(S.t("貼文有「…更多」沒有展開，保存的文字可能不完整；可以點開那則貼文的單頁後再保存。"));
      if ([...item.querySelectorAll("video")].some(video => !quoteRoot?.contains(video))) notes.push(S.t("影片不會保存，只保存文字與圖片。"));
      const author = nameOf(mainAuthor);
      const title = (mainText.split("\n")[0] || (quoteName ? `${S.t("轉貼：")}${quoteName}` : author)).replace(/\s+/g, " ").slice(0, 60);
      return {
        platform: "web",
        captureType: "post",
        sourceUrl,
        title,
        siteName: "LinkedIn",
        author,
        publishedAt: S.linkedInPostTime(own.id),
        excerpt: mainText.replace(/\s+/g, " ").slice(0, 300),
        text: "",
        articleBlocks: blocks,
        captureValidation: { version: CAPTURE_VALIDATION_VERSION, source: "web-page", postId: "", validated: true },
        continuations: /** @type {any[]} */ ([]),
        authorReplies: /** @type {any[]} */ ([]),
        ...(notes.length ? { reviewFlags: mainBoxes.some(box => box.querySelector(MORE_BUTTON)) ? ["正文疑似遺漏"] : [], captureNotes: notes } : {})
      };
    }

    return { captureStatus };
  }

  return { createLinkedInCapture };
});
