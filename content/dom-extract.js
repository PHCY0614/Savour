/**
 * Threads DOM extraction: reads text, media, links, topic tag, quoted posts and thread position out of
 * one post container found by dom-scope.js.
 *
 * Created with `createDomExtract(options)`; it only reads the DOM and never changes the page.
 */
(function initializeSavourDomExtract(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourDomExtract = api;
})(globalThis, function createSavourDomExtractModule() {
  "use strict";
  /**
   * Builds the post readers. `options` supplies the shared module, dom-scope (`options.scope`), Threads selectors and
   * patterns, and `getHelpers()` for helpers in threads-content.js (read lazily because they are created later).
   */
  function createDomExtract(/** @type {any} */ options) {
    const S = options.shared;
    const { buildPostScope, describePostContainer, extractQuotedPosts, findPostUrl, postAnchorSuffixDepth } = options.scope;
    const { semanticPostSelector: SEMANTIC_POST_SELECTOR, longTextControlPattern: LONG_TEXT_CONTROL_PATTERN, topicLabelPattern: TOPIC_LABEL_PATTERN, avatarAltPattern: AVATAR_ALT_PATTERN, profileInfoSelector: PROFILE_INFO_SELECTOR, profileTimelineSelector: PROFILE_TIMELINE_SELECTOR } = options;
    const CAPTURE_VALIDATION_VERSION = options.captureValidationVersion;
    const addLongText = (/** @type {any[]} */ ...args) => options.getHelpers().addLongText(...args);
    const isUiText = (/** @type {any[]} */ ...args) => options.getHelpers().isUiText(...args);
    const isVisible = (/** @type {any[]} */ ...args) => options.getHelpers().isVisible(...args);
    /**
     * Reads one post: text, author, date, topic tag, thread position, media, links, quoted posts and hidden long
     * text. Throws when the container does not hold exactly the expected post.
     * @param {Element} container
     * @param {{ expectedPostId?: string }} [options]
     */
    function extractPost(container, options = {}) {
      if (!(container instanceof Element)) return null;
      const sourceUrl = findPostUrl(container);
      if (!sourceUrl) return null;
      const parsed = S.parseThreadsUrl(sourceUrl);
      if (options.expectedPostId && parsed.postId !== options.expectedPostId) {
        throw new Error(S.t("貼文容器與目前網址不一致，已取消保存"));
      }
      const descriptor = describePostContainer(container);
      if (!descriptor || descriptor.directPostId !== parsed.postId || !descriptor.postIds.includes(parsed.postId)) {
        throw new Error(S.t("貼文容器無法通過來源驗證，已取消保存"));
      }
      const time = ownTimeElement(container);
      const publishedAt = time?.getAttribute("datetime") || time?.dateTime || "";
      const topicTag = extractTopicTag(container);
      const text = stripTopicTagFromText(extractPostText(container, parsed.handle), topicTag);
      const longTextAttachments = extractHiddenLongTexts(container, text);
      const threadPosition = S.normalizeThreadPosition(extractThreadPosition(container));
      const media = extractPostMedia(container);
      const quotedPosts = extractQuotedPosts(container);
      const links = extractPostLinks(container, parsed.handle);
      const linkCards = extractLinkCards(container, links);
      const reviewFlags = [];
      if (descriptor.hasTextEvidence && !text) reviewFlags.push("正文疑似遺漏");
      return {
        captureType: "post",
        text,
        sourceUrl,
        author: parsed.handle,
        publishedAt,
        topicTag,
        threadPosition,
        reviewFlags: S.normalizeReviewFlags(reviewFlags),
        media,
        quotedPosts,
        links,
        linkCards,
        continuations: /** @type {any[]} */ ([]),
        authorReplies: /** @type {any[]} */ ([]),
        longTextAttachments,
        titleHint: document.title,
        captureValidation: {
          version: CAPTURE_VALIDATION_VERSION,
          postId: parsed.postId,
          containerPostIds: descriptor.postIds,
          excludedPostIds: descriptor.excludedPostIds,
          validated: true
        }
      };
    }

    /**
     * The <time> of the container's own post, not of a quoted one; null when there is none.
     * @param {Element} container
     */
    function ownTimeElement(container) {
      const scope = buildPostScope(container);
      const directTime = scope?.directAnchor?.querySelector("time[datetime]") ?? null;
      if (directTime) return directTime;

      const postId = scope?.postId ?? "";
      if (!postId) return null;

      const timeline = container.closest(PROFILE_TIMELINE_SELECTOR);
      const roots = [...new Set([container, timeline, document].filter(Boolean))];

      for (const root of roots) {
        const headerAnchor = findPostHeaderAnchor(root, postId);
        const time = headerAnchor?.querySelector("time[datetime]") ?? null;
        if (time) return time;
      }

      return null;
    }

    /**
     * Removes the topic tag and other Threads metadata lines from post text.
     * @param {string} text
     * @param {string} topicTag
     */
    function stripTopicTagFromText(text, topicTag) {
      return S.stripThreadsMetadataLines(text, topicTag);
    }

    /**
     * The post's topic tag without "#", or "".
     * @param {Element} container
     */
    function extractTopicTag(container) {
      if (!(container instanceof Element)) return "";
      const candidates = /** @type {any[]} */ ([]);
      const author = S.parseThreadsUrl(findPostUrl(container)).handle;
      const add = (/** @type {any} */ value) => {
        const text = S.cleanText(value).replace(/^#+/, "").trim();
        if (!text || text.length > 100 || isUiText(text, author)) return;
        if (!candidates.includes(text)) candidates.push(text);
      };

      add(findLinkedTopicTag(container, S.parseThreadsUrl(findPostUrl(container)).postId));
      if (candidates.length) return candidates[0];

      const metadataScope = container.closest(PROFILE_TIMELINE_SELECTOR) || container;
      metadataScope.querySelectorAll("[aria-label], [title]").forEach((/** @type {Element} */ node) => {
        if (node.closest(PROFILE_INFO_SELECTOR)) return;
        for (const value of [node.getAttribute("aria-label"), node.getAttribute("title")]) {
          const match = S.cleanText(value).match(TOPIC_LABEL_PATTERN);
          if (match) add(match[1]);
        }
      });
      return candidates[0] ?? "";
    }

    /**
     * The topic tag linked in the post's header line, or "".
     * @param {Element} container
     * @param {string} postId
     */
    function findLinkedTopicTag(container, postId) {
      if (!(container instanceof Element) || !postId) return "";
      const timeline = container.closest(PROFILE_TIMELINE_SELECTOR);
      const roots = [...new Set([timeline, container, document].filter(Boolean))];

      for (const root of roots) {
        const reference = findPostHeaderAnchor(root, postId);
        if (!reference) continue;
        let scope = reference.parentElement;
        for (let depth = 0; scope && depth < 14; depth += 1) {
          const topic = topicTagBeforeReference(scope, reference);
          if (topic) return topic;
          if (timeline && scope === timeline) break;
          scope = scope.parentElement;
        }
      }
      return "";
    }

    /**
     * The link to this post that best represents its header: one with a <time>, pointing at the post itself, visible.
     * @param {any} root an element or the document
     * @param {string} postId
     */
    function findPostHeaderAnchor(root, postId) {
      if (!(root instanceof Element) && !(root instanceof Document)) return null;
      const anchors = [...root.querySelectorAll("a[href]")].filter(anchor => {
        return S.parseThreadsUrl(anchor.href).postId === postId;
      });
      anchors.sort((left, right) => {
        const leftHasTime = left.matches("time") || Boolean(left.querySelector("time"));
        const rightHasTime = right.matches("time") || Boolean(right.querySelector("time"));
        if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1;
        const suffixDifference = postAnchorSuffixDepth(left) - postAnchorSuffixDepth(right);
        if (suffixDifference) return suffixDifference;
        if (isVisible(left) !== isVisible(right)) return isVisible(left) ? -1 : 1;
        return 0;
      });
      return anchors[0] ?? null;
    }

    /**
     * The first topic tag link in `scope` that comes before `reference`, or "".
     * @param {Element} scope
     * @param {Element} reference
     */
    function topicTagBeforeReference(scope, reference) {
      for (const anchor of scope.querySelectorAll("a[href]")) {
        if (anchor === reference || anchor.contains(reference) || reference.contains(anchor)) continue;
        const order = anchor.compareDocumentPosition(reference);
        if (!(order & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const topic = topicTagFromLink(anchor);
        if (topic) return topic;
      }
      return "";
    }

    /**
     * The topic name when a link points at a Threads topic or tag search, else "".
     * @param {Element} anchor
     */
    function topicTagFromLink(anchor) {
      let url;
      try {
        url = new URL(anchor.getAttribute("href") || anchor.href, location.href);
      } catch {
        return "";
      }
      if (!S.isThreadsUrl(url.href)) return "";
      const isTagSearch = /^\/search\/?$/i.test(url.pathname)
        && (url.searchParams.get("serp_type") === "tags" || Boolean(url.searchParams.get("tag_id")));
      const isTopicPath = /\/topic(?:\/|$)/i.test(url.pathname);
      if (!isTagSearch && !isTopicPath) return "";
      return S.cleanText(anchor.innerText || anchor.textContent || url.searchParams.get("q"))
        .replace(/^#+/, "")
        .trim()
        .slice(0, 100);
    }

    /**
     * Pictures the author posted, as https URLs at the largest size offered. Skips avatars, icons, link preview
     * thumbnails and images of quoted posts.
     * @param {Element} container
     */
    function extractPostMedia(container) {
      if (!(container instanceof Element)) return [];
      const media = /** @type {any[]} */ ([]);
      const seen = new Set();

      container.querySelectorAll("img").forEach(image => {
        if (!belongsToPostContainer(image, container)) return;
        if (image.closest(PROFILE_INFO_SELECTOR) || image.closest("[aria-hidden='true']")) return;
        const alt = S.cleanText(image.getAttribute("alt") || "");
        if (AVATAR_ALT_PATTERN.test(alt)) return;

        const rect = image.getBoundingClientRect();
        const renderedWidth = Math.max(0, Math.round(rect.width));
        const renderedHeight = Math.max(0, Math.round(rect.height));
        const intrinsicWidth = Number(image.naturalWidth || image.getAttribute("width") || 0);
        const intrinsicHeight = Number(image.naturalHeight || image.getAttribute("height") || 0);
        const renderedAsMedia = renderedWidth >= 120 || renderedHeight >= 120;
        const intrinsicallyMedia = intrinsicWidth >= 300 || intrinsicHeight >= 300;
        const srcsetMedia = /\s(?:[3-9]\d{2,}|\d{4,})w(?:\s*,|$)/i.test(image.getAttribute("srcset") || "")
          || /\s(?:1\.5|[2-9](?:\.\d+)?)x(?:\s*,|$)/i.test(image.getAttribute("srcset") || "");
        if (!renderedAsMedia && !intrinsicallyMedia && !srcsetMedia) return;

        // Link preview thumbnails live inside the outbound link; images the author posted never do.
        if (isInsideOutboundLinkCard(image, container)) return;
        const profileLink = image.closest("a[href]");
        if (profileLink) {
          try {
            const profileUrl = new URL(profileLink.href, location.href);
            const isProfileOnly = /^\/@[^/]+\/?$/i.test(profileUrl.pathname);
            if (isProfileOnly) return;
          } catch {
            // The image can still be captured when a surrounding link is malformed.
          }
        }

        const url = bestImageUrl(image);
        if (!url || !/^https:\/\//i.test(url)) return;
        const key = mediaUrlKey(url);
        if (!key || seen.has(key)) return;
        seen.add(key);
        media.push({
          type: "image",
          url,
          alt: "",
          width: Math.max(renderedWidth, intrinsicWidth),
          height: Math.max(renderedHeight, intrinsicHeight)
        });
      });
      return media;
    }

    /**
     * True when `node` is inside the container's own post, not inside a quoted or nested post.
     * @param {Element} node
     * @param {Element} container
     */
    function belongsToPostContainer(node, container) {
      if (!(node instanceof Element) || !(container instanceof Element) || !container.contains(node)) return false;
      const scope = buildPostScope(container);
      if (scope?.excludedRoots?.some((/** @type {Element} */ root) => root === node || root.contains(node))) return false;
      const semantic = container.matches(SEMANTIC_POST_SELECTOR) ? container : null;
      const nearestSemantic = node.closest(SEMANTIC_POST_SELECTOR);
      if (semantic) return nearestSemantic === semantic;
      return !nearestSemantic || !container.contains(nearestSemantic);
    }

    /**
     * The largest image URL from an <img>'s srcset, else its current src; "" when invalid.
     * @param {HTMLImageElement} image
     */
    function bestImageUrl(image) {
      let best = image.currentSrc || image.src || "";
      let bestScore = 0;
      const srcset = image.getAttribute("srcset") || "";
      for (const candidate of srcset.split(",")) {
        const match = candidate.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/i);
        if (!match) continue;
        const score = Number(match[2]) * (match[3].toLowerCase() === "x" ? 1000 : 1);
        if (score >= bestScore) {
          bestScore = score;
          best = match[1];
        }
      }
      try {
        return new URL(best, location.href).href;
      } catch {
        return "";
      }
    }

    /**
     * An image URL without its query string, used to spot the same image at different sizes.
     * @param {string} value
     */
    function mediaUrlKey(value) {
      try {
        const url = new URL(value, location.href);
        return `${url.origin}${url.pathname}`;
      } catch {
        return value;
      }
    }

    /**
     * The post's own text, one paragraph per text block, without UI labels, names or quoted posts.
     * @param {Element} container
     * @param {string} author handle, used to skip the author's name
     */
    function extractPostText(container, author) {
      const candidates = /** @type {any[]} */ ([]);
      const addCandidate = (/** @type {any} */ value) => {
        const text = cleanPostTextCandidate(value, author);
        if (!text || isUiText(text, author)) return;
        if (candidates.some(existing => existing === text || existing.includes(text))) return;
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          if (text.includes(candidates[index])) candidates.splice(index, 1);
        }
        candidates.push(text);
      };

      ownAutoTextNodes(container).forEach(node => {
        if (isExcludedTextNode(node, container, author)) return;
        const visibleText = S.cleanText(node.innerText);
        const rawText = S.cleanText(node.textContent);
        addCandidate(visibleText || rawText);
      });

      return S.cleanText(candidates.join("\n\n"));
    }

    // A link preview card is an outbound link wrapping blocks (thumbnail, title); an inline link is plain text.
    function isInsideOutboundLinkCard(/** @type {Element} */ node, /** @type {Element} */ container) {
      const anchor = node.closest("a[href]");
      if (!anchor || !container.contains(anchor) || !S.externalLinkUrl(anchor.href)) return false;
      return node.matches("img") || Boolean(anchor.querySelector("[dir='auto'], img"));
    }

    // Outbound links inside the same text nodes extractPostText reads.
    function extractPostLinks(/** @type {Element} */ container, /** @type {any} */ author) {
      const links = /** @type {any[]} */ ([]);
      ownAutoTextNodes(container).forEach(node => {
        if (isExcludedTextNode(node, container, author)) return;
        const anchors = [...node.querySelectorAll("a[href]")];
        const wrapping = node.closest("a[href]");
        if (wrapping && container.contains(wrapping)) anchors.push(wrapping);
        for (const anchor of anchors) {
          const url = S.externalLinkUrl(anchor.href);
          if (url) links.push({ text: S.cleanText(anchor.innerText || anchor.textContent), url });
        }
      });
      return S.normalizeLinks(links);
    }

    // Outbound links elsewhere in the post (link preview cards) whose URL is not already inline.
    function extractLinkCards(/** @type {Element} */ container, /** @type {any} */ inlineLinks = []) {
      const inlineUrls = new Set(inlineLinks.map((/** @type {{ url: string }} */ link) => link.url));
      const cards = /** @type {any[]} */ ([]);
      for (const anchor of container.querySelectorAll("a[href]")) {
        if (!belongsToPostContainer(anchor, container)) continue;
        const url = S.externalLinkUrl(anchor.href);
        if (!url || inlineUrls.has(url) || cards.some(card => card.url === url)) continue;
        cards.push({ url, text: S.cleanText(anchor.innerText || anchor.textContent).slice(0, 300) });
      }
      return cards.slice(0, 10);
    }

    /**
     * The innermost text blocks ([dir=auto]) that belong to the container's own post.
     * @param {Element} container
     */
    function ownAutoTextNodes(container) {
      return scopedAutoTextNodes(container).filter(node => !node.querySelector("[dir='auto']"));
    }

    /**
     * Every text block ([dir=auto]) that belongs to the container's own post.
     * @param {Element} container
     */
    function scopedAutoTextNodes(container) {
      if (!(container instanceof Element)) return [];
      return [...container.querySelectorAll("[dir='auto']")].filter(node => {
        return belongsToPostContainer(node, container);
      });
    }

    /**
     * Cleans a block of text and drops lines that are Threads UI text (buttons, counts, the author's name).
     * @param {unknown} value
     * @param {string} author
     */
    function cleanPostTextCandidate(value, author) {
      const lines = S.cleanText(value)
        .split("\n")
        .map((/** @type {any} */ line) => S.cleanText(line))
        .map((/** @type {any} */ line) => {
          if (!line) return "";
          return S.isThreadsUiText(line, author) ? null : line;
        })
        .filter((/** @type {any} */ line) => line !== null);
      return S.cleanText(lines.join("\n"));
    }

    /**
     * True when a text block is not post text: profile info, time, link card, button, thread position, or a link
     * to a profile, search or topic.
     * @param {Element} node
     * @param {Element} container
     * @param {string} author
     */
    function isExcludedTextNode(node, container, author) {
      if (!belongsToPostContainer(node, container)) return true;
      if (node.closest(PROFILE_INFO_SELECTOR) || node.closest("[aria-hidden='true']")) return true;
      if (node.closest("time") || node.querySelector("time")) return true;
      if (isInsideOutboundLinkCard(node, container)) return true;
      const text = S.cleanText(node.innerText || node.textContent);
      if (!text || S.isThreadsUiText(text, author) || isThreadPositionElement(node)) return true;

      const title = S.cleanText(node.getAttribute("title") || node.closest("[title]")?.getAttribute("title") || "");
      if (/(?:加入時間|joined|自訂表情符號|customi[sz]e emoji)/i.test(title)) return true;

      const anchor = node.closest("a[href]");
      if (anchor && container.contains(anchor)) {
        try {
          const url = new URL(anchor.href, location.href);
          if (S.isThreadsUrl(url.href) && (/^\/@[^/]+\/?$/i.test(url.pathname) || /\/(?:search|topic)(?:\/|$)/i.test(url.pathname))) {
            return true;
          }
        } catch {
          return true;
        }
      }

      const button = node.closest("button") || (node.matches("[role='button']") ? node : null);
      if (button && container.contains(button)) {
        const buttonText = S.cleanText(button.innerText || button.textContent || button.getAttribute("aria-label"));
        const ariaLabel = S.cleanText(button.getAttribute("aria-label") || "");
        if (S.isThreadsUiText(buttonText, author) || (ariaLabel && S.isThreadsUiText(ariaLabel, author))) return true;
        if (text.length <= 80 && LONG_TEXT_CONTROL_PATTERN.test(text)) return true;
      }
      return false;
    }

    /**
     * True for the "2/5" marker that numbers a post inside the author's thread.
     * @param {Element} node
     */
    function isThreadPositionElement(node) {
      if (!(node instanceof Element)) return false;
      const text = S.cleanText(node.textContent).replace(/\s+/g, "");
      const position = S.parseThreadPosition(text);
      if (!position || text !== `${position.index}/${position.total}`) return false;
      const parts = [...node.querySelectorAll("span")]
        .map(part => S.cleanText(part.textContent))
        .filter(Boolean);
      return parts.includes("/") || (node.childElementCount === 0 && text.length <= 9);
    }

    /**
     * The post's "index/total" thread position, or null.
     * @param {Element} container
     */
    function extractThreadPosition(container) {
      const matches = [...container.querySelectorAll("div, span")].filter(node => {
        if (!belongsToPostContainer(node, container) || !isThreadPositionElement(node)) return false;
        return ![...node.children].some(child => isThreadPositionElement(child));
      });
      return matches.length ? S.parseThreadPosition(matches[0].textContent) : null;
    }

    /**
     * Text present in the page but cut off on screen (behind "more"), returned as long-text attachments.
     * @param {Element} container
     * @param {string} [postText] the visible text, so the same text is not added twice
     */
    function extractHiddenLongTexts(container, postText = "") {
      if (!(container instanceof Element)) return [];
      const found = /** @type {any[]} */ ([]);
      const author = S.parseThreadsUrl(findPostUrl(container)).handle;
      ownAutoTextNodes(container).forEach(node => {
        if (isExcludedLongTextNode(node, container, author)) return;
        const visibleText = S.stripThreadsMetadataLines(cleanPostTextCandidate(node.innerText, author));
        const rawText = S.stripThreadsMetadataLines(cleanPostTextCandidate(node.textContent, author));
        const candidate = S.hiddenLongTextCandidate(visibleText, rawText, postText);
        if (candidate) addLongText(found, candidate);
      });
      return found.map(text => ({ text, title: "長文附件", source: "hidden_dom" }));
    }

    /**
     * Like isExcludedTextNode, for long text: also keeps text inside buttons, since "more" often wraps it.
     * @param {Element} node
     * @param {Element} container
     * @param {string} author
     */
    function isExcludedLongTextNode(node, container, author) {
      if (!belongsToPostContainer(node, container)) return true;
      if (node.closest(PROFILE_INFO_SELECTOR) || node.closest("time")) return true;
      if (isInsideOutboundLinkCard(node, container)) return true;
      if (isThreadPositionElement(node)) return true;
      const title = S.cleanText(node.getAttribute("title") || node.closest("[title]")?.getAttribute("title") || "");
      if (/(?:加入時間|joined|自訂表情符號|customi[sz]e emoji)/i.test(title)) return true;

      const anchor = node.closest("a[href]");
      if (!anchor || !container.contains(anchor)) return false;
      try {
        const url = new URL(anchor.href, location.href);
        if (!S.isThreadsUrl(url.href)) return false;
        return /^\/@[^/]+\/?$/i.test(url.pathname) || /\/(?:search|topic)(?:\/|$)/i.test(url.pathname);
      } catch {
        return true;
      }
    }

    return { extractPost, extractPostLinks, extractLinkCards, ownTimeElement, stripTopicTagFromText, extractTopicTag, findLinkedTopicTag, findPostHeaderAnchor, topicTagBeforeReference, topicTagFromLink, extractPostMedia, belongsToPostContainer, bestImageUrl, mediaUrlKey, extractPostText, ownAutoTextNodes, scopedAutoTextNodes, cleanPostTextCandidate, isExcludedTextNode, isThreadPositionElement, extractThreadPosition, extractHiddenLongTexts, isExcludedLongTextNode };
  }
  return { createDomExtract };
});
