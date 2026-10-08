/**
 * X (Twitter) capture: reads one status page - text, images, link cards and the author's own follow-up
 * posts - from the rendered DOM.
 */
(function initializeSavourXCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourXCapture = api;
})(globalThis, function createSavourXCaptureModule() {
  "use strict";

  const CAPTURE_VALIDATION_VERSION = 2;
  const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/;
  const PHOTO_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/photo\/\d+\/?$/;
  const SHOW_MORE_TEXT = /^(?:show more|顯示更多|显示更多|もっと見る|더 보기)$/i;
  const MAX_FOLLOW_UPS = 25;

  // Reads an X post from the page as the user sees it. X ships more than one page layout (the
  // classic one with data-testid attributes, and a newer one without), so posts are recognised by
  // what both share: an <article> per post, a link to the post's own /status/<id> address, and
  // photo links to /status/<id>/photo/<n>.
  function createXCapture(/** @type {any} */ options) {
    const S = options.shared;

    function pathOf(/** @type {Element} */ anchor) {
      try {
        const url = new URL(anchor.getAttribute("href") ?? "", location.href);
        return S.isXUrl(url.href) ? url.pathname : "";
      } catch {
        return "";
      }
    }

    // Quoted posts are drawn inside the quoting post's <article>; their parts must be skipped.
    function insideQuote(/** @type {Element} */ node, /** @type {Element} */ article) {
      for (let current = node.parentElement; current && current !== article; current = current.parentElement) {
        if (current.getAttribute("role") === "link" || current.nodeName === "ARTICLE") return true;
      }
      return false;
    }

    function statusLinks(/** @type {Element} */ article) {
      return [...article.querySelectorAll("a[href]")].flatMap(anchor => {
        const match = pathOf(anchor).match(STATUS_PATH);
        return match ? [{ anchor, handle: match[1].toLowerCase(), statusId: match[2] }] : [];
      });
    }

    // The post's own address: the requested id when given, otherwise the first status link outside a quote.
    function ownStatus(/** @type {Element} */ article, targetId = "") {
      const links = statusLinks(article);
      if (targetId) return links.find(link => link.statusId === targetId) ?? null;
      return links.find(link => !insideQuote(link.anchor, article)) ?? null;
    }

    function textElement(/** @type {Element} */ article) {
      const classic = [...article.querySelectorAll("[data-testid='tweetText']")];
      const candidates = classic.length
        ? classic
        : [...article.querySelectorAll("div[dir], div[lang]")].filter(node => !node.querySelector("div[dir], div[lang]"));
      return candidates.find(node => !insideQuote(node, article) && node.closest("article") === article) ?? null;
    }

    function isEllipsis(/** @type {any} */ value) {
      return /^(?:…|\.{3})$/.test(value);
    }

    // Text with emoji (drawn as <img alt>) and line breaks; links are recorded with what they display.
    function readText(/** @type {Element | null} */ element) {
      let text = "";
      const links = /** @type {any[]} */ ([]);
      const walk = (/** @type {any} */ node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            text += child.nodeValue;
          } else if (child.nodeName === "BR") {
            text += "\n";
          } else if (child.nodeName === "IMG") {
            text += child.getAttribute("alt") ?? "";
          } else if (child.nodeName === "A") {
            // X shortens long addresses with a trailing "…"; the link itself still goes to the full address.
            const shown = S.cleanText(child.textContent).replace(/…$/, "");
            text += shown;
            links.push({ text: shown, url: child.href });
          } else if (child.nodeType === 1 && !isEllipsis(S.cleanText(child.textContent))) {
            walk(child);
          }
        }
      };
      if (element) walk(element);
      return { text: S.cleanText(text), links: S.normalizeLinks(links) };
    }

    function largeImageUrl(/** @type {any} */ src) {
      try {
        const url = new URL(src);
        if (url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) return "";
        const format = url.searchParams.get("format") || url.pathname.match(/\.(jpe?g|png|webp)$/i)?.[1] || "jpg";
        const id = url.pathname.replace(/\.(?:jpe?g|png|webp)$/i, "");
        return `https://pbs.twimg.com${id}?format=${format.toLowerCase()}&name=large`;
      } catch {
        return "";
      }
    }

    // Photos are linked to /status/<id>/photo/<n>, so a quoted post's photos are told apart by id.
    function photos(/** @type {Element} */ article, /** @type {any} */ statusId) {
      const seen = new Set();
      const media = [];
      for (const anchor of article.querySelectorAll("a[href]")) {
        const match = pathOf(anchor).match(PHOTO_PATH);
        if (!match || match[2] !== statusId) continue;
        for (const image of anchor.querySelectorAll("img")) {
          const url = largeImageUrl(image.currentSrc || image.src);
          if (url && !seen.has(url)) {
            seen.add(url);
            media.push({ type: "image", url });
          }
        }
      }
      return media;
    }

    function quotedPosts(/** @type {Element} */ article, /** @type {any} */ statusId) {
      const seen = new Set([statusId]);
      const quoted = [];
      for (const anchor of article.querySelectorAll("a[href]")) {
        const path = pathOf(anchor);
        const match = path.match(STATUS_PATH) ?? path.match(PHOTO_PATH);
        if (!match || seen.has(match[2])) continue;
        seen.add(match[2]);
        quoted.push({ sourceUrl: `https://x.com/${match[1].toLowerCase()}/status/${match[2]}` });
      }
      return quoted;
    }

    // Link preview cards: links to other sites outside the post's text and outside a quote.
    function linkCards(/** @type {Element} */ article, /** @type {any} */ textNode, /** @type {any} */ links) {
      const inline = new Set(links.map((/** @type {any} */ link) => link.url));
      return S.normalizeLinks([...article.querySelectorAll("a[href]")]
        .filter(anchor => !textNode?.contains(anchor) && !insideQuote(anchor, article))
        .filter(anchor => {
          try {
            return !S.isXUrl(new URL(anchor.href).href);
          } catch {
            return false;
          }
        })
        .map(anchor => ({ text: S.cleanText(anchor.textContent), url: anchor.href }))
        .filter(card => !inline.has(card.url)), 10);
    }

    function isTruncated(/** @type {Element} */ article) {
      if (article.querySelector("[data-testid='tweet-text-show-more-link']")) return true;
      return [...article.querySelectorAll("a, button, span[role='button']")]
        .some(node => !insideQuote(node, article) && SHOW_MORE_TEXT.test(S.cleanText(node.textContent)));
    }

    function hasVideo(/** @type {Element} */ article) {
      return [...article.querySelectorAll("video")].some(video => !insideQuote(video, article));
    }

    function readPost(/** @type {Element} */ article, /** @type {any} */ own, /** @type {any} */ validation) {
      const textNode = textElement(article);
      const { text, links } = readText(textNode);
      const datetime = own.anchor.querySelector("time")?.getAttribute("datetime") ?? "";
      return {
        platform: "x",
        sourceUrl: `https://x.com/${own.handle}/status/${own.statusId}`,
        author: own.handle,
        publishedAt: S.xStatusTime(own.statusId) || (S.validDate(datetime) ? datetime : ""),
        text,
        links,
        linkCards: linkCards(article, textNode, links),
        media: photos(article, own.statusId),
        quotedPosts: quotedPosts(article, own.statusId),
        threadPosition: "",
        topicTag: "",
        reviewFlags: isTruncated(article) ? ["正文疑似遺漏"] : [],
        hasVideo: hasVideo(article),
        captureValidation: validation
      };
    }

    function hasContent(/** @type {any} */ post) {
      return Boolean(post.text || post.media.length || post.quotedPosts.length);
    }

    // statusId: the post to save. Follow-up posts by the same author are read only on that post's
    // own page, where X lists the author's thread right below it.
    function captureStatus(/** @type {any} */ statusId) {
      const pageStatus = S.xStatusInfo(location.href).statusId;
      const targetId = String(statusId || pageStatus || "");
      if (!targetId) throw new Error(S.t("請先點開這則 X 貼文（網址是 x.com/帳號/status/…）再保存"));
      const articles = [...document.querySelectorAll("article")].filter(article => !article.parentElement?.closest("article"));
      const index = articles.findIndex(article => {
        const status = ownStatus(article, targetId);
        return status && !insideQuote(status.anchor, article);
      });
      if (index === -1) throw new Error(S.t("找不到這則 X 貼文，請等頁面載入完成後再試一次"));
      // findIndex above only matches an article that has this status.
      const own = /** @type {NonNullable<ReturnType<typeof ownStatus>>} */ (ownStatus(articles[index], targetId));
      const validation = { version: CAPTURE_VALIDATION_VERSION, source: "x-page", postId: targetId, validated: true };
      const root = readPost(articles[index], own, validation);
      if (!hasContent(root)) throw new Error(S.t("沒有讀到這則 X 貼文的正文、圖片或引用，本次已取消"));

      const authorReplies = [];
      if (targetId === pageStatus) {
        const seen = new Set([targetId]);
        for (const article of articles.slice(index + 1)) {
          const next = ownStatus(article);
          if (!next || next.handle !== own.handle || seen.has(next.statusId)) break;
          seen.add(next.statusId);
          const post = readPost(article, next, validation);
          if (hasContent(post)) authorReplies.push(post);
          if (authorReplies.length >= MAX_FOLLOW_UPS) break;
        }
      }

      const entries = [root, ...authorReplies];
      const notes = [];
      if (entries.some(entry => entry.reviewFlags.length)) notes.push(S.t("有貼文被 X 摺疊成「顯示更多」，保存的文字可能不完整；可以點開那則貼文後再保存。"));
      if (entries.some(entry => entry.hasVideo)) notes.push(S.t("影片不會保存，只保存文字、圖片與連結。"));
      for (const entry of entries) delete /** @type {{ hasVideo?: boolean }} */ (entry).hasVideo;
      return {
        ...root,
        captureType: "post",
        continuations: /** @type {any[]} */ ([]),
        authorReplies,
        titleHint: document.title,
        ...(notes.length ? { captureNotes: notes } : {})
      };
    }

    return { captureStatus, readText };
  }

  return { createXCapture };
});
