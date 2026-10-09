/**
 * Threads DOM scoping: finds which element is "the post" for a link, post id or selection, so text
 * from a neighbouring post, a recommendation or a reply is never mixed in.
 *
 * Created with `createDomScope(options)`; selectors and patterns come from threads-content.js.
 */
(function initializeSavourDomScope(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourDomScope = api;
})(globalThis, function createSavourDomScopeModule() {
  "use strict";

  /**
   * Builds the post-scoping helpers. `options` supplies the shared module, Threads selectors and patterns,
   * `currentRouteSignature`, and `getExtractors()` for dom-extract (read lazily because it is created later).
   */
  function createDomScope(/** @type {any} */ options) {
    const S = options.shared;
    const semanticPostSelector = options.semanticPostSelector;
    const postLinkPattern = options.postLinkPattern;
    const profileInfoSelector = options.profileInfoSelector;
    const avatarAltPattern = options.avatarAltPattern;
    const currentRouteSignature = options.currentRouteSignature;
    const getExtractors = options.getExtractors;
    let postScopeCache = new WeakMap();
    const PAGE_CHROME_SELECTOR = "nav, footer, main, [role='navigation'], [role='banner'], [role='main'], [role='contentinfo']";

    /**
     * Forgets every computed post scope. Call when the page changes route.
     */
    function resetCache() {
      postScopeCache = new WeakMap();
    }

    /**
     * One container per post on the page, in page order. When several elements claim the same post, the best
     * candidate wins (see S.choosePostCandidate).
     */
    function collectPostContainers() {
      const candidates = new Set();
      document.querySelectorAll(semanticPostSelector).forEach(container => {
        if (!isNestedEmbeddedPostContainer(container)) candidates.add(container);
      });
      document.querySelectorAll("a[href]").forEach(anchor => {
        if (!isPostLink(anchor.href)) return;
        const container = findPostContainer(anchor);
        if (container) candidates.add(container);
      });

      const byPostId = new Map();
      let documentOrder = 0;
      for (const container of candidates) {
        const descriptor = describePostContainer(container, documentOrder);
        documentOrder += 1;
        if (!descriptor?.directPostId) continue;
        const group = byPostId.get(descriptor.directPostId) ?? [];
        group.push(descriptor);
        byPostId.set(descriptor.directPostId, group);
      }

      const containers = [];
      for (const [postId, descriptors] of byPostId) {
        const chosen = S.choosePostCandidate(descriptors, postId);
        if (chosen?.container) containers.push(chosen.container);
      }
      return containers.sort((left, right) => {
        const position = left.compareDocumentPosition(right);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
    }

    /**
     * The container of the post that `target` belongs to, or null.
     * @param {any} target an element or a text node
     */
    function findPostContainer(target) {
      let element = target instanceof Element ? target : target?.parentElement;
      if (!element) return null;
      const semantic = outerOwningPostContainer(element.closest(semanticPostSelector));
      if (semantic && findPostUrl(semantic)) return semantic;

      const candidates = [];
      let targetPostId = "";
      const targetLink = element.closest("a[href]");
      if (targetLink && isPostLink(targetLink.href)) {
        targetPostId = S.parseThreadsUrl(targetLink.href).postId;
      }
      for (let depth = 0; element && depth < 16; depth += 1, element = element.parentElement) {
        if (element === document.body || element === document.documentElement) break;
        const descriptor = describePostContainer(element, depth);
        if (!descriptor?.directPostId) continue;
        targetPostId ||= descriptor.directPostId;
        if (descriptor.directPostId === targetPostId) candidates.push(descriptor);
      }
      return S.choosePostCandidate(candidates, targetPostId)?.container ?? null;
    }

    function isNestedEmbeddedPostContainer(/** @type {Element} */ container) {
      if (!(container instanceof Element)) return false;
      const parent = container.parentElement?.closest(semanticPostSelector);
      if (!parent) return false;
      const ownPostId = buildPostScope(container)?.postId ?? "";
      const parentPostId = buildPostScope(parent)?.postId ?? "";
      return Boolean(ownPostId && parentPostId && ownPostId !== parentPostId);
    }

    function outerOwningPostContainer(/** @type {Element} */ container) {
      let current = container;
      while (current instanceof Element) {
        const parent = current.parentElement?.closest(semanticPostSelector);
        if (!parent) break;
        const ownPostId = buildPostScope(current)?.postId ?? "";
        const parentPostId = buildPostScope(parent)?.postId ?? "";
        if (!ownPostId || !parentPostId || ownPostId === parentPostId) break;
        current = parent;
      }
      return current;
    }

    /**
     * The permalink of the post a container holds, or "".
     * @param {Element} container
     */
    function findPostUrl(container) {
      if (!(container instanceof Element)) return "";
      return buildPostScope(container)?.sourceUrl ?? "";
    }

    /**
     * Posts quoted or embedded inside a container, as { postId, sourceUrl }, excluding the container's own post.
     * @param {Element} container
     */
    function extractQuotedPosts(container) {
      const scope = buildPostScope(container);
      if (!scope?.excludedRoots?.length) return [];

      const quotedPosts = [];
      const seen = new Set();
      for (const excludedRoot of scope.excludedRoots) {
        const anchors = [
          ...(excludedRoot.matches?.("a[href]") ? [excludedRoot] : []),
          ...excludedRoot.querySelectorAll("a[href]")
        ].filter(anchor => isPostLink(anchor.href));
        if (!anchors.length) continue;

        const timeAnchors = [...excludedRoot.querySelectorAll("time")]
          .map(node => node.closest("a[href]"))
          .filter(anchor => anchor && isPostLink(anchor.href));
        const anchor = chooseDirectPostAnchor(excludedRoot, timeAnchors.length ? timeAnchors : anchors);
        const parsed = S.parseThreadsUrl(anchor?.href || "");
        if (!parsed.postId || parsed.postId === scope.postId || seen.has(parsed.postId)) continue;
        seen.add(parsed.postId);
        quotedPosts.push({ postId: parsed.postId, sourceUrl: parsed.normalized });
      }
      return quotedPosts;
    }

    /**
     * Works out which post a container is: its permalink, the post ids linked inside it, and the elements that
     * belong to other (quoted) posts and must be left out. Cached per container; null when it holds no post link.
     * @param {Element} container
     */
    function buildPostScope(container) {
      if (!(container instanceof Element)) return null;
      const cached = postScopeCache.get(container);
      if (cached) return cached;

      const links = [...container.querySelectorAll("a[href]")].filter(anchor => isPostLink(anchor.href));
      if (!links.length) return null;
      const timeLinks = [...container.querySelectorAll("time")]
        .map(node => node.closest("a[href]"))
        .filter(anchor => anchor && isPostLink(anchor.href));
      const candidates = timeLinks.length ? timeLinks : links;
      const directAnchor = chooseDirectPostAnchor(container, candidates);
      if (!directAnchor) return null;
      const direct = S.parseThreadsUrl(directAnchor.href);
      if (!direct.postId) return null;

      const postIds = [...new Set(links.map(link => S.parseThreadsUrl(link.href).postId).filter(Boolean))];
      if (!postIds.includes(direct.postId)) postIds.unshift(direct.postId);
      const excludedPostIds = postIds.filter(postId => postId !== direct.postId);
      const excludedRoots = findEmbeddedPostRoots(container, directAnchor, direct.postId, links);
      const scope = {
        sourceUrl: direct.normalized,
        postId: direct.postId,
        directAnchor,
        postIds,
        excludedPostIds,
        excludedRoots
      };
      postScopeCache.set(container, scope);
      return scope;
    }

    function chooseDirectPostAnchor(/** @type {Element} */ container, /** @type {any} */ anchors) {
      const semantic = container.matches(semanticPostSelector) ? container : null;
      const uniqueAnchors = [...new Set(anchors)];
      return uniqueAnchors.sort((left, right) => {
        const leftNested = semantic && left.closest(semanticPostSelector) !== semantic ? 1 : 0;
        const rightNested = semantic && right.closest(semanticPostSelector) !== semantic ? 1 : 0;
        if (leftNested !== rightNested) return leftNested - rightNested;
        const leftEmbedded = isAnchorInsideEmbeddedPressableCard(left, container, uniqueAnchors) ? 1 : 0;
        const rightEmbedded = isAnchorInsideEmbeddedPressableCard(right, container, uniqueAnchors) ? 1 : 0;
        if (leftEmbedded !== rightEmbedded) return leftEmbedded - rightEmbedded;
        const auxiliaryDifference = postAnchorSuffixDepth(left) - postAnchorSuffixDepth(right);
        if (auxiliaryDifference) return auxiliaryDifference;
        const depthDifference = elementDepth(left, container) - elementDepth(right, container);
        if (depthDifference) return depthDifference;
        const order = left.compareDocumentPosition(right);
        return order & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })[0] ?? null;
    }

    function isAnchorInsideEmbeddedPressableCard(/** @type {Element} */ anchor, /** @type {Element} */ container, /** @type {any} */ anchors) {
      let card = anchor.closest("[data-pressable-container='true']");
      while (card && card !== container && container.contains(card)) {
        const hasPostAnchorOutside = anchors.some((/** @type {any} */ other) => other !== anchor && !/** @type {Element} */ (card).contains(other));
        if (hasPostAnchorOutside) return true;
        card = card.parentElement?.closest("[data-pressable-container='true']") ?? null;
      }
      return false;
    }

    /**
     * How many path segments follow /post/<id> in a link (0 for the post itself, more for /media and similar).
     * @param {Element} anchor
     */
    function postAnchorSuffixDepth(anchor) {
      try {
        const url = new URL(anchor.href, location.href);
        const match = url.pathname.match(/\/(?:post|t)\/[^/]+(\/.*)?$/i);
        return match?.[1] ? match[1].split("/").filter(Boolean).length : 0;
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    }

    function elementDepth(/** @type {Element} */ node, /** @type {any} */ boundary) {
      let depth = 0;
      for (let /** @type {Element | null} */ current = node; current && current !== boundary; current = current.parentElement) depth += 1;
      return depth;
    }

    function findEmbeddedPostRoots(/** @type {Element} */ container, /** @type {any} */ directAnchor, /** @type {any} */ directPostId, /** @type {any} */ links) {
      const roots = /** @type {any[]} */ ([]);
      for (const link of links) {
        const postId = S.parseThreadsUrl(link.href).postId;
        if (!postId || postId === directPostId) continue;
        let embeddedRoot = link.closest(semanticPostSelector);
        if (!isValidEmbeddedPostRoot(embeddedRoot, container, directAnchor)) embeddedRoot = null;
        if (!embeddedRoot) embeddedRoot = findPressableEmbeddedCard(link, container, directAnchor, postId);
        if (!embeddedRoot) {
          embeddedRoot = link.closest("blockquote");
          if (!isValidEmbeddedPostRoot(embeddedRoot, container, directAnchor)) embeddedRoot = null;
        }
        if (!embeddedRoot) {
          embeddedRoot = link.closest("[role='link']");
          if (!isValidEmbeddedPostRoot(embeddedRoot, container, directAnchor)) embeddedRoot = null;
        }
        if (!embeddedRoot) embeddedRoot = smallestEmbeddedCard(link, container, directAnchor);
        if (!isValidEmbeddedPostRoot(embeddedRoot, container, directAnchor)) continue;
        addEmbeddedPostRoot(roots, embeddedRoot);
      }
      return roots;
    }

    function findPressableEmbeddedCard(/** @type {any} */ link, /** @type {Element} */ container, /** @type {any} */ directAnchor, /** @type {any} */ embeddedPostId) {
      let card = link.closest("[data-pressable-container='true']");
      let best = null;
      while (card && card !== container && container.contains(card)) {
        if (card.contains(directAnchor)) break;
        const containsEmbeddedPermalink = [...card.querySelectorAll("a[href]")].some(anchor => {
          return S.parseThreadsUrl(anchor.href).postId === embeddedPostId;
        });
        if (containsEmbeddedPermalink && isValidEmbeddedPostRoot(card, container, directAnchor)) best = card;
        card = card.parentElement?.closest("[data-pressable-container='true']") ?? null;
      }
      return best;
    }

    function isValidEmbeddedPostRoot(/** @type {any} */ embeddedRoot, /** @type {Element} */ container, /** @type {any} */ directAnchor) {
      if (!(embeddedRoot instanceof Element) || embeddedRoot === container || !container.contains(embeddedRoot)) return false;
      if (embeddedRoot.contains(directAnchor)) return false;
      return Boolean(embeddedRoot.matches("[dir='auto'], img") || embeddedRoot.querySelector("[dir='auto'], img"));
    }

    function addEmbeddedPostRoot(/** @type {any} */ roots, /** @type {any} */ embeddedRoot) {
      for (let index = roots.length - 1; index >= 0; index -= 1) {
        if (embeddedRoot.contains(roots[index])) roots.splice(index, 1);
      }
      if (!roots.some((/** @type {any} */ existing) => existing === embeddedRoot || existing.contains(embeddedRoot))) roots.push(embeddedRoot);
    }

    function smallestEmbeddedCard(/** @type {any} */ link, /** @type {Element} */ container, /** @type {any} */ directAnchor) {
      let current = link;
      const embeddedAuthor = S.parseThreadsUrl(link.href).handle;
      for (let depth = 0; current?.parentElement && depth < 7; depth += 1) {
        current = current.parentElement;
        if (current === container || current.contains(directAnchor)) break;
        if (hasEmbeddedBodyEvidence(current, link, embeddedAuthor)) return current;
      }
      return link;
    }

    function hasEmbeddedBodyEvidence(/** @type {Element} */ container, /** @type {any} */ sourceLink, /** @type {any} */ author) {
      const extractors = getExtractors();
      const textEvidence = [...container.querySelectorAll("[dir='auto']")].some(node => {
        if (sourceLink.contains(node) || node.closest(profileInfoSelector) || node.closest("time")) return false;
        if (node.querySelector("[dir='auto']")) return false;
        // A quote card's text follows its permalink. Text before the link belongs to the post that holds the
        // card (a reshared video's link sits under the post's own text), so it is no sign of a quote card.
        if (node.compareDocumentPosition(sourceLink) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
        const text = S.cleanText(node.innerText || node.textContent);
        return Boolean(text && !S.isThreadsUiText(text, author) && !extractors.isThreadPositionElement(node));
      });
      if (textEvidence) return true;
      return [...container.querySelectorAll("img")].some(image => {
        if (sourceLink.contains(image) || image.closest(profileInfoSelector)) return false;
        const alt = S.cleanText(image.getAttribute("alt") || "");
        if (avatarAltPattern.test(alt)) return false;
        const rect = image.getBoundingClientRect();
        return image.naturalWidth >= 300 || image.naturalHeight >= 300 || rect.width >= 120 || rect.height >= 120;
      });
    }

    // True when every other post linked inside this container sits in its own quote card
    // (a nested pressable card), and this container is the post's own card rather than an
    // ancestor that also holds sibling posts.
    function embeddedPostsContained(/** @type {Element} */ container, /** @type {any} */ scope) {
      if (!scope?.excludedPostIds?.length) return false;
      const ownCard = scope.directAnchor.closest("[data-pressable-container='true']");
      if (ownCard && ownCard !== container && container.contains(ownCard)) return false;
      // In the post's own card, another post's link need not sit in a quote card: a reshared video carries
      // only a link to the original under its text. Anywhere else the other post must be in a quote card.
      const quoteCards = ownCard === container
        ? scope.excludedRoots
        : scope.excludedRoots.filter((/** @type {Element} */ root) => root.matches("[data-pressable-container='true']"));
      if (!quoteCards.length) return false;
      return [...container.querySelectorAll("a[href]")].every(anchor => {
        const postId = isPostLink(anchor.href) ? S.parseThreadsUrl(anchor.href).postId : "";
        if (!postId || postId === scope.postId) return true;
        return quoteCards.some((/** @type {any} */ card) => card.contains(anchor));
      });
    }

    /**
     * Scores a candidate container for one post: its ids, whether it is a semantic or own card, visibility, and how
     * much text and media it holds. Used to pick the best container per post. Null when it holds no post.
     * @param {Element} container
     * @param {number} [documentOrder]
     */
    function describePostContainer(container, documentOrder = 0) {
      if (!(container instanceof Element)) return null;
      const extractors = getExtractors();
      const scope = buildPostScope(container);
      const sourceUrl = scope?.sourceUrl ?? "";
      const directPostId = scope?.postId ?? "";
      if (!directPostId) return null;
      const semantic = container.matches(semanticPostSelector);
      const nestedPostCount = container.querySelectorAll(semanticPostSelector).length;
      const author = S.parseThreadsUrl(sourceUrl).handle;
      const textEvidenceLength = extractors.ownAutoTextNodes(container)
        .filter((/** @type {Element} */ node) => !extractors.isExcludedTextNode(node, container, author))
        .reduce((/** @type {any} */ total, /** @type {Element} */ node) => total + extractors.cleanPostTextCandidate(node.innerText || node.textContent, author).length, 0);
      const mediaEvidenceCount = extractors.extractPostMedia(container).length;
      return {
        container,
        directPostId,
        postIds: scope.postIds,
        excludedPostIds: scope.excludedPostIds,
        embeddedPostsContained: embeddedPostsContained(container, scope),
        ownCard: scope.directAnchor.closest("[data-pressable-container='true']") === container,
        semantic,
        nestedPostCount,
        connected: container.isConnected,
        visible: extractors.isVisible(container),
        hasTextEvidence: textEvidenceLength > 0,
        textEvidenceLength,
        mediaEvidenceCount,
        nodeCount: container.querySelectorAll("*").length,
        // A wrapper that holds the site's navigation or footer is the page, not the post; its menu and
        // footer text must never be saved as the post.
        containsPageChrome: Boolean(container.querySelector(PAGE_CHROME_SELECTOR)),
        documentOrder
      };
    }

    /**
     * The container in `containers` whose post has this id, or null.
     * @param {Element[]} containers
     * @param {string} postId
     */
    function findContainerInListByPostId(containers, postId) {
      return (containers ?? []).find((/** @type {Element} */ container) => S.parseThreadsUrl(findPostUrl(container)).postId === postId) ?? null;
    }

    /**
     * The best container on the page for the post with this id, or null.
     * @param {string} postId
     */
    function findCanonicalContainerByPostId(postId) {
      return findContainerInListByPostId(collectPostContainers(), postId);
    }

    /**
     * Throws when the page has navigated since `expectedRoute` was read, so posts from two pages never mix.
     * @param {string} expectedRoute from currentRouteSignature()
     */
    function ensureRouteUnchanged(expectedRoute) {
      if (currentRouteSignature() !== expectedRoute) {
        throw new Error(S.t("Threads 頁面已切換，為避免混入其他貼文，本次保存已取消"));
      }
    }

    /**
     * True for a Threads post permalink.
     * @param {string} value a URL, relative or absolute
     */
    function isPostLink(value) {
      try {
        const url = new URL(value, location.href);
        return S.isThreadsUrl(url.href) && postLinkPattern.test(url.pathname);
      } catch {
        return false;
      }
    }

    return {
      buildPostScope,
      collectPostContainers,
      describePostContainer,
      ensureRouteUnchanged,
      extractQuotedPosts,
      findCanonicalContainerByPostId,
      findContainerInListByPostId,
      findPostContainer,
      findPostUrl,
      isPostLink,
      postAnchorSuffixDepth,
      resetCache
    };
  }

  return { createDomScope };
});
