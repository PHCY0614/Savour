/**
 * Content script for Threads pages: reads the post on screen and sends it to the background worker.
 *
 * Wires the DOM modules in content/ (scope, extract, legacy discussion, page capture) together and
 * answers the worker's capture messages. Other sites have their own scripts:
 * content/x-capture.js, instagram-content.js, plurk-content.js and web-content.js.
 *
 * Only runs a capture when the user asks for one; it does not scan pages on its own.
 */
(function initializeSavourContent() {
  "use strict";

  const S = globalThis.SavourShared;
  /** @type {any} */
  const T = globalThis.SavourToast
    || (typeof module === "object" && module.exports ? require("./toast.js") : null);
  /** @type {any} */
  const DS = globalThis.SavourDomScope
    || (typeof module === "object" && module.exports ? require("./dom-scope.js") : null);
  /** @type {any} */
  const DE = globalThis.SavourDomExtract
    || (typeof module === "object" && module.exports ? require("./dom-extract.js") : null);
  /** @type {any} */
  const LDOM = globalThis.SavourLegacyDiscussionDom
    || (typeof module === "object" && module.exports ? require("./legacy-discussion-dom.js") : null);
  /** @type {any} */
  const LDD = globalThis.SavourLegacyDiscussionData
    || (typeof module === "object" && module.exports ? require("./legacy-discussion-data.js") : null);
  /** @type {any} */
  const PC = globalThis.SavourPageCapture
    || (typeof module === "object" && module.exports ? require("./page-capture.js") : null);
  if (!S || !T || !DS || !DE || !LDOM || !LDD || !PC) return;
  const { showToast } = T;

  const SEMANTIC_POST_SELECTOR = "article, [role='article']";
  const POST_LINK_PATTERN = /\/(?:@[^/]+\/)?(?:post|t)\/[^/?#]+/i;
  const LONG_TEXT_CONTROL_PATTERN = /(?:read more|view more|continue reading|read (?:the )?full text|view (?:the )?full text|see (?:the )?full text|open text attachment|閱讀更多|繼續閱讀|閱讀全文|閱讀完整內容|查看全文|查看完整內容|顯示全文|顯示完整內容|展開全文|展開完整內容|開啟長文)/i;
  const CLOSE_CONTROL_PATTERN = /^(?:close(?: dialog| modal)?|back|done|關閉(?:視窗|對話框)?|返回|完成)$/i;
  const TOPIC_LABEL_PATTERN = /^(?:threads\s*)?(?:topic(?: tag)?|主題標籤|主題)\s*[：:]\s*(.+)$/i;
  const AVATAR_ALT_PATTERN = /(?:profile (?:photo|picture)|avatar|大頭貼|個人檔案相片|頭像)/i;
  const PROFILE_INFO_SELECTOR = ".threads-profile-info-badge";
  const PROFILE_TIMELINE_SELECTOR = "[data-pagelet^='threads_profile_posts_timeline_']";
  const CAPTURE_VALIDATION_VERSION = 2;
  const NODE_TEST_RUNTIME = typeof module === "object" && module.exports;
  // Assigned after DomScope exists because the two modules need each other lazily (see getExtractors).
  // eslint-disable-next-line prefer-const
  /** @type {any} */ let DomExtract;
  const DomScope = DS.createDomScope({
    shared: S,
    semanticPostSelector: SEMANTIC_POST_SELECTOR,
    postLinkPattern: POST_LINK_PATTERN,
    profileInfoSelector: PROFILE_INFO_SELECTOR,
    avatarAltPattern: AVATAR_ALT_PATTERN,
    currentRouteSignature: () => currentRouteSignature(),
    getExtractors: () => ({ ...DomExtract, isVisible })
  });
  const {
    buildPostScope,
    collectPostContainers,
    extractQuotedPosts,
    findCanonicalContainerByPostId,
    findContainerInListByPostId,
    findPostContainer,
    findPostUrl,
    isPostLink
  } = DomScope;
  DomExtract = DE.createDomExtract({
    shared: S,
    scope: DomScope,
    semanticPostSelector: SEMANTIC_POST_SELECTOR,
    longTextControlPattern: LONG_TEXT_CONTROL_PATTERN,
    topicLabelPattern: TOPIC_LABEL_PATTERN,
    avatarAltPattern: AVATAR_ALT_PATTERN,
    profileInfoSelector: PROFILE_INFO_SELECTOR,
    profileTimelineSelector: PROFILE_TIMELINE_SELECTOR,
    captureValidationVersion: CAPTURE_VALIDATION_VERSION,
    getHelpers: () => ({ addLongText, isUiText, isVisible })
  });
  const {
    belongsToPostContainer,
    extractHiddenLongTexts,
    extractPost,
    extractPostMedia,
    extractThreadPosition,
    mediaUrlKey
  } = DomExtract;

  let routeSignature = currentRouteSignature();
  const LegacyDiscussionDom = LDOM.createLegacyDiscussionDom({
    shared: S,
    scope: DomScope,
    extract: DomExtract,
    profileInfoSelector: PROFILE_INFO_SELECTOR
  });
  const { findDiscussionPermalinkByPostId } = LegacyDiscussionDom;
  const LegacyDiscussionData = LDD.createLegacyDiscussionData({
    shared: S,
    getHelpers: () => ({ findDiscussionPermalinkByPostId, mergeQuotedPosts })
  });
  const {
    collectCurrentThreadRelationshipEntries,
    mergeStructuredRootEntry
  } = LegacyDiscussionData;
  const PageCapture = PC.createPageCapture({
    shared: S,
    scope: DomScope,
    extract: DomExtract,
    getHelpers: () => ({
      assertMeaningfulCapture,
      buildStructuredAuthorReplyRecords,
      buildStructuredContinuationRecords,
      collectContinuationRecords,
      collectCurrentThreadRelationshipEntries,
      currentRouteSignature,
      enrichWithLongText,
      expandVisibleText,
      findVisibleDialog,
      isMeaningfulEntry,
      mergeContinuationRecords,
      mergeStructuredRootEntry
    })
  });
  const { captureCurrentThread, captureSelection } = PageCapture;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve(handleMessage(message))
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  async function handleMessage(/** @type {any} */ message) {
    // The background sends the interface language with every message.
    globalThis.SavourI18n?.setLanguage(message?.lang);
    // Lets the background tell whether this script is loaded, without touching the page.
    if (message?.type === "PING") return { ready: true };
    DomScope.resetCache();
    refreshRouteState();
    // Watch the page only while a user-triggered capture is running.
    startCaptureObserver();
    try {
      return await runMessage(message);
    } finally {
      stopCaptureObserver();
    }
  }

  async function runMessage(/** @type {any} */ message) {
    switch (message?.type) {
      case "CAPTURE_SELECTION":
        return captureSelection(message.selectionText);
      case "CAPTURE_CURRENT_THREAD":
        return captureCurrentThread(message.includeContinuations !== false);
      case "GET_PAGE_DATA_STATUS":
        return pageDataStatus();
      case "WAIT_FOR_POST":
        return waitForCurrentPost();
      case "SHOW_TOAST":
        showToast(message.message, message.tone);
        return { shown: true };
      default:
        throw new Error(S.t("頁面不支援這個擷取操作"));
    }
  }

  // Threads embeds thread data only for the URL the document was loaded with. After in-site
  // navigation that data belongs to an earlier page, so replies and supplements can be missing.
  function pageDataStatus() {
    const loadedUrl = performance.getEntriesByType?.("navigation")?.[0]?.name || "";
    const currentPostId = S.parseThreadsUrl(location.href).postId;
    // Unknown load URL means we cannot tell; never reload on a guess.
    if (!loadedUrl || !currentPostId) return { stale: false };
    return { stale: S.parseThreadsUrl(loadedUrl).postId !== currentPostId };
  }

  async function waitForCurrentPost(timeoutMs = 15000) {
    const postId = S.parseThreadsUrl(location.href).postId;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      DomScope.resetCache();
      if (postId && findContainerInListByPostId(collectPostContainers(), postId)) return { ready: true };
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return { ready: false };
  }

  function currentRouteSignature() {
    return S.normalizeThreadsUrl(location.href);
  }

  function refreshRouteState() {
    const next = currentRouteSignature();
    if (next === routeSignature) return false;
    routeSignature = next;
    DomScope.resetCache();
    return true;
  }

  function collectContinuationRecords(/** @type {any} */ containers, /** @type {any} */ rootContainer, /** @type {any} */ root, /** @type {any} */ options = {}) {
    const rootIndex = containers.indexOf(rootContainer);
    if (rootIndex < 0) return { continuations: [], authorReplies: [] };
    const following = containers.slice(rootIndex + 1);
    const targetAuthor = root.author || S.parseThreadsUrl(root.sourceUrl).handle;
    const rootPosition = S.parseThreadPosition(root?.threadPosition) || extractThreadPosition(rootContainer);
    const numberedRecords = [];
    const authorReplyRecords = [];
    const seenPostIds = new Set([S.parseThreadsUrl(root.sourceUrl).postId].filter(Boolean));

    for (const container of following.slice(0, 250)) {
      if (hasConversationBoundaryBetween(rootContainer, container)) break;
      const sourceUrl = findPostUrl(container);
      const parsed = S.parseThreadsUrl(sourceUrl);
      if (!parsed.postId || seenPostIds.has(parsed.postId)) continue;
      const relationship = options.relationshipByPostId?.get(parsed.postId);
      const position = extractThreadPosition(container)
        || S.parseThreadPosition(relationship?.threadPosition);

      if (
        rootPosition
        && position?.total === rootPosition.total
        && position.index > rootPosition.index
        && parsed.handle === targetAuthor
      ) {
        let item;
        try {
          item = extractPost(container, { expectedPostId: parsed.postId });
        } catch {
          continue;
        }
        if (!item || (!isMeaningfulEntry(item) && !(options.allowExpandableEmpty && findLongTextControls(container).length))) {
          continue;
        }
        seenPostIds.add(parsed.postId);
        numberedRecords.push(buildContinuationRecord(item, container));
        continue;
      }

      if (position) continue;
      if (parsed.handle === targetAuthor) {
        const isDirectAuthorReply = S.isDirectAuthorSupplement(relationship, targetAuthor);
        if (!isDirectAuthorReply) continue;
        let item;
        try {
          item = extractPost(container, { expectedPostId: parsed.postId });
        } catch {
          continue;
        }
        if (!item || (!isMeaningfulEntry(item) && !(options.allowExpandableEmpty && findLongTextControls(container).length))) {
          continue;
        }
        seenPostIds.add(parsed.postId);
        authorReplyRecords.push(buildContinuationRecord(item, container));
      }
    }

    return { continuations: numberedRecords, authorReplies: authorReplyRecords };
  }

  function hasConversationBoundaryBetween(/** @type {any} */ left, /** @type {any} */ right) {
    if (!(left instanceof Element) || !(right instanceof Element)) return false;
    return [...document.querySelectorAll("h1, h2, h3, [dir='auto']")].some(node => {
      if (left.contains(node) || right.contains(node)) return false;
      const text = S.cleanText(node.innerText || node.textContent).replace(/\s+/g, " ");
      if (!/^(?:推薦(?:貼文|內容)?|為你推薦|suggested(?: posts?)?)$/i.test(text)) return false;
      return Boolean(left.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
        && Boolean(node.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  }

  function buildContinuationRecord(/** @type {any} */ item, /** @type {Element} */ container) {
    const entry = {
      text: item.text,
      sourceUrl: item.sourceUrl,
      author: item.author,
      publishedAt: item.publishedAt,
      topicTag: item.topicTag,
      threadPosition: item.threadPosition,
      reviewFlags: item.reviewFlags ?? [],
      media: item.media ?? [],
      quotedPosts: item.quotedPosts ?? [],
      links: item.links ?? [],
      linkCards: item.linkCards ?? [],
      longTextAttachments: item.longTextAttachments ?? [],
      captureValidation: item.captureValidation
    };
    return {
      entry,
      container
    };
  }

  function buildStructuredContinuationRecords(/** @type {any} */ entries, /** @type {any} */ root) {
    const rootPostId = S.parseThreadsUrl(root?.sourceUrl).postId;
    return S.structuredThreadEntries(entries, root?.author, root?.threadPosition)
      .map((/** @type {any} */ item) => {
        const sourceUrl = S.normalizeThreadsUrl(item.sourceUrl);
        const parsed = S.parseThreadsUrl(sourceUrl);
        if (!rootPostId || !parsed.postId || parsed.postId !== item.postId || parsed.handle !== root.author) {
          return null;
        }
        return {
          entry: {
            text: item.text,
            sourceUrl,
            author: parsed.handle,
            publishedAt: item.publishedAt || "",
            topicTag: "",
            threadPosition: item.threadPosition,
            reviewFlags: /** @type {any[]} */ ([]),
            media: /** @type {any[]} */ ([]),
            quotedPosts: item.quotedPosts ?? [],
            links: item.links ?? [],
            linkCards: item.linkCards ?? [],
            longTextAttachments: /** @type {any[]} */ ([]),
            captureValidation: {
              version: CAPTURE_VALIDATION_VERSION,
              source: "page-json",
              rootPostId,
              postId: parsed.postId,
              containerPostIds: [parsed.postId],
              excludedPostIds: /** @type {any[]} */ ([]),
              validated: true
            }
          },
          container: findCanonicalContainerByPostId(parsed.postId),
          structuredTextUsed: true
        };
      })
      .filter(Boolean);
  }

  function buildStructuredAuthorReplyRecords(/** @type {any} */ entries, /** @type {any} */ root) {
    const rootPostId = S.parseThreadsUrl(root?.sourceUrl).postId;
    const rootAuthor = S.cleanHandle(root?.author);
    if (!rootPostId || !rootAuthor) return [];

    return (entries ?? []).map((/** @type {any} */ item) => {
      const sourceUrl = S.normalizeThreadsUrl(item?.sourceUrl || "");
      const parsed = S.parseThreadsUrl(sourceUrl);
      const split = S.splitTrailingThreadPosition(item?.text);
      const threadPosition = S.normalizeThreadPosition(item?.threadPosition) || split.threadPosition;
      const directAuthorSupplement = (
        parsed.postId
        && parsed.postId !== rootPostId
        && parsed.postId === item?.postId
        && parsed.handle === rootAuthor
        && S.isDirectAuthorSupplement(item, rootAuthor)
        && !threadPosition
      );
      if (!directAuthorSupplement || (!split.text && !item?.quotedPosts?.length)) return null;

      return {
        entry: {
          text: split.text,
          sourceUrl,
          author: parsed.handle,
          publishedAt: item.publishedAt || "",
          topicTag: "",
          threadPosition: "",
          reviewFlags: /** @type {any[]} */ ([]),
          media: /** @type {any[]} */ ([]),
          quotedPosts: item.quotedPosts ?? [],
          links: item.links ?? [],
          linkCards: item.linkCards ?? [],
          longTextAttachments: /** @type {any[]} */ ([]),
          captureValidation: {
            version: CAPTURE_VALIDATION_VERSION,
            source: "page-json",
            rootPostId,
            postId: parsed.postId,
            containerPostIds: [parsed.postId],
            excludedPostIds: /** @type {any[]} */ ([]),
            validated: true
          }
        },
        container: findCanonicalContainerByPostId(parsed.postId),
        structuredTextUsed: true
      };
    }).filter(Boolean);
  }

  function mergeQuotedPosts(/** @type {any[]} */ ...groups) {
    const merged = [];
    const seen = new Set();
    for (const item of groups.flat(Infinity)) {
      const sourceUrl = S.normalizeThreadsUrl(item?.sourceUrl ?? item ?? "");
      const postId = S.parseThreadsUrl(sourceUrl).postId;
      if (!postId || seen.has(postId)) continue;
      seen.add(postId);
      merged.push({ postId, sourceUrl });
    }
    return merged;
  }

  function mergeContinuationRecords(/** @type {any} */ domRecords, /** @type {any} */ structuredRecords) {
    const merged = [...(domRecords ?? [])];
    const byPostId = new Map(merged.map(record => [
      S.parseThreadsUrl(record.entry?.sourceUrl).postId,
      record
    ]));
    for (const structured of structuredRecords ?? []) {
      const postId = S.parseThreadsUrl(structured.entry?.sourceUrl).postId;
      const existing = byPostId.get(postId);
      if (!existing) {
        merged.push(structured);
        byPostId.set(postId, structured);
        continue;
      }
      if (S.cleanText(structured.entry.text).length > S.cleanText(existing.entry.text).length) {
        existing.entry.text = structured.entry.text;
        existing.structuredTextUsed = true;
      }
      existing.entry.publishedAt ||= structured.entry.publishedAt;
      existing.entry.threadPosition = structured.entry.threadPosition || existing.entry.threadPosition;
      existing.entry.quotedPosts = mergeQuotedPosts(existing.entry.quotedPosts, structured.entry.quotedPosts);
      existing.entry.links = S.normalizeLinks([...(existing.entry.links ?? []), ...(structured.entry.links ?? [])]);
      existing.entry.linkCards = S.normalizeLinks([...(existing.entry.linkCards ?? []), ...(structured.entry.linkCards ?? [])], 10);
    }
    return merged;
  }

  function isMeaningfulEntry(/** @type {any} */ entry) {
    return Boolean(
      S.cleanText(entry?.text)
      || entry?.media?.length
      || entry?.quotedPosts?.length
      || entry?.longTextAttachments?.length
    );
  }

  function assertMeaningfulCapture(/** @type {any} */ capture) {
    if (!isMeaningfulEntry(capture)) {
      throw new Error(S.t("沒有讀到主貼文正文或圖片，為避免保存錯誤介面文字，本次已取消"));
    }
  }

  async function enrichWithLongText(/** @type {any} */ entry, /** @type {string} */ sourceUrl, /** @type {Element} */ container, shouldContinue = () => true) {
    if (!shouldContinue()) throw new Error(S.t("擷取已停止"));
    const postId = S.parseThreadsUrl(sourceUrl).postId;
    const scopedContainer = findContainerByPostUrl(sourceUrl)
      || (container?.isConnected ? container : null);
    if (!scopedContainer) return;
    if (S.parseThreadsUrl(findPostUrl(scopedContainer)).postId !== postId) {
      throw new Error(S.t("長文附件所屬貼文與來源網址不一致，已取消保存"));
    }
    const result = await captureLongTextAttachments(scopedContainer, shouldContinue);
    if (!shouldContinue()) throw new Error(S.t("擷取已停止"));
    const merged = mergeLongTextAttachments(entry.longTextAttachments, result.attachments);
    entry.longTextAttachments = merged;
    const refreshedContainer = findCanonicalContainerByPostId(postId);
    const refreshedMedia = refreshedContainer ? extractPostMedia(refreshedContainer) : [];
    entry.media = mergeMediaEntries(entry.media, refreshedMedia, result.media);
    entry.longTextDiagnostics = {
      detected: result.detected,
      captured: merged.length,
      warnings: result.warnings
    };
  }

  function findContainerByPostUrl(/** @type {string} */ sourceUrl) {
    const postId = S.parseThreadsUrl(sourceUrl).postId;
    if (!postId) return null;
    return findCanonicalContainerByPostId(postId);
  }

  async function captureLongTextAttachments(/** @type {Element} */ container, shouldContinue = () => true) {
    const attachments = extractHiddenLongTexts(container, "");
    const controls = findLongTextControls(container);
    const warnings = [];
    const media = [];
    let detected = controls.length;

    const openPreview = controls.length ? attachmentPreview(controls[0], container) : "";
    const postId = buildPostScope(container)?.postId ?? "";
    const openDialog = findVisibleDialog();
    const openDialogHasPostId = dialogContainsPostId(openDialog, postId);
    const strictOpenDialogText = openDialog ? extractBestExpandedText(openDialog, openPreview, true) : "";
    const fallbackOpenDialogText = openDialog ? extractBestExpandedText(openDialog, openPreview) : "";
    const openDialogMatches = openDialog && (
      attachmentMatchesPreview(strictOpenDialogText, openPreview)
      || openDialogHasPostId
      || (!controls.length && Boolean(fallbackOpenDialogText))
    );
    const openDialogText = openDialogMatches
      ? strictOpenDialogText || fallbackOpenDialogText
      : "";
    let handledOpenDialog = false;
    if (openDialog && openDialogMatches && shouldContinue()) {
      handledOpenDialog = true;
      detected = Math.max(1, detected);
      media.push(...extractPostMedia(openDialog));
      const initialText = openDialogText;
      const scrolled = await collectScrollableLongText(openDialog, "", initialText, shouldContinue);
      if (scrolled.text && scrolled.reachedEnd) {
        attachments.push({ text: scrolled.text, title: "長文附件", source: "open_dialog" });
      } else {
        warnings.push(S.t("目前已開啟長文附件，但無法確認已讀到最末段"));
      }
      await closeExpandedDialog(openDialog);
    }

    const remainingControls = handledOpenDialog ? controls.slice(1) : controls;
    for (const control of remainingControls.slice(0, 4)) {
      if (!shouldContinue()) break;
      if (!control.isConnected || !belongsToPostContainer(control, container)) continue;
      const preview = attachmentPreview(control, container);
      const beforeDialogs = new Set(
        [...document.querySelectorAll("[role='dialog'], [aria-modal='true']")].filter(node => isVisible(node))
      );
      const beforeRaw = S.cleanText(container.textContent);
      try {
        control.click();
      } catch {
        warnings.push(S.t("長文附件無法開啟"));
        continue;
      }

      const expanded = await waitForExpandedLongText(beforeDialogs, container, beforeRaw, preview, shouldContinue);
      if (expanded.dialog) {
        const scrolled = await collectScrollableLongText(expanded.dialog, preview, expanded.text, shouldContinue);
        if (scrolled.text.length > expanded.text.length) expanded.text = scrolled.text;
        expanded.reachedEnd = scrolled.reachedEnd;
        media.push(...extractPostMedia(expanded.dialog));
      }
      const previewText = cleanExpandedText(preview);
      const looksTruncated = Boolean(
        expanded.text
        && previewText.length >= 120
        && expanded.text.length <= previewText.length + 40
        && expanded.text.includes(previewText.slice(0, 80))
      );
      if (expanded.text && !looksTruncated && expanded.reachedEnd !== false) {
        attachments.push({ text: expanded.text, title: "長文附件", source: expanded.source });
      } else {
        warnings.push(S.t("偵測到長文附件，但無法確認全文已載入"));
      }
      if (expanded.dialog) await closeExpandedDialog(expanded.dialog);
    }

    const merged = mergeLongTextAttachments(attachments);
    if (detected && !merged.length && !warnings.length) {
      warnings.push(S.t("偵測到長文附件，但沒有取得附件文字"));
    }
    return {
      attachments: merged,
      media: mergeMediaEntries(media),
      detected,
      warnings: [...new Set(warnings)]
    };
  }

  function findLongTextControls(/** @type {Element} */ container) {
    const controls = /** @type {any[]} */ ([]);
    const seen = new Set();
    container.querySelectorAll("button, [role='button'], a[href], [tabindex], span").forEach((/** @type {Element} */ node) => {
      if (!belongsToPostContainer(node, container) || node.closest(PROFILE_INFO_SELECTOR)) return;
      const labels = [
        node.innerText,
        node.textContent,
        node.getAttribute("aria-label"),
        node.getAttribute("title")
      ].map(S.cleanText).filter(label => label && label.length <= 160);
      if (!labels.some(label => LONG_TEXT_CONTROL_PATTERN.test(label))) return;
      const clickable = node.closest("button, [role='button'], a[href], [tabindex]") || node;
      if (!seen.has(clickable)) {
        seen.add(clickable);
        controls.push(clickable);
      }
    });
    return controls;
  }

  function attachmentPreview(/** @type {any} */ control, /** @type {any} */ boundary) {
    let element = control;
    let best = S.cleanText(control.innerText || control.textContent);
    for (let depth = 0; element?.parentElement && depth < 5; depth += 1) {
      const parent = element.parentElement;
      if (!boundary.contains(parent) || parent === boundary) break;
      element = parent;
      const text = S.cleanText(element.innerText || element.textContent);
      if (text.length > best.length && text.length <= 4000) best = text;
    }
    return cleanExpandedText(best);
  }

  function findVisibleDialog() {
    return [...document.querySelectorAll("[role='dialog'], [aria-modal='true']")]
      .find(node => isVisible(node)) ?? null;
  }

  function dialogContainsPostId(/** @type {any} */ dialog, /** @type {string} */ postId) {
    if (!dialog || !postId) return false;
    return [...dialog.querySelectorAll("a[href]")].some(anchor => {
      return isPostLink(anchor.href) && S.parseThreadsUrl(anchor.href).postId === postId;
    });
  }

  function attachmentMatchesPreview(/** @type {string} */ text, /** @type {any} */ preview) {
    const full = cleanExpandedText(text);
    if (!full) return false;
    return attachmentPreviewAnchors(preview).some(anchor => {
      const shortFull = full.slice(0, Math.min(anchor.length, full.length));
      return full.includes(anchor) || anchor.includes(shortFull);
    });
  }

  function attachmentPreviewAnchors(/** @type {any} */ preview) {
    const text = cleanExpandedText(preview);
    if (!text) return [];
    const anchors = text.split(/\n+/)
      .map((line) => S.cleanText(line))
      .filter((line) => line.length >= 16 && !S.isThreadsUiText(line) && !LONG_TEXT_CONTROL_PATTERN.test(line))
      .map((line) => line.slice(0, 100));
    if (text.length >= 16) anchors.push(text.slice(0, 100));
    return [...new Set(anchors)].sort((left, right) => right.length - left.length).slice(0, 8);
  }

  async function waitForExpandedLongText(/** @type {any} */ beforeDialogs, /** @type {Element} */ container, /** @type {any} */ beforeRaw, /** @type {any} */ preview, shouldContinue = () => true) {
    let bestText = "";
    let bestDialog = null;
    let source = "";
    let stableRounds = 0;
    for (let round = 0; round < 50; round += 1) {
      if (!shouldContinue()) break;
      await new Promise(resolve => setTimeout(resolve, 100));
      const dialog = [...document.querySelectorAll("[role='dialog'], [aria-modal='true']")]
        .find(node => {
          if (!isVisible(node)) return false;
          if (!beforeDialogs.has(node)) return true;
          return attachmentMatchesPreview(extractBestExpandedText(node, preview), preview);
        });
      const candidate = dialog
        ? extractBestExpandedText(dialog, preview)
        : extractInlineExpansion(container, beforeRaw, preview);
      if (candidate.length > bestText.length) {
        bestText = candidate;
        bestDialog = dialog ?? bestDialog;
        source = dialog ? "dialog" : "inline";
        stableRounds = 0;
      } else if (bestText) {
        stableRounds += 1;
      }
      if (round >= 12 && stableRounds >= 6) break;
    }
    return { text: bestText, dialog: bestDialog, source, reachedEnd: bestDialog ? undefined : true };
  }

  async function collectScrollableLongText(/** @type {any} */ dialog, /** @type {any} */ preview, /** @type {any} */ initialText, shouldContinue = () => true) {
    const segments = [initialText].filter(Boolean);
    const scrollables = [dialog, ...dialog.querySelectorAll("*")]
      .filter(node => node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 60)
      .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
      .slice(0, 1);
    if (!scrollables.length) return { text: initialText, reachedEnd: true };

    let reachedEnd = true;
    for (const scrollable of scrollables) {
      const originalTop = scrollable.scrollTop;
      let steps = 0;
      let lastTop = -1;
      let stableEndRounds = 0;
      while (steps < 80 && shouldContinue()) {
        const heightBefore = scrollable.scrollHeight;
        const distance = Math.max(240, Math.floor(scrollable.clientHeight * 0.72));
        const target = Math.min(scrollable.scrollTop + distance, scrollable.scrollHeight - scrollable.clientHeight);
        scrollable.scrollTop = target;
        scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 180));
        if (!shouldContinue()) break;
        const current = extractBestExpandedText(dialog, preview);
        if (current) segments.push(current);
        const atEnd = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 4;
        if (atEnd && scrollable.scrollHeight === heightBefore) {
          stableEndRounds += 1;
          if (stableEndRounds >= 2) break;
        } else {
          stableEndRounds = 0;
        }
        if (scrollable.scrollTop === lastTop) {
          if (!atEnd) {
            reachedEnd = false;
            break;
          }
        }
        lastTop = scrollable.scrollTop;
        steps += 1;
      }
      if (steps >= 80) reachedEnd = false;
      scrollable.scrollTop = originalTop;
      scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    return { text: mergeTextSegments(segments), reachedEnd };
  }

  function mergeTextSegments(/** @type {any} */ segments) {
    let merged = "";
    for (const segment of segments.map(cleanExpandedText).filter(Boolean)) {
      if (!merged) {
        merged = segment;
        continue;
      }
      if (merged.includes(segment)) continue;
      if (segment.includes(merged)) {
        merged = segment;
        continue;
      }
      let overlap = 0;
      const maxOverlap = Math.min(merged.length, segment.length, 2000);
      for (let size = maxOverlap; size >= 30; size -= 1) {
        if (merged.endsWith(segment.slice(0, size))) {
          overlap = size;
          break;
        }
      }
      merged = overlap ? `${merged}${segment.slice(overlap)}` : `${merged}\n\n${segment}`;
    }
    return S.cleanText(merged);
  }

  function extractInlineExpansion(/** @type {Element} */ container, /** @type {any} */ beforeRaw, /** @type {any} */ preview) {
    const afterVisible = cleanExpandedText(container.innerText);
    const afterRaw = cleanExpandedText(container.textContent);
    const best = afterRaw.length > afterVisible.length ? afterRaw : afterVisible;
    if (best.length <= cleanExpandedText(beforeRaw).length + 60) return "";
    return chooseAttachmentCandidate([best], preview, true);
  }

  function extractBestExpandedText(/** @type {any} */ scope, /** @type {any} */ preview, requireAnchor = false) {
    const candidates = [scope.innerText, scope.textContent];
    scope.querySelectorAll("[dir='auto'], p, article").forEach((/** @type {Element} */ node) => {
      candidates.push(node.innerText, node.textContent);
    });
    return chooseAttachmentCandidate(candidates, preview, requireAnchor);
  }

  function chooseAttachmentCandidate(/** @type {any} */ values, /** @type {any} */ preview, requireAnchor = false) {
    const anchors = attachmentPreviewAnchors(preview);
    let best = "";
    let bestScore = -1;
    for (const value of values) {
      const text = cleanExpandedText(value);
      if (text.length < 120 || text.length > 100000) continue;
      const anchorMatched = anchors.some(anchor => {
        return text.includes(anchor) || anchor.includes(text.slice(0, Math.min(anchor.length, text.length)));
      });
      if (requireAnchor && (!anchors.length || !anchorMatched)) continue;
      const score = text.length + (anchorMatched ? 100000 : 0);
      if (score > bestScore) {
        best = text;
        bestScore = score;
      }
    }
    return best;
  }

  function cleanExpandedText(/** @type {any} */ value) {
    const lines = S.cleanText(value)
      .split("\n")
      .map((line) => {
        const text = S.cleanText(line);
        if (!text) return "";
        if (CLOSE_CONTROL_PATTERN.test(text) || LONG_TEXT_CONTROL_PATTERN.test(text)) return null;
        return text;
      })
      .filter((line) => line !== null);
    return S.stripThreadsMetadataLines(lines.join("\n"));
  }

  async function closeExpandedDialog(/** @type {any} */ dialog) {
    const closeControl = [...dialog.querySelectorAll("button, [role='button']")].find(node => {
      const label = S.cleanText(node.getAttribute("aria-label") || node.textContent);
      return CLOSE_CONTROL_PATTERN.test(label);
    });
    if (closeControl) {
      closeControl.click();
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    }
    for (let index = 0; index < 15 && dialog.isConnected && isVisible(dialog); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  function isVisible(/** @type {Element} */ node) {
    return node instanceof Element && node.getClientRects().length > 0;
  }

  function mergeLongTextAttachments(/** @type {any[]} */ ...groups) {
    const texts = /** @type {any[]} */ ([]);
    groups.flat(Infinity).forEach(item => addLongText(texts, typeof item === "string" ? item : item?.text));
    return texts.map(text => ({ text, title: "長文附件" }));
  }

  function mergeMediaEntries(/** @type {any[]} */ ...groups) {
    const merged = /** @type {any[]} */ ([]);
    const seen = new Set();
    groups.flat(Infinity).forEach(item => {
      if (!item?.url) return;
      const key = mediaUrlKey(item.url);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push({
        type: "image",
        url: item.url,
        alt: "",
        width: Math.max(0, Number(item.width) || 0),
        height: Math.max(0, Number(item.height) || 0)
      });
    });
    return merged;
  }

  function addLongText(/** @type {any} */ collection, /** @type {any} */ value) {
    const text = cleanExpandedText(value);
    if (text.length < 120) return;
    if (collection.some((/** @type {any} */ existing) => existing === text || existing.includes(text))) return;
    for (let index = collection.length - 1; index >= 0; index -= 1) {
      if (text.includes(collection[index])) collection.splice(index, 1);
    }
    collection.push(text);
  }

  function isUiText(/** @type {string} */ text, /** @type {any} */ author) {
    return S.isThreadsUiText(text, author);
  }

  async function expandVisibleText(scope = document, shouldContinue = () => true) {
    const root = scope instanceof Element || scope instanceof Document ? scope : document;
    const controls = [...root.querySelectorAll("button, [role='button']")].filter(control => {
      const visibleText = S.cleanText(control.textContent);
      return /^(?:more|see more|顯示更多|更多內容|展開)$/i.test(visibleText);
    });
    for (const control of controls.slice(0, 50)) {
      if (!shouldContinue()) break;
      try {
        control.click();
      } catch {
        // A failed expansion should not stop text capture.
      }
    }
    if (controls.length && shouldContinue()) await waitForTextStability(root, shouldContinue);
  }

  async function waitForTextStability(/** @type {any} */ scope, shouldContinue = () => true) {
    let previous = "";
    let stableRounds = 0;
    for (let round = 0; round < 25 && shouldContinue(); round += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const signature = `${scope.querySelectorAll?.("[dir='auto']")?.length ?? 0}:${S.cleanText(scope.textContent).length}`;
      if (signature === previous) {
        stableRounds += 1;
      } else {
        previous = signature;
        stableRounds = 0;
      }
      if (stableRounds >= 3) break;
    }
  }

  const observer = new MutationObserver(() => {
    DomScope.resetCache();
    refreshRouteState();
  });
  let activeCaptures = 0;

  function startCaptureObserver() {
    activeCaptures += 1;
    if (activeCaptures === 1 && !NODE_TEST_RUNTIME) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function stopCaptureObserver() {
    activeCaptures = Math.max(0, activeCaptures - 1);
    if (!activeCaptures) observer.disconnect();
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      captureCurrentThread,
      captureSelection,
      pageDataStatus,
      collectContinuationRecords,
      collectPostContainers,
      disposeForTests() {
        observer.disconnect();
      },
      extractPost,
      extractQuotedPosts,
      findPostContainer,
      mergeContinuationRecords
    };
  }
})();
