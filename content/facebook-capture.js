/**
 * Facebook capture: reads one post page (a page's, a person's or a group's post) - text, photos and link
 * cards - from the rendered DOM, and saves it as a web article whose photos the extension downloads.
 *
 * Facebook's class names are generated, so the post is found by what stays put: the data-ad-rendering-role
 * attributes (story_message, profile_name, like_button) and the comments' role="article".
 *
 * It does not save comments, reactions, videos, or a shared post's original.
 * Created by content/web-content.js on facebook.com post pages.
 */
(function initializeSavourFacebookCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourFacebookCapture = api;
})(globalThis, function createSavourFacebookCaptureModule() {
  "use strict";

  const CAPTURE_VALIDATION_VERSION = 2;
  const ROLE = (/** @type {string} */ name) => `[data-ad-rendering-role='${name}']`;
  const MIN_IMAGE_SIZE = 200;
  const MAX_IMAGES = 40;
  const MAX_CARDS = 3;
  const BLOCK_TAGS = new Set(["DIV", "P", "LI", "UL", "OL"]);
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  /**
   * The time Facebook writes into a post's time link ("2026年10月7日 星期三下午7:35",
   * "Wednesday, October 7, 2026 at 7:35 PM") as an ISO time. Facebook shows it in the browser's time
   * zone, so it is read in that zone too.
   * @returns {string} "" for a language or format it does not know
   */
  function parseFacebookTime(/** @type {string} */ label) {
    const text = String(label ?? "");
    let year;
    let month;
    let day;
    let rest;
    const chinese = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(.*)$/);
    const english = text.match(/([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})(.*)$/);
    if (chinese) {
      [year, month, day, rest] = [Number(chinese[1]), Number(chinese[2]) - 1, Number(chinese[3]), chinese[4]];
    } else if (english && MONTHS.some(name => name.startsWith(english[1].toLowerCase().slice(0, 3)))) {
      const index = MONTHS.findIndex(name => name.startsWith(english[1].toLowerCase().slice(0, 3)));
      [year, month, day, rest] = [Number(english[3]), index, Number(english[2]), english[4]];
    } else {
      return "";
    }
    const clock = rest.match(/(\d{1,2}):(\d{2})/);
    if (!clock) return "";
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (/下午|晚上|PM/i.test(rest) && hour < 12) hour += 12;
    if (/上午|凌晨|AM/i.test(rest) && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return "";
    const date = new Date(year, month, day, hour, minute);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  /**
   * Creates the Facebook reader for the current page.
   * @param {any} options `shared`: lib/shared.js
   * @returns captureStatus, which throws when the page is not a post page, the post is not on screen,
   *   or nothing could be read from it
   */
  function createFacebookCapture(/** @type {any} */ options) {
    const S = options.shared;

    const absolute = (/** @type {string} */ href) => S.resolveUrl(href, location.href);

    // Outside links go through l.facebook.com/l.php?u=<target>; this is the target, "" for a Facebook address.
    function linkTarget(/** @type {Element} */ anchor) {
      const url = absolute(anchor.getAttribute("href") ?? "");
      if (!url) return "";
      if (/^l\.facebook\.com$/i.test(url.hostname)) return S.webLinkUrl(url.searchParams.get("u") ?? "");
      return S.isFacebookUrl(url.href) ? "" : S.webLinkUrl(url.href);
    }

    const inComment = (/** @type {Element} */ node) => Boolean(node.closest("[role='article']"));

    // The text of a post as spans. Emoji are pictures whose alt text is the emoji itself.
    function messageSpans(/** @type {Element} */ message) {
      const spans = /** @type {any[]} */ ([]);
      const push = (/** @type {string} */ text, /** @type {string} */ href = "") => {
        if (text) spans.push(href ? { text, href } : { text });
      };
      const tail = () => spans.slice(-2).map(span => span.text).join("").slice(-2);
      const newline = () => {
        if (spans.length && !tail().endsWith("\n")) push("\n");
      };
      const paragraphBreak = () => {
        if (!spans.length || tail() === "\n\n") return;
        push(tail().endsWith("\n") ? "\n" : "\n\n");
      };
      const walk = (/** @type {Node} */ node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            push(String(child.nodeValue ?? "").replace(/\s*\n\s*/g, " "));
          } else if (child.nodeType === 1) {
            const element = /** @type {Element} */ (child);
            if (element.tagName === "IMG") push(element.getAttribute("alt") ?? "");
            else if (element.tagName === "BR") push("\n");
            else if (element.tagName === "A") push(String(element.textContent ?? ""), linkTarget(element));
            else {
              // A line is a div with dir; the lines of one paragraph sit together in a div without it.
              const block = BLOCK_TAGS.has(element.tagName);
              if (block) newline();
              walk(element);
              if (block) {
                if (element.hasAttribute("dir")) newline();
                else paragraphBreak();
              }
            }
          }
        }
      };
      walk(message);
      return spans;
    }

    const isHidden = (/** @type {Element} */ node) => typeof (/** @type {any} */ (node)).checkVisibility === "function"
      && !(/** @type {any} */ (node)).checkVisibility();

    // The post's card: the smallest block around a post text or reaction row that also holds the author.
    // Opened from a link, the post sits in a dialog over the feed (whose own posts stay in the page, some of
    // them hidden), so a visible post in the dialog goes first, then any other visible one. The comments
    // below the post are role="article" and are never read.
    function findRoot() {
      const candidates = [...document.querySelectorAll(`${ROLE("story_message")}, ${ROLE("like_button")}`)]
        .filter(node => !inComment(node) && !isHidden(node));
      const dialog = (/** @type {Element} */ node) => {
        const box = node.closest("[role='dialog']");
        return Boolean(box && !box.getAttribute("aria-label"));
      };
      candidates.sort((left, right) => Number(dialog(right)) - Number(dialog(left)));
      for (const candidate of candidates) {
        let node = /** @type {Element | null} */ (candidate);
        while (node && !(node.querySelector(ROLE("profile_name")) && node.querySelector(ROLE("like_button")))) node = node.parentElement;
        if (node) return node;
      }
      return null;
    }

    // A person's or page's post names its author in profile_name; in a group that is the group, and the
    // author is the member link next to it.
    function authorOf(/** @type {Element} */ postRoot) {
      const name = postRoot.querySelector(ROLE("profile_name"));
      const nameLink = name?.querySelector("a") ?? name?.closest("a") ?? null;
      const path = absolute(nameLink?.getAttribute("href") ?? "")?.pathname ?? "";
      if (/^\/groups\/[^/]+\/?$/.test(path)) {
        const member = [...postRoot.querySelectorAll("a[href*='/user/']")]
          .find(anchor => !inComment(anchor) && S.cleanText(anchor.textContent));
        if (member) return S.cleanText(member.textContent).replace(/\s+/g, " ").slice(0, 200);
      }
      return S.cleanText(nameLink?.textContent || name?.textContent || "").replace(/\s+/g, " ").slice(0, 200);
    }

    function postTime(/** @type {Element} */ postRoot) {
      for (const anchor of postRoot.querySelectorAll("a[aria-label]")) {
        if (inComment(anchor)) continue;
        const time = parseFacebookTime(anchor.getAttribute("aria-label") ?? "");
        if (time) return time;
      }
      return "";
    }

    // The post's photos, not emoji, avatars or comment pictures; a photo is shown at its display size.
    function postImages(/** @type {Element} */ postRoot, /** @type {Element | null} */ message) {
      const seen = new Set();
      const media = [];
      for (const image of postRoot.querySelectorAll("img")) {
        if (inComment(image) || message?.contains(image)) continue;
        const url = absolute(image.getAttribute("src") ?? "");
        if (!url || !/^https?:$/.test(url.protocol) || !/(?:fbcdn\.net|fbsbx\.com)$/i.test(url.hostname)) continue;
        if (url.pathname.includes("/emoji") || seen.has(url.pathname)) continue;
        if ((image.naturalWidth || image.width || 0) < MIN_IMAGE_SIZE) continue;
        seen.add(url.pathname);
        media.push({ type: "image", url: url.href, caption: "" });
        if (media.length >= MAX_IMAGES) break;
      }
      return media;
    }

    function captureStatus() {
      const urlPost = S.facebookPostInfo(location.href);
      if (!urlPost.token) throw new Error(S.t("請先點開一則 Facebook 貼文（點貼文的發布時間），再保存"));
      const postRoot = findRoot();
      if (!postRoot) throw new Error(S.t("找不到這則 Facebook 貼文，請等頁面載入完成後再試一次"));

      const message = [...postRoot.querySelectorAll(ROLE("story_message"))].find(node => !inComment(node)) ?? null;
      const blocks = /** @type {any[]} */ ([]);
      let text = "";
      if (message) {
        const spans = messageSpans(message);
        text = S.cleanText(spans.map(span => span.text).join(""));
        for (const paragraph of S.splitParagraphs(spans)) blocks.push({ type: "paragraph", spans: paragraph });
      }
      const images = postImages(postRoot, message);
      blocks.push(...images);

      const linked = new Set(blocks.flatMap(block => (block.spans ?? []).map((/** @type {any} */ span) => span.href)).filter(Boolean));
      let cards = 0;
      for (const anchor of postRoot.querySelectorAll("a[href]")) {
        if (inComment(anchor) || message?.contains(anchor)) continue;
        const target = linkTarget(anchor);
        if (!target || linked.has(target)) continue;
        linked.add(target);
        blocks.push({ type: "bookmark", url: target });
        cards += 1;
        if (cards >= MAX_CARDS) break;
      }
      if (!blocks.length) throw new Error(S.t("沒有讀到這則 Facebook 貼文的內容，本次已取消"));

      const author = authorOf(postRoot);
      const hasVideo = [...postRoot.querySelectorAll("video")].some(video => !inComment(video));
      return {
        platform: "web",
        captureType: "post",
        sourceUrl: S.normalizeThreadsUrl(location.href),
        title: (text.split("\n")[0] || author || "Facebook").replace(/\s+/g, " ").slice(0, 60),
        siteName: "Facebook",
        author,
        publishedAt: postTime(postRoot),
        excerpt: text.replace(/\s+/g, " ").slice(0, 300),
        text: "",
        articleBlocks: blocks,
        downloadMedia: true,
        captureValidation: { version: CAPTURE_VALIDATION_VERSION, source: "web-page", postId: "", validated: true },
        continuations: /** @type {any[]} */ ([]),
        authorReplies: /** @type {any[]} */ ([]),
        ...(hasVideo ? { captureNotes: [S.t("影片不會保存，只保存文字與圖片。")] } : {})
      };
    }

    return { captureStatus };
  }

  return { createFacebookCapture, parseFacebookTime };
});
