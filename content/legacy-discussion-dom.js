/**
 * Finds a Threads thread's related posts in the rendered DOM. "Legacy" because saving replies as
 * separate pages is disabled; threads-content.js still uses it to read the thread.
 */
(function initializeSavourLegacyDiscussionDom(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourLegacyDiscussionDom = api;
})(globalThis, function createSavourLegacyDiscussionDomModule() {
  "use strict";

  /**
   * Reads thread posts from the rendered page, for when the embedded JSON is missing or incomplete.
   */
  function createLegacyDiscussionDom(/** @type {any} */ options) {
    const S = options.shared;
    const { isPostLink } = options.scope;
    const { cleanPostTextCandidate, isThreadPositionElement } = options.extract;
    const PROFILE_INFO_SELECTOR = options.profileInfoSelector;

    /**
     * Adds an entry to `map` by post id. When the post is already there, the higher-quality entry wins, then the
     * longer text.
     * @param {Map<string, any>} map
     * @param {any} entry
     */
    function putDiscussionEntry(map, entry) {
      const postId = entry?.postId || S.parseThreadsUrl(entry?.sourceUrl).postId;
      const text = S.cleanText(entry?.text || "");
      if (!postId || !text) return;

      const candidate = {
        ...entry,
        postId,
        text,
        quality: Number(entry?.quality || 0)
      };

      const existing = map.get(postId);
      if (!existing) {
        map.set(postId, candidate);
        return;
      }

      const existingText = S.cleanText(existing.text || "");
      const candidateScore = candidate.quality * 100000 + candidate.text.length;
      const existingScore = Number(existing.quality || 0) * 100000 + existingText.length;

      // The higher-quality capture wins; at equal quality, the longer text.
      if (candidateScore > existingScore) {
        map.set(postId, {
          ...existing,
          ...candidate,
          orderNode: existing.orderNode || candidate.orderNode
        });
      }
    }

    /**
     * Reads the post text inside a link that wraps a post body. Null for timestamp links and links with no text.
     * @param {Element} anchor
     * @param {any} parsed the anchor's URL from S.parseThreadsUrl
     */
    function extractDiscussionBodyAnchor(anchor, parsed) {
      if (!(anchor instanceof Element) || !parsed?.postId) return null;

      // A timestamp permalink is not post text.
      if (anchor.matches("time") || anchor.querySelector("time")) return null;

      const values = [];
      const seen = new Set();

      const leaves = [...anchor.querySelectorAll("[dir='auto']")]
        .filter(node => !node.querySelector("[dir='auto']"));

      for (const node of leaves) {
        if (node.closest("time")) continue;
        if (node.closest(PROFILE_INFO_SELECTOR)) continue;
        if (node.closest("button, [role='button']")) continue;
        if (isThreadPositionElement(node)) continue;

        const nestedLink = node.closest("a[href]");
        if (nestedLink && nestedLink !== anchor) {
          // Links do not normally nest, but if Threads changes its DOM, accept only the same post id
          // so a quoted post's text is not mixed in.
          const nested = S.parseThreadsUrl(nestedLink.href);
          if (!nested.postId || nested.postId !== parsed.postId) continue;
        }

        const value = cleanPostTextCandidate(
          node.innerText || node.textContent,
          parsed.handle
        );
        const clean = S.cleanText(value);
        if (!clean) continue;
        if (clean === parsed.handle || clean === `@${parsed.handle}`) continue;
        if (S.isThreadsUiText(clean, parsed.handle)) continue;
        if (seen.has(clean)) continue;

        seen.add(clean);
        values.push(clean);
      }

      // A few body links have no [dir=auto]; fall back to the link's own text last.
      if (!values.length) {
        const fallback = S.cleanText(
          cleanPostTextCandidate(anchor.innerText || anchor.textContent, parsed.handle)
        );

        const looksLikeDateOnly = /^(?:\d{1,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|\d+\s*(?:秒|分|分鐘|小時|天|週|星期|月|年|s|m|h|d|w|mo|y)(?:前)?)$/i.test(fallback);

        if (
          fallback
          && !looksLikeDateOnly
          && !S.isThreadsUiText(fallback, parsed.handle)
        ) {
          values.push(fallback);
        }
      }

      const text = S.stripThreadsMetadataLines(values.join("\n\n"), "");
      if (!text) return null;

      const timeAnchor = findDiscussionPermalinkByPostId(parsed.postId);
      const time = timeAnchor?.querySelector("time[datetime], time");

      return {
        author: parsed.handle || "",
        text,
        sourceUrl: parsed.normalized,
        postId: parsed.postId,
        publishedAt: time?.getAttribute("datetime") || time?.dateTime || "",
        orderNode: anchor,
        quality: 80
      };
    }

    /**
     * Turns a captured post into a discussion entry, using its long text in place of the excerpt when there is one.
     * @param {any} capture
     */
    function discussionEntryFromCapture(capture) {
      const parts = [];
      const main = S.cleanText(capture?.text || "");
      if (main) parts.push(main);

      for (const attachment of (capture?.longTextAttachments ?? [])) {
        const value = S.cleanText(attachment?.text ?? attachment);
        if (!value) continue;
        if (main && value.includes(main) && value.length > main.length) {
          parts.length = 0;
          parts.push(value);
          continue;
        }
        if (main && main.includes(value)) continue;
        if (!parts.includes(value)) parts.push(value);
      }

      const postId = S.parseThreadsUrl(capture?.sourceUrl).postId || "";
      return {
        author: capture?.author || S.parseThreadsUrl(capture?.sourceUrl).handle || "",
        text: parts.join("\n\n"),
        sourceUrl: capture?.sourceUrl || "",
        postId,
        orderNode: findDiscussionPermalinkByPostId(postId),
        quality: 100
      };
    }

    /**
     * Every post link that wraps a timestamp, one per post, in page order.
     */
    function collectDiscussionPermalinks() {
      const anchors = /** @type {any[]} */ ([]);
      const seen = new Set();

      document.querySelectorAll("time").forEach(time => {
        const anchor = time.closest("a[href]");
        if (!anchor || !isPostLink(anchor.href)) return;
        const parsed = S.parseThreadsUrl(anchor.href);
        if (!parsed.postId || seen.has(parsed.postId)) return;
        seen.add(parsed.postId);
        anchors.push(anchor);
      });

      return anchors.sort(compareDocumentNodes);
    }

    /**
     * The timestamp link of the post with this id, or null.
     * @param {string} postId
     */
    function findDiscussionPermalinkByPostId(postId) {
      if (!postId) return null;
      return collectDiscussionPermalinks().find(anchor =>
        S.parseThreadsUrl(anchor.href).postId === postId
      ) || null;
    }

    /**
     * The timestamp link of the post with this id inside `container`, or null.
     * @param {Element} container
     * @param {string} postId
     */
    function findPostTimeAnchor(container, postId) {
      if (!(container instanceof Element) || !postId) return null;
      return [...container.querySelectorAll("time")]
        .map(time => time.closest("a[href]"))
        .find(anchor =>
          anchor
          && isPostLink(anchor.href)
          && S.parseThreadsUrl(anchor.href).postId === postId
        ) || null;
    }

    /**
     * Walks up from a post link to the element that holds just that post (its text and action buttons) when the
     * page has no semantic post container. Null when none is found.
     * @param {Element} anchor
     * @param {string} postId
     */
    function findLooseDiscussionCard(anchor, postId) {
      if (!(anchor instanceof Element) || !postId) return null;

      let best = null;
      let node = anchor.parentElement;

      for (let depth = 0; node && depth < 18; depth += 1, node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;

        const ids = loosePostIds(node);
        if (!ids.includes(postId)) continue;

        const textLength = looseTextCandidates(
          node,
          S.parseThreadsUrl(anchor.href).handle,
          postId
        ).join("").length;

        if (ids.length > 1) {
          if (!best && textLength > 0) best = node;
          break;
        }

        if (textLength > 0) best = node;
        if (textLength > 0 && countLooseActionKinds(node) >= 2) return node;
      }

      return best;
    }

    function loosePostIds(/** @type {Element} */ node) {
      if (!(node instanceof Element)) return [];
      const ids = /** @type {any[]} */ ([]);
      node.querySelectorAll("a[href]").forEach(anchor => {
        if (!isPostLink(anchor.href)) return;
        const id = S.parseThreadsUrl(anchor.href).postId;
        if (id && !ids.includes(id)) ids.push(id);
      });
      return ids;
    }

    function countLooseActionKinds(/** @type {Element} */ node) {
      const kinds = new Set();

      node.querySelectorAll("button, [role='button'], [aria-label]").forEach((/** @type {any} */ control) => {
        const label = S.cleanText([
          control.getAttribute("aria-label"),
          control.getAttribute("title"),
          control.innerText
        ].filter(Boolean).join(" ")).replace(/\s+/g, " ");

        if (/(?:^|\s)(?:讚|like)(?:\s|$)/i.test(label)) kinds.add("like");
        if (/(?:^|\s)(?:回覆|reply)(?:\s|$)/i.test(label)) kinds.add("reply");
        if (/(?:^|\s)(?:轉發|repost)(?:\s|$)/i.test(label)) kinds.add("repost");
        if (/(?:^|\s)(?:分享|share)(?:\s|$)/i.test(label)) kinds.add("share");
      });

      return kinds.size;
    }

    /**
     * Reads author, text, URL and date of the post in a card found by findLooseDiscussionCard.
     * @param {Element} card
     * @param {Element} anchor
     * @param {any} parsed the anchor's URL from S.parseThreadsUrl
     */
    function extractLooseDiscussionEntry(card, anchor, parsed) {
      const author = parsed.handle || "";
      const parts = looseTextCandidates(card, author, parsed.postId);
      const text = S.stripThreadsMetadataLines(parts.join("\n\n"), "");
      const time = anchor.querySelector("time") || card.querySelector("time[datetime]");

      return {
        author,
        text,
        sourceUrl: parsed.normalized,
        postId: parsed.postId,
        publishedAt: time?.getAttribute("datetime") || time?.dateTime || "",
        orderNode: anchor
      };
    }

    function looseTextCandidates(/** @type {any} */ card, /** @type {any} */ author, postId = "") {
      if (!(card instanceof Element)) return [];

      const values = [];
      const seen = new Set();

      const leaves = [...card.querySelectorAll("[dir='auto']")]
        .filter(node => !node.querySelector("[dir='auto']"));

      for (const node of leaves) {
        if (node.closest("time")) continue;
        if (node.closest(PROFILE_INFO_SELECTOR)) continue;
        if (node.closest("button, [role='button']")) continue;
        if (isThreadPositionElement(node)) continue;

        const profileLink = node.closest("a[href]");
        if (profileLink) {
          try {
            const url = new URL(profileLink.href, location.href);
            if (/^\/@[^/]+\/?$/i.test(url.pathname)) continue;

            if (isPostLink(profileLink.href)) {
              const linkedPostId = S.parseThreadsUrl(profileLink.href).postId;
              if (!linkedPostId || linkedPostId !== postId) continue;
            }
          } catch {
            continue;
          }
        }

        const value = cleanPostTextCandidate(
          node.innerText || node.textContent,
          author
        );
        const clean = S.cleanText(value);

        if (!clean) continue;
        if (clean === author || clean === `@${author}`) continue;
        if (S.isThreadsUiText(clean, author)) continue;
        if (seen.has(clean)) continue;

        seen.add(clean);
        values.push(clean);
      }

      return values;
    }

    /**
     * The heading that starts Threads' suggested posts, or null. Posts after it are not part of the thread.
     */
    function findDiscussionRecommendationBoundary() {
      return [...document.querySelectorAll("h1, h2, h3, [dir='auto']")].find(node => {
        const text = S.cleanText(node.innerText || node.textContent).replace(/\s+/g, " ");
        return /^(?:推薦(?:貼文|內容)?|為你推薦|suggested(?: posts?)?)$/i.test(text);
      }) || null;
    }

    /**
     * Sort comparator for page order. Takes nodes or entries with an `orderNode`; unknown order sorts as equal.
     * @param {any} left
     * @param {any} right
     */
    function compareDocumentNodes(left, right) {
      const leftNode = left?.orderNode instanceof Node ? left.orderNode : left;
      const rightNode = right?.orderNode instanceof Node ? right.orderNode : right;
      if (!(leftNode instanceof Node) || !(rightNode instanceof Node) || leftNode === rightNode) return 0;
      const position = leftNode.compareDocumentPosition(rightNode);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    }

    /**
     * True when `node` comes after `boundary` in the page.
     * @param {Element} node
     * @param {any} boundary
     */
    function isNodeAfter(node, boundary) {
      if (!(node instanceof Node) || !(boundary instanceof Node)) return false;
      return Boolean(boundary.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    return {
      collectDiscussionPermalinks,
      compareDocumentNodes,
      discussionEntryFromCapture,
      extractDiscussionBodyAnchor,
      extractLooseDiscussionEntry,
      findDiscussionPermalinkByPostId,
      findDiscussionRecommendationBoundary,
      findLooseDiscussionCard,
      findPostTimeAnchor,
      isNodeAfter,
      putDiscussionEntry
    };
  }

  return { createLegacyDiscussionDom };
});
