/**
 * Threads capture flows: the current thread, the post under the cursor, and a text selection.
 * Combines dom-scope and dom-extract, checks the route did not change mid-capture, and returns a raw
 * capture for the worker to normalize (model/capture-model.js).
 */
(function initializeSavourPageCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourPageCapture = api;
})(globalThis, function createSavourPageCaptureModule() {
  "use strict";

  /**
   * Builds the Threads capture flows from dom-scope (`options.scope`), dom-extract (`options.extract`) and the
   * helpers in threads-content.js (`options.getHelpers()`, read lazily because they are created later).
   */
  function createPageCapture(/** @type {any} */ options) {
    const S = options.shared;
    const {
      collectPostContainers,
      ensureRouteUnchanged,
      findCanonicalContainerByPostId,
      findContainerInListByPostId,
      findPostContainer
    } = options.scope;
    const { extractPost } = options.extract;

    /**
     * Captures the selected text, with the author, URL and date of the post it sits in when that post can be verified.
     * Throws when nothing is selected.
     * @param {string} selectionText the context menu's copy of the selection, used when the page has none
     */
    function captureSelection(selectionText) {
      // The page's own selection keeps line breaks; the context menu's selectionText flattens them.
      const selection = S.cleanText(window.getSelection()?.toString() || selectionText || "");
      if (!selection) throw new Error(S.t("請先選取想保存的文字"));
      const container = findPostContainer(window.getSelection()?.anchorNode?.parentElement);
      let base = null;
      try {
        base = container ? extractPost(container) : null;
      } catch {
        // Selection text remains safe to save even when the surrounding post card cannot be verified.
      }
      const current = S.parseThreadsUrl(location.href);
      return {
        captureType: "selection",
        text: selection,
        links: selectionLinks(),
        sourceUrl: base?.sourceUrl || current.normalized,
        author: base?.author || current.handle,
        publishedAt: base?.publishedAt || "",
        continuations: /** @type {any[]} */ ([]),
        titleHint: document.title
      };
    }

    function selectionLinks() {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return [];
      const range = selection.getRangeAt(0);
      const anchors = [...range.cloneContents().querySelectorAll("a[href]")];
      const ancestor = range.commonAncestorContainer;
      const wrapping = (ancestor instanceof Element ? ancestor : ancestor?.parentElement)?.closest("a[href]");
      if (wrapping) anchors.push(wrapping);
      return S.normalizeLinks(anchors.map(anchor => ({
        text: anchor === wrapping ? selection.toString() : anchor.textContent,
        url: anchor.href
      })));
    }

    /**
     * Captures the post the URL points to and, unless turned off, the author's later posts in the thread and
     * their replies under it. Marks the capture 串文未完整 when parts of the thread could not be read.
     * @param {boolean} [includeContinuations]
     */
    async function captureCurrentThread(includeContinuations = true) {
      const {
        assertMeaningfulCapture,
        buildStructuredAuthorReplyRecords,
        buildStructuredContinuationRecords,
        collectContinuationRecords,
        collectCurrentThreadRelationshipEntries,
        currentRouteSignature,
        enrichWithLongText,
        expandVisibleText,
        isMeaningfulEntry,
        mergeContinuationRecords,
        mergeStructuredRootEntry
      } = options.getHelpers();
      const routeAtStart = currentRouteSignature();
      const current = S.parseThreadsUrl(location.href);
      if (!current.postId) throw new Error(S.t("請先開啟一篇 Threads 單篇貼文再保存"));

      let containers = collectPostContainers();
      let rootContainer = findContainerInListByPostId(containers, current.postId);
      if (!rootContainer) throw new Error(S.t("找不到目前網址所對應的貼文內容，請等待載入後再試一次"));

      await expandVisibleText(rootContainer, () => currentRouteSignature() === routeAtStart);
      ensureRouteUnchanged(routeAtStart);
      // Opening "more" can make Threads draw the post again, so the old element is gone and the new one
      // may be empty for a moment; wait until the post holds its content again before reading it.
      const settleDeadline = Date.now() + 4000;
      for (;;) {
        containers = collectPostContainers();
        rootContainer = findContainerInListByPostId(containers, current.postId);
        const entry = rootContainer ? extractPost(rootContainer, { expectedPostId: current.postId }) : null;
        if (entry && isMeaningfulEntry(entry)) break;
        if (Date.now() >= settleDeadline) break;
        await S.sleep(150);
        ensureRouteUnchanged(routeAtStart);
      }
      if (!rootContainer) throw new Error(S.t("貼文載入期間結構已改變，請重新嘗試保存"));

      const root = extractPost(rootContainer, { expectedPostId: current.postId });
      if (!root) throw new Error(S.t("無法辨識目前文章的主貼文"));
      const relationshipEntries = includeContinuations
        ? collectCurrentThreadRelationshipEntries()
        : [];
      ensureRouteUnchanged(routeAtStart);
      mergeStructuredRootEntry(root, relationshipEntries);
      const relationshipByPostId = new Map(relationshipEntries.map((/** @type {any} */ entry) => [entry.postId, entry]));
      const domFollowupRecords = includeContinuations
        ? collectContinuationRecords(containers, rootContainer, root, {
          allowExpandableEmpty: true,
          relationshipByPostId
        })
        : { continuations: [], authorReplies: [] };
      const structuredRecords = includeContinuations
        ? buildStructuredContinuationRecords(relationshipEntries, root)
        : [];
      const structuredAuthorReplyRecords = includeContinuations
        ? buildStructuredAuthorReplyRecords(relationshipEntries, root)
        : [];
      const continuationCandidates = mergeContinuationRecords(
        domFollowupRecords.continuations,
        structuredRecords
      );
      const orderedContinuations = S.orderThreadEntries(continuationCandidates, root.threadPosition);
      if (includeContinuations && S.parseThreadPosition(root.threadPosition) && !orderedContinuations.complete) {
        root.reviewFlags = S.normalizeReviewFlags([...(root.reviewFlags ?? []), "串文未完整"]);
        // After in-site navigation the page may only carry data for the previous URL. Said only when parts
        // are missing: a thread read completely from the page needs no warning.
        if (!relationshipEntries.length) {
          root.captureNotes = [S.t("這頁沒有讀到串文結構資料，串文或作者補充可能不完整。若結果缺漏，請重新整理這頁後再保存一次。")];
        }
      }

      const captureGuard = createManualCaptureGuard(current.postId, rootContainer);
      await enrichWithLongText(root, root.sourceUrl, rootContainer, captureGuard);
      const continuations = [];
      for (const record of orderedContinuations.ordered) {
        if (!record.structuredTextUsed) {
          await enrichWithLongText(record.entry, record.entry.sourceUrl, record.container, captureGuard);
        }
        if (!isMeaningfulEntry(record.entry)) {
          root.reviewFlags = S.normalizeReviewFlags([...(root.reviewFlags ?? []), "串文未完整"]);
          break;
        }
        continuations.push(record.entry);
      }
      const continuationPostIds = new Set(continuations
        .map(entry => S.parseThreadsUrl(entry?.sourceUrl || "").postId)
        .filter(Boolean));
      const authorReplyCandidates = mergeContinuationRecords(
        domFollowupRecords.authorReplies,
        structuredAuthorReplyRecords
      );
      const authorReplies = [];
      for (const record of authorReplyCandidates) {
        const postId = S.parseThreadsUrl(record.entry?.sourceUrl || "").postId;
        if (postId && continuationPostIds.has(postId)) continue;
        await enrichWithLongText(record.entry, record.entry.sourceUrl, record.container, captureGuard);
        if (isMeaningfulEntry(record.entry)) authorReplies.push(record.entry);
      }
      root.continuations = continuations;
      root.authorReplies = authorReplies;
      assertMeaningfulCapture(root);
      return root;
    }

    /**
     * Returns a check for long-running reads: true while the user is still on this post (or a dialog of it is open),
     * false once they have been somewhere else for three seconds.
     * @param {string} rootPostId
     * @param {Element} initialContainer
     */
    function createManualCaptureGuard(rootPostId, initialContainer) {
      let knownContainer = initialContainer;
      let missingSince = 0;
      return () => {
        const currentPostId = S.parseThreadsUrl(location.href).postId;
        const dialogVisible = Boolean(options.getHelpers().findVisibleDialog());
        if (!knownContainer?.isConnected) {
          knownContainer = findCanonicalContainerByPostId(rootPostId);
        }
        if (!currentPostId || currentPostId === rootPostId || knownContainer?.isConnected || dialogVisible) {
          missingSince = 0;
          return true;
        }
        const now = Date.now();
        if (!missingSince) missingSince = now;
        return now - missingSince < 3000;
      };
    }

    return { captureCurrentThread, captureSelection, createManualCaptureGuard };
  }

  return { createPageCapture };
});
