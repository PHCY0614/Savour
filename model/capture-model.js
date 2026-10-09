/**
 * Turns whatever a content script sent into a trusted Capture (see types.d.ts) and checks it.
 *
 * `normalizeCapture` clamps lengths, drops non-https media and unknown block types, and fills the
 * dedupe key; `validateCapture` rejects a capture whose posts do not match the page they came from.
 * Everything from a page is untrusted until it has passed through here.
 */
(function attachSavourCaptureModel(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("../lib/shared.js")
    : root.SavourShared;
  const flags = typeof module === "object" && module.exports
    ? require("./source-flags.js")
    : root.SavourSourceFlags;
  const dedupe = typeof module === "object" && module.exports
    ? require("./dedupe-key.js")
    : root.SavourDedupeKey;
  const articleBlocks = typeof module === "object" && module.exports
    ? require("./article-blocks.js")
    : root.SavourArticleBlocks;
  const api = factory(shared, flags, dedupe, articleBlocks);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SavourCaptureModel = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createCaptureModel(/** @type {typeof import("../lib/shared.js")} */ S, /** @type {typeof import("./source-flags.js")} */ F, /** @type {typeof import("./dedupe-key.js")} */ D, /** @type {typeof import("./article-blocks.js")} */ AB) {
  "use strict";

  const SCHEMA_VERSION = 2;
  const CAPTURE_VALIDATION_VERSION = 2;
  const PLATFORMS = new Set(["plurk", "x", "instagram", "web"]);
  const VALIDATION_SOURCES = new Set(["page-json", "plurk-page", "x-page", "instagram-page", "web-page"]);

  function sanitizeAttachments(/** @type {any} */ items) {
    return (items ?? [])
      .map((/** @type {any} */ item) => ({
        text: S.cleanText(typeof item === "string" ? item : item?.text ?? ""),
        title: S.cleanText(typeof item === "string" ? "長文附件" : item?.title ?? "長文附件") || "長文附件",
        ...(item?.source === "plurk_paste" ? { source: "plurk_paste" } : {})
      }))
      .filter((/** @type {any} */ item) => item.text);
  }

  function sanitizeDiagnostics(/** @type {any} */ diagnostics) {
    return {
      detected: Math.max(0, Number(diagnostics?.detected) || 0),
      captured: Math.max(0, Number(diagnostics?.captured) || 0),
      warnings: (diagnostics?.warnings ?? []).map(S.cleanText).filter(Boolean).slice(0, 10)
    };
  }

  function sanitizeValidation(/** @type {any} */ validation) {
    return {
      version: Number(validation?.version) || 0,
      source: VALIDATION_SOURCES.has(validation?.source) ? validation.source : "dom",
      rootPostId: String(validation?.rootPostId ?? ""),
      postId: String(validation?.postId ?? ""),
      containerPostIds: [...new Set((validation?.containerPostIds ?? []).map(String).filter(Boolean))].slice(0, 10),
      excludedPostIds: [...new Set((validation?.excludedPostIds ?? []).map(String).filter(Boolean))].slice(0, 9),
      validated: validation?.validated === true
    };
  }

  function sanitizeMedia(/** @type {any} */ items) {
    const seen = new Set();
    return (items ?? []).map((/** @type {any} */ item) => ({
      type: item?.type === "video" || item?.kind === "video" ? "video" : "image",
      kind: item?.type === "video" || item?.kind === "video" ? "video" : "image",
      url: String(item?.url ?? "").trim(),
      thumbnailUrl: String(item?.thumbnailUrl ?? "").trim(),
      alt: "",
      altText: "",
      width: Math.max(0, Number(item?.width) || 0),
      height: Math.max(0, Number(item?.height) || 0),
      notionFileId: String(item?.notionFileId ?? "")
    })).filter((/** @type {any} */ item) => {
      if (!/^https:\/\//i.test(item.url)) return false;
      let key;
      try {
        const parsed = new URL(item.url);
        key = `${parsed.origin}${parsed.pathname}`;
      } catch {
        return false;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 30);
  }

  function sanitizeQuotedPosts(/** @type {any} */ items) {
    const seen = new Set();
    return (items ?? []).map((/** @type {any} */ item) => {
      const canonicalUrl = S.normalizeThreadsUrl(item?.canonicalUrl ?? item?.sourceUrl ?? item ?? "");
      const shortcode = S.parseThreadsUrl(canonicalUrl).postId;
      return {
        postId: shortcode,
        sourceUrl: canonicalUrl,
        mediaId: String(item?.mediaId ?? ""),
        shortcode,
        canonicalUrl
      };
    }).filter((/** @type {any} */ item) => {
      const quotable = S.isThreadsUrl(item.canonicalUrl) || S.isXUrl(item.canonicalUrl);
      if (!item.shortcode || !quotable || seen.has(item.shortcode)) return false;
      seen.add(item.shortcode);
      return true;
    }).slice(0, 10);
  }

  // Images read from the page when the user saved, kept by address -> key in the media stage until they are uploaded.
  function sanitizeStagedImages(/** @type {any} */ value) {
    const staged = /** @type {Record<string, string>} */ ({});
    for (const [url, key] of Object.entries(value && typeof value === "object" ? value : {}).slice(0, 80)) {
      if (url.length <= 2000 && /^https?:/.test(url) && /^[\w-]{8,64}$/.test(String(key))) staged[url] = String(key);
    }
    return staged;
  }

  function normalizeLite(/** @type {any} */ raw, /** @type {any} */ context) {
    const sourceUrl = S.normalizeThreadsUrl(raw?.canonicalUrl ?? raw?.sourceUrl ?? "");
    const parsed = S.parseThreadsUrl(sourceUrl);
    const longTextAttachments = sanitizeAttachments(raw?.longTextAttachments);
    const quotedPosts = sanitizeQuotedPosts(raw?.quotedPosts ?? raw?.quotes);
    const platform = PLATFORMS.has(raw?.platform) ? raw.platform : "";
    const article = platform === "web" && Array.isArray(raw?.articleBlocks)
      ? AB.sanitizeArticleBlocks(raw.articleBlocks)
      : null;
    return {
      ...(platform ? { platform } : {}),
      ...(platform === "web" ? {
        title: S.cleanText(raw?.title ?? "").replace(/\s+/g, " ").slice(0, 300),
        siteName: S.cleanText(raw?.siteName ?? "").replace(/\s+/g, " ").slice(0, 200),
        excerpt: S.cleanText(raw?.excerpt ?? "").slice(0, 1000)
      } : {}),
      ...(article ? { articleBlocks: article.blocks } : {}),
      ...(article && raw?.downloadMedia === true ? { downloadMedia: true } : {}),
      ...(raw?.responseId ? { responseId: String(raw.responseId) } : {}),
      text: S.cleanText(raw?.text ?? ""),
      sourceUrl,
      canonicalUrl: sourceUrl,
      shortcode: String(raw?.shortcode ?? parsed.postId ?? ""),
      threadsMediaId: String(raw?.threadsMediaId ?? ""),
      // A web page's byline is a name ("王小明"), not an account handle.
      author: platform === "web"
        ? S.cleanText(raw?.author ?? "").replace(/\s+/g, " ").slice(0, 200)
        : S.cleanHandle(raw?.author ?? parsed.handle),
      publishedAt: S.validDate(raw?.publishedAt) ? new Date(raw.publishedAt).toISOString() : "",
      topicTag: S.cleanText(raw?.topicTag ?? "").slice(0, 100),
      threadPosition: S.normalizeThreadPosition(raw?.threadPosition),
      reviewFlags: S.normalizeReviewFlags(raw?.reviewFlags),
      media: article ? article.media : sanitizeMedia(raw?.media),
      links: S.normalizeLinks(raw?.links),
      linkCards: S.normalizeLinks(raw?.linkCards, 10),
      // Embedded YouTube / Vimeo players, as watch-page addresses; Notion plays them.
      videos: [...new Set((Array.isArray(raw?.videos) ? raw.videos : []).map((/** @type {any} */ value) => S.embeddedVideoWatchUrl(value)).filter(Boolean))].slice(0, 5),
      quotedPosts,
      quotes: quotedPosts.map((/** @type {any} */ item) => ({
        mediaId: item.mediaId,
        shortcode: item.shortcode,
        canonicalUrl: item.canonicalUrl
      })),
      mediaDiagnostics: sanitizeDiagnostics(raw?.mediaDiagnostics),
      longTextAttachments,
      longText: normalizeLongText(raw, longTextAttachments),
      longTextDiagnostics: sanitizeDiagnostics(raw?.longTextDiagnostics),
      captureValidation: sanitizeValidation(raw?.captureValidation),
      sourceType: context.sourceType,
      captureKind: "post",
      completeness: context.completeness,
      relationshipMethod: context.relationshipMethod
    };
  }

  function normalizeLongText(/** @type {any} */ raw, /** @type {any} */ attachments) {
    const attachment = raw?.text_attachment ?? raw?.textAttachment ?? {};
    const plaintext = S.cleanText(
      raw?.longText?.plaintext
      ?? attachment?.plaintext
      ?? attachments.map((/** @type {any} */ item) => item.text).join("\n\n")
    );
    const linkAttachmentUrl = String(
      raw?.longText?.linkAttachmentUrl
      ?? attachment?.link_attachment_url
      ?? raw?.linkAttachmentUrl
      ?? raw?.link_attachment_url
      ?? ""
    ).trim();
    const stylingInfo = sanitizeStylingInfo(raw?.longText?.stylingInfo ?? attachment?.styling_info);
    return plaintext || linkAttachmentUrl || stylingInfo.length
      ? { plaintext, linkAttachmentUrl, stylingInfo }
      : null;
  }

  function sanitizeStylingInfo(/** @type {any} */ value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).map(item => {
      if (!item || typeof item !== "object") return null;
      try {
        return JSON.parse(JSON.stringify(item));
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /**
   * Clamps and cleans a raw capture from a page and computes its dedupe key. Throws when it fails `validateCapture`.
   * @param {any} raw untrusted data from a content script
   * @param {{ sourceType?: string, completeness?: string, relationshipMethod?: string }} [options]
   * @returns {import("../types").Capture}
   */
  function normalizeCapture(raw, options = {}) {
    const captureType = raw?.captureType === "selection" ? "selection" : "post";
    const sourceType = F.normalizeSourceType(
      options.sourceType ?? raw?.sourceType,
      captureType === "selection" ? "selection" : "page"
    );
    let completeness = F.normalizeCompleteness(options.completeness ?? raw?.completeness, "partial");
    const initialReasons = F.incompleteReasonsFromCapture(raw, completeness);
    if (completeness === "complete" && initialReasons.length) completeness = "partial";
    const relationshipMethod = F.normalizeRelationshipMethod(
      options.relationshipMethod ?? raw?.relationshipMethod,
      sourceType === "api" ? "api" : sourceType === "manual" ? "manual" : "page-inference"
    );
    const context = { sourceType, completeness, relationshipMethod };
    const root = normalizeLite(raw, context);
    const continuations = (raw?.continuations ?? []).map((/** @type {any} */ item) => normalizeLite(item, context))
      .filter((/** @type {any} */ item) => item.text || item.sourceUrl || item.media.length || item.quotedPosts.length || item.longTextAttachments.length || item.linkCards.length);
    const authorReplies = (raw?.authorReplies ?? raw?.supplements ?? []).map((/** @type {any} */ item) => normalizeLite(item, context))
      .filter((/** @type {any} */ item) => item.text || item.sourceUrl || item.media.length || item.quotedPosts.length || item.longTextAttachments.length || item.linkCards.length);
    const savedAt = S.validDate(raw?.savedAt) ? new Date(raw.savedAt).toISOString() : S.nowIso();
    /** @type {any} */
    const capture = {
      ...root,
      ...(Object.keys(sanitizeStagedImages(raw?.stagedImages)).length ? { stagedImages: sanitizeStagedImages(raw?.stagedImages) } : {}),
      id: String(raw?.id ?? "") || crypto.randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      captureType,
      captureKind: captureType,
      sourceType,
      completeness,
      incompleteReasons: F.incompleteReasonsFromCapture(raw, completeness),
      urlAliases: [...new Set((raw?.urlAliases ?? []).map(S.normalizeThreadsUrl).filter(Boolean))],
      rootPostId: String(raw?.rootPostId || root.captureValidation.rootPostId || root.threadsMediaId || root.shortcode || ""),
      continuationIds: continuations.map((/** @type {any} */ item) => item.threadsMediaId || item.shortcode).filter(Boolean),
      supplementIds: authorReplies.map((/** @type {any} */ item) => item.threadsMediaId || item.shortcode).filter(Boolean),
      missingPositions: [...new Set((raw?.missingPositions ?? []).map(Number).filter(Number.isInteger).filter((/** @type {any} */ value) => value > 0))],
      relationshipMethod,
      continuations,
      authorReplies,
      supplements: authorReplies,
      savedAt,
      capturedAt: S.validDate(raw?.capturedAt) ? new Date(raw.capturedAt).toISOString() : savedAt,
      lastSyncedAt: S.validDate(raw?.lastSyncedAt) ? new Date(raw.lastSyncedAt).toISOString() : "",
      userConfirmedAt: completeness === "user-confirmed"
        ? S.validDate(raw?.userConfirmedAt) ? new Date(raw.userConfirmedAt).toISOString() : savedAt
        : "",
      titleHint: S.cleanText(raw?.titleHint ?? "")
    };
    capture.dedupeKey = D.captureKey(capture);
    validateCapture(capture);
    return capture;
  }

  function captureEntriesWithRole(/** @type {any} */ capture) {
    const entries = [{ entry: capture, role: "root" }];
    for (const continuation of capture.continuations ?? []) entries.push({ entry: continuation, role: "continuation" });
    for (const supplement of capture.authorReplies ?? capture.supplements ?? []) entries.push({ entry: supplement, role: "authorReply" });
    return entries;
  }

  // Plurk replies share the plurk's URL, so each is identified by its response id instead.
  function validatePlurkCapture(/** @type {any} */ capture) {
    const rootPostId = S.parseThreadsUrl(capture?.sourceUrl).postId;
    const validation = capture?.captureValidation ?? {};
    if (!rootPostId || S.parseThreadsUrl(capture.sourceUrl).platform !== "plurk") {
      throw new Error(S.t("噗文缺少可驗證的噗浪網址，已取消保存"));
    }
    if (validation.source !== "plurk-page" || validation.validated !== true || validation.postId !== rootPostId) {
      throw new Error(S.t("噗文內容沒有通過來源驗證，已取消保存"));
    }
    if (capture.continuations?.length) throw new Error(S.t("噗文不應包含串文續文，已取消保存"));
    const seenResponses = new Set();
    for (const reply of capture.authorReplies ?? []) {
      if (S.parseThreadsUrl(reply.sourceUrl).postId !== rootPostId) {
        throw new Error(S.t("噗主回應不屬於這則噗，已取消保存"));
      }
      if (!reply.responseId || seenResponses.has(reply.responseId)) {
        throw new Error(S.t("噗主回應缺少或重複回應編號，已取消保存"));
      }
      seenResponses.add(reply.responseId);
      if (S.parseThreadPosition(reply.threadPosition)) throw new Error(S.t("噗主回應不應包含串文序號，已取消保存"));
      if (!S.cleanText(reply.text) && !reply.media?.length && !reply.longTextAttachments?.length) {
        throw new Error(S.t("噗主回應沒有內容，已取消保存"));
      }
    }
    if (!S.cleanText(capture.text) && !capture.media?.length && !capture.longTextAttachments?.length) {
      throw new Error(S.t("噗文沒有正文、圖片或長文，已取消保存"));
    }
    return true;
  }

  function hasArticleContent(/** @type {import("../types").Capture} */ capture) {
    return Boolean(S.cleanText(capture?.text) || capture?.articleBlocks?.length || capture?.media?.length);
  }

  // A web page is saved as one page; it has no thread parts or replies.
  function validateWebCapture(/** @type {import("../types").Capture} */ capture) {
    const parsed = S.parseThreadsUrl(capture?.sourceUrl);
    const validation = capture?.captureValidation ?? {};
    if (parsed.platform !== "web") throw new Error(S.t("網頁缺少可保存的網址，已取消保存"));
    if (validation.source !== "web-page" || validation.validated !== true) {
      throw new Error(S.t("網頁內容沒有通過來源驗證，已取消保存"));
    }
    if (capture.continuations?.length || capture.authorReplies?.length) {
      throw new Error(S.t("網頁不應包含串文或回覆，已取消保存"));
    }
    if (!hasArticleContent(capture)) throw new Error(S.t("網頁沒有可保存的正文或圖片，已取消保存"));
    return true;
  }

  // An X post and the author's own follow-up posts, each identified by its own status id.
  function validateXCapture(/** @type {import("../types").Capture} */ capture) {
    const root = S.parseThreadsUrl(capture?.sourceUrl);
    const validation = capture?.captureValidation ?? {};
    if (root.platform !== "x" || !root.postId) throw new Error(S.t("貼文缺少可驗證的 X 網址，已取消保存"));
    if (validation.source !== "x-page" || validation.validated !== true || validation.postId !== root.postId) {
      throw new Error(S.t("X 貼文內容沒有通過來源驗證，已取消保存"));
    }
    if (capture.continuations?.length) throw new Error(S.t("X 貼文的續文應放在作者補充，已取消保存"));
    const rootAuthor = S.cleanHandle(capture.author || root.handle);
    if (root.handle && rootAuthor !== root.handle) throw new Error(S.t("作者欄位與來源網址不一致，已取消保存"));
    const seen = new Set([root.postId]);
    for (const reply of capture.authorReplies ?? []) {
      const parsed = S.parseThreadsUrl(reply?.sourceUrl);
      if (parsed.platform !== "x" || !parsed.postId || seen.has(parsed.postId)) {
        throw new Error(S.t("作者補充缺少或重複 X 貼文編號，已取消保存"));
      }
      seen.add(parsed.postId);
      if (!rootAuthor || parsed.handle !== rootAuthor) throw new Error(S.t("作者補充不屬於主貼文作者，已取消保存"));
      if (!S.cleanText(reply.text) && !reply.media?.length && !reply.quotedPosts?.length) {
        throw new Error(S.t("作者補充沒有正文、圖片或引用連結，已取消保存"));
      }
    }
    if (!S.cleanText(capture.text) && !capture.media?.length && !capture.quotedPosts?.length) {
      throw new Error(S.t("X 貼文沒有正文、圖片或引用連結，已取消保存"));
    }
    return true;
  }

  // An Instagram post is one page: its caption and its photos (a carousel keeps every photo).
  function validateInstagramCapture(/** @type {import("../types").Capture} */ capture) {
    const parsed = S.parseThreadsUrl(capture?.sourceUrl);
    const validation = capture?.captureValidation ?? {};
    if (parsed.platform !== "instagram" || !parsed.postId) throw new Error(S.t("貼文缺少可驗證的 Instagram 網址，已取消保存"));
    if (validation.source !== "instagram-page" || validation.validated !== true || validation.postId !== parsed.postId) {
      throw new Error(S.t("Instagram 貼文內容沒有通過來源驗證，已取消保存"));
    }
    if (capture.continuations?.length || capture.authorReplies?.length) {
      throw new Error(S.t("Instagram 貼文不應包含串文或回覆，已取消保存"));
    }
    if (!S.cleanText(capture.text) && !capture.media?.length) throw new Error(S.t("Instagram 貼文沒有說明文字或圖片，已取消保存"));
    return true;
  }

  /**
   * Checks that every post in the capture belongs to the page it came from. Throws a user-readable error otherwise.
   * @param {import("../types").Capture} capture
   * @returns {boolean}
   */
  function validateCapture(capture) {
    if (capture?.captureType === "selection" || capture?.captureKind === "selection") return true;
    if (capture?.platform === "instagram") return validateInstagramCapture(capture);
    if (capture?.platform === "plurk") return validatePlurkCapture(capture);
    if (capture?.platform === "web") return validateWebCapture(capture);
    if (capture?.platform === "x") return validateXCapture(capture);
    const rootAuthor = S.cleanHandle(capture?.author || S.parseThreadsUrl(capture?.sourceUrl).handle);
    const rootPostId = S.parseThreadsUrl(capture?.sourceUrl).postId;
    const seenPostIds = new Set();
    for (const { entry, role } of captureEntriesWithRole(capture)) {
      const parsed = S.parseThreadsUrl(entry?.sourceUrl ?? "");
      const validation = entry?.captureValidation ?? {};
      if (!parsed.postId) throw new Error(S.t("貼文缺少可驗證的 Threads 貼文編號，已取消保存"));
      const validApiSource = capture.sourceType === "api" && Boolean(entry?.threadsMediaId);
      const validStructuredSource = validation.source === "page-json" && validation.rootPostId === rootPostId;
      const validDomSource = validation.source !== "page-json"
        && validation.containerPostIds?.includes(parsed.postId)
        && !validation.excludedPostIds?.includes(parsed.postId);
      if (
        !validApiSource
        && (
          validation.version !== CAPTURE_VALIDATION_VERSION
          || validation.validated !== true
          || validation.postId !== parsed.postId
          || (!validStructuredSource && !validDomSource)
        )
      ) {
        throw new Error(S.t("貼文內容沒有通過來源容器驗證，已取消保存以避免混入其他貼文"));
      }
      if (seenPostIds.has(parsed.postId)) throw new Error(S.t("同一份擷取資料出現重複貼文編號，已取消保存"));
      seenPostIds.add(parsed.postId);
      if (role === "root" && rootAuthor && parsed.handle !== rootAuthor) {
        throw new Error(S.t("作者欄位與來源網址不一致，已取消保存"));
      }
      if ((role === "continuation" || role === "authorReply") && rootAuthor && parsed.handle !== rootAuthor) {
        throw new Error(S.t("作者後續不屬於主貼文作者，已取消保存"));
      }
      if (role === "authorReply" && S.parseThreadPosition(entry.threadPosition)) {
        throw new Error(S.t("無編號作者回覆不應包含串文序號，已取消保存"));
      }
      if (
        role !== "root"
        && !S.cleanText(entry.text)
        && !entry.media?.length
        && !entry.quotedPosts?.length
        && !entry.longTextAttachments?.length
      ) {
        throw new Error(S.t("作者後續沒有正文、圖片、引用連結或長文附件，已取消保存"));
      }
    }
    const rootPosition = S.parseThreadPosition(capture.threadPosition);
    if (capture.continuations?.length && !rootPosition) {
      throw new Error(S.t("作者續文缺少主貼文串文序號，已取消保存"));
    }
    let expectedPosition = rootPosition ? rootPosition.index + 1 : 0;
    for (const continuation of capture.continuations ?? []) {
      const position = S.parseThreadPosition(continuation.threadPosition);
      // rootPosition is set: continuations without it were rejected above.
      if (!position || position.total !== /** @type {NonNullable<typeof rootPosition>} */ (rootPosition).total || position.index !== expectedPosition) {
        throw new Error(S.t("作者續文序號不連續，已取消保存"));
      }
      expectedPosition += 1;
    }
    if (!S.cleanText(capture.text) && !capture.media?.length && !capture.quotedPosts?.length && !capture.longTextAttachments?.length) {
      throw new Error(S.t("主貼文沒有正文、圖片、引用連結或長文附件，已取消保存"));
    }
    return true;
  }

  /**
   * Same check as `validateCapture`, but returns false instead of throwing.
   * @param {import("../types").Capture} capture
   * @returns {boolean}
   */
  function hasValidCaptureIntegrity(capture) {
    try {
      return validateCapture(capture);
    } catch {
      return false;
    }
  }

  return {
    CAPTURE_VALIDATION_VERSION,
    SCHEMA_VERSION,
    hasValidCaptureIntegrity,
    normalizeCapture,
    validateCapture
  };
});
