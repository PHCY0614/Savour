/**
 * The save queue: enqueue captures, process them a few at a time, retry failures up to three times,
 * and record what was saved. Persists through storage/state.js and survives a service worker restart.
 */
(function attachSavourQueueRetry(root, factory) {
  const dedupe = typeof module === "object" && module.exports
    ? require("../model/dedupe-key.js")
    : root.SavourDedupeKey;
  const api = factory(dedupe);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourQueueRetry = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQueueRetryModule(/** @type {typeof import("../model/dedupe-key.js")} */ D) {
  "use strict";

  // Alarm name keeps the earlier product name so an alarm set before an update still fires.
  const PROCESS_ALARM = "savourProcessQueue";
  const LARGE_CREATE_LIMIT = 20;
  const LARGE_CREATE_CONFIRMATION_CODE = "large_create_confirmation_required";
  const MAX_SELECTION_APPENDS = 500;
  const MAX_APPEND_TARGETS = 5;

  /**
   * @typedef {object} QueueRetryOptions
   * @property {typeof chrome} chromeApi
   * @property {typeof import("../lib/shared.js")} shared
   * @property {typeof import("../notion/index.js")} notion
   * @property {import("../types").Services["readState"]} readState
   * @property {import("../types").Services["writeState"]} writeState
   * @property {import("../types").Services["withStateLock"]} withStateLock
   * @property {import("../types").Services["readConfig"]} readConfig
   * @property {import("../types").Services["readToken"]} readToken
   * @property {() => Promise<void>} [assertReadyToSave] throws when setup is unfinished
   * @property {import("../types").Services["ensureArchiveSchema"]} ensureArchiveSchema
   * @property {import("../types").Services["saveCaptureToNotion"]} saveCaptureToNotion
   * @property {import("../types").Services["appendSelectionToPage"]} appendSelectionToPage
   * @property {import("../types").Services["sanitizeCapture"]} sanitizeCapture normalizes an untrusted capture
   * @property {import("../types").Services["assertCaptureIntegrity"]} assertCaptureIntegrity
   * @property {import("../types").Services["hasValidCaptureIntegrity"]} hasValidCaptureIntegrity
   * @property {import("../types").Services["getStatus"]} getStatus
   * @property {(item: import("../types").QueueItem) => import("../types").QueueItem} cloneQueueItem
   */

  /**
   * @param {QueueRetryOptions} options
   */
  function createQueueRetry(options) {
    /**
     * @param {string} text
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    const t = (text, params) => (shared.t ? shared.t(text, params) : String(text).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match)));
    const {
      chromeApi,
      shared,
      notion,
      readState,
      writeState,
      withStateLock,
      readConfig,
      readToken,
      // Throws before anything is queued when setup is unfinished; a queue that cannot run would only block
      // choosing the database later.
      assertReadyToSave = async () => {},
      ensureArchiveSchema,
      saveCaptureToNotion,
      appendSelectionToPage,
      sanitizeCapture,
      assertCaptureIntegrity,
      hasValidCaptureIntegrity,
      getStatus,
      cloneQueueItem
    } = options;
    let processing = false;

    function captureEntries(/** @type {import("../types").Capture} */ capture) {
      return [capture, ...(capture.continuations ?? []), ...(capture.authorReplies ?? [])];
    }

    function authorReplyPostIds(/** @type {import("../types").Capture} */ capture) {
      return [...new Set((capture?.authorReplies ?? [])
        .map((/** @type {any} */ entry) => shared.parseThreadsUrl(entry?.sourceUrl ?? "").postId)
        .filter(Boolean))];
    }

    function captureClass(/** @type {import("../types").Capture} */ capture) {
      if (capture?.captureType === "selection" || D.isSelectionKey(capture?.dedupeKey)) return "selection";
      return "article";
    }

    function queuedCaptureKey(/** @type {import("../types").Capture} */ capture) {
      return `${captureClass(capture)}:${String(capture?.dedupeKey ?? "")}`;
    }

    // A selection added to an existing page is a different job from the same selection saved as a new page.
    function queueItemKey(/** @type {any} */ item) {
      return item?.appendTo?.pageId
        ? `append:${item.appendTo.pageId}:${String(item.capture?.dedupeKey ?? "")}`
        : queuedCaptureKey(item?.capture);
    }

    function selectionAppendKey(/** @type {string} */ pageId, /** @type {import("../types").Capture} */ capture) {
      return `${pageId}:${shared.hashString(shared.cleanText(capture?.text))}`;
    }

    function prospectiveCreateCount(/** @type {import("../types").State} */ state, /** @type {any} */ captures) {
      const queuedKeys = new Set((state.queue ?? [])
        .filter((/** @type {any} */ item) => hasValidCaptureIntegrity(item.capture))
        .map(queueItemKey));
      const countedKeys = new Set();
      let count = 0;
      for (const capture of captures) {
        const queueKey = queuedCaptureKey(capture);
        if (queuedKeys.has(queueKey) || countedKeys.has(queueKey)) continue;
        if (matchingSavedKeys(state, capture).length) continue;
        countedKeys.add(queueKey);
        count += 1;
      }
      return count;
    }

    function matchingSavedKeys(/** @type {import("../types").State} */ state, /** @type {import("../types").Capture} */ capture, /** @type {any} */ extraKeys = []) {
      const keys = new Set([capture?.dedupeKey || D.captureKey(capture), ...extraKeys].filter(Boolean));
      const normalizedUrl = shared.normalizeThreadsUrl(capture?.sourceUrl ?? "");
      const postId = shared.parseThreadsUrl(normalizedUrl).postId;
      if (capture?.captureType === "selection"
        || String(capture?.dedupeKey ?? "").startsWith("selection:")) {
        return [...keys].filter(key => state.saved[key]);
      }
      for (const [key, record] of Object.entries(state.saved)) {
        if (key.startsWith("selection:") || keys.has(key)) continue;
        const savedUrl = shared.normalizeThreadsUrl(record?.sourceUrl ?? "");
        const savedPostId = shared.parseThreadsUrl(savedUrl).postId;
        if ((normalizedUrl && savedUrl === normalizedUrl) || (postId && savedPostId === postId)) {
          keys.add(key);
        }
      }
      return [...keys].filter(key => state.saved[key]);
    }

    function countLongTextAttachments(/** @type {import("../types").Capture} */ capture) {
      return captureEntries(capture).reduce(
        (total, item) => total + (item.longTextAttachments?.length ?? 0),
        0
      );
    }

    function isProcessing() {
      return processing;
    }

    /**
     * Adds captures to the queue unless the page is already saved or queued. Throws an error with code LARGE_CREATE_CONFIRMATION_CODE when a call would create more than LARGE_CREATE_LIMIT pages and `confirmedLargeCreate` is not set.
     * @param {any[]} rawCaptures untrusted captures
     * @param {{ verifyExisting?: boolean, confirmedLargeCreate?: boolean, createCountOffset?: number, appendMissing?: boolean, updateExisting?: boolean }} [enqueueOptions]
     * @returns {Promise<{ added: number, duplicates: number, enqueuedIds: string[] } & import("../types").Status>} counts of added and duplicate items plus the current status
     */
    async function enqueueCaptures(rawCaptures, enqueueOptions = {}) {
      const captures = rawCaptures.map(sanitizeCapture).filter(item => item.text || item.sourceUrl);
      if (!captures.length) throw new Error(t("畫面中沒有可保存的文字或貼文網址"));
      await assertReadyToSave();
      const result = await withStateLock(async () => {
        const state = await readState();
        const prospectiveCreates = prospectiveCreateCount(state, captures);
        const requestedCreates = Math.max(0, Number(enqueueOptions.createCountOffset) || 0)
          + prospectiveCreates;
        if (!enqueueOptions.confirmedLargeCreate
          && Object.keys(state.saved ?? {}).length > 0
          && requestedCreates > LARGE_CREATE_LIMIT) {
          const error = new Error(t("這次預計建立 {n} 個新頁面，請先確認後再繼續", { n: requestedCreates }));
          error.code = LARGE_CREATE_CONFIRMATION_CODE;
          error.createCount = requestedCreates;
          error.limit = LARGE_CREATE_LIMIT;
          throw error;
        }
        const queuedKeys = new Set(state.queue
          .filter((item) => hasValidCaptureIntegrity(item.capture))
          .map(queueItemKey));
        let added = 0;
        let duplicates = 0;
        const enqueuedIds = [];
        for (const capture of captures) {
          state.queue = state.queue.filter((item) => {
            return queueItemKey(item) !== queuedCaptureKey(capture)
              || hasValidCaptureIntegrity(item.capture);
          });
          const queueKey = queuedCaptureKey(capture);
          const savedKeys = matchingSavedKeys(state, capture);
          const locallySaved = savedKeys.length > 0;
          const appendMissing = Boolean(enqueueOptions.appendMissing && locallySaved);
          // updateExisting replaces only the original recorded on the saved page (see notion/repository.js).
          const updateExisting = Boolean(enqueueOptions.updateExisting);
          const shouldVerifyInNotion = Boolean((enqueueOptions.verifyExisting || appendMissing || updateExisting) && locallySaved);
          // Without updateExisting, existing Notion pages are never changed; a verified duplicate is skipped
          // when processed, and appendMissing only adds thread parts the page does not have yet.
          if (queuedKeys.has(queueKey) || (locallySaved && !shouldVerifyInNotion)) {
            duplicates += 1;
            continue;
          }
          state.queue.push({
            id: capture.id,
            capture,
            ...(appendMissing ? { appendMissing: true } : {}),
            ...(updateExisting ? { updateExisting: true } : {}),
            status: "pending",
            attempts: 0,
            createdAt: shared.nowIso(),
            lastError: ""
          });
          queuedKeys.add(queueKey);
          enqueuedIds.push(capture.id);
          added += 1;
        }
        await writeState(state);
        return { added, duplicates, enqueuedIds };
      });
      if (result.added) scheduleQueue(50);
      return { ...result, ...(await getStatus()) };
    }

    // Queues a selection to be added to the end of an existing archive page.
    /**
     * Queues a text selection to be added to an existing Notion page.
     * @param {any} rawCapture a selection capture
     * @param {{ pageId: string, title: string }} rawTarget
     * @returns {Promise<import("../types").EnqueueResult>}
     */
    async function enqueueSelectionAppend(rawCapture, rawTarget) {
      await assertReadyToSave();
      const capture = sanitizeCapture(rawCapture);
      if (capture.captureType !== "selection" || !capture.text) throw new Error(t("請先選取想保存的文字"));
      const pageId = shared.extractNotionId(rawTarget?.pageId);
      if (!pageId) throw new Error(t("沒有指定要加入的 Notion 頁面"));
      const title = shared.cleanText(rawTarget?.title ?? "").slice(0, 200) || "未命名貼文";
      const appendTo = { pageId, title };
      const result = await withStateLock(async () => {
        const state = await readState();
        state.selectionAppends = state.selectionAppends ?? {};
        state.appendTargets = [appendTo, ...(state.appendTargets ?? []).filter((item) => item?.pageId !== pageId)]
          .slice(0, MAX_APPEND_TARGETS);
        /** @type {import("../types").QueueItem} */
        const item = { id: capture.id, capture, appendTo, status: "pending", attempts: 0, createdAt: shared.nowIso(), lastError: "" };
        let outcome;
        if (state.selectionAppends[selectionAppendKey(pageId, capture)]) {
          outcome = { added: 0, duplicates: 1, alreadyOnPage: true, enqueuedIds: /** @type {any[]} */ ([]) };
        } else if (state.queue.some((entry) => queueItemKey(entry) === queueItemKey(item) && entry.status !== "failed")) {
          outcome = { added: 0, duplicates: 1, enqueuedIds: [] };
        } else {
          state.queue = state.queue.filter((entry) => queueItemKey(entry) !== queueItemKey(item));
          state.queue.push(item);
          outcome = { added: 1, duplicates: 0, enqueuedIds: [item.id] };
        }
        await writeState(state);
        return outcome;
      });
      if (result.added) scheduleQueue(50);
      return { ...result, target: appendTo, ...(await getStatus()) };
    }

    async function recordSelectionAppend(/** @type {any} */ item, /** @type {any} */ saved) {
      await withStateLock(async () => {
        const state = await readState();
        state.queue = state.queue.filter((entry) => entry.id !== item.id);
        const appends = { ...(state.selectionAppends ?? {}), [selectionAppendKey(item.appendTo.pageId, item.capture)]: shared.nowIso() };
        state.selectionAppends = Object.fromEntries(Object.entries(appends).slice(-MAX_SELECTION_APPENDS));
        const savedEntry = Object.entries(state.saved ?? {})
          .find(([, record]) => shared.extractNotionId(record?.notionPageId) === item.appendTo.pageId);
        state.recent.unshift({
          key: savedEntry?.[0] ?? "",
          title: savedEntry?.[1]?.title || item.appendTo.title,
          notionUrl: saved.url || savedEntry?.[1]?.notionUrl || "",
          result: saved.selectionAlreadyOnPage ? "selection_exists" : "selection_appended",
          at: shared.nowIso()
        });
        state.recent = state.recent.slice(0, 12);
        await writeState(state);
      });
    }

    /**
     * Wakes the queue with an alarm after `delayMs` (a service worker may be stopped before a timer fires).
     * @param {number} [delayMs]
     * @returns {void}
     */
    function scheduleQueue(delayMs = 1000) {
      chromeApi.alarms.create(PROCESS_ALARM, { when: Date.now() + Math.max(50, delayMs) });
      processQueue().catch(() => {});
    }

    /**
     * Saves up to `maxItems` pending items. A failed item is retried until it fails three times or hits a permanent error.
     * @param {number} [maxItems]
     * @returns {Promise<void>}
     */
    async function processQueue(maxItems = 5) {
      if (processing) return;
      processing = true;
      let processed = 0;
      let schemaEnsured = false;
      try {
        const config = await readConfig();
        const token = await readToken();
        if (!token || !config.dataSourceId) return;

        while (processed < maxItems) {
          const item = await withStateLock(async () => {
            const state = await readState();
            const next = state.queue.find((entry) => entry.status === "pending");
            if (!next) return null;
            next.status = "processing";
            next.startedAt = shared.nowIso();
            await writeState(state);
            return cloneQueueItem(next);
          });
          if (!item) break;

          try {
            assertCaptureIntegrity(item.capture);
            if (!schemaEnsured) {
              await ensureArchiveSchema(config.dataSourceId, token);
              schemaEnsured = true;
            }
            if (item.appendTo) {
              const appended = await appendSelectionToPage(item.capture, item.appendTo.pageId, config.dataSourceId, token);
              await recordSelectionAppend(item, appended);
              processed += 1;
              await shared.sleep(500);
              continue;
            }
            const saved = await saveCaptureToNotion(
              item.capture,
              config.dataSourceId,
              token,
              {
                repairPartialPage: Boolean(item.repairPartialPage),
                appendMissing: Boolean(item.appendMissing),
                updateExisting: Boolean(item.updateExisting)
              }
            );
            await withStateLock(async () => {
              const state = await readState();
              const savedRecord = notion.savedRecordFromPage(saved);
              /** @type {Partial<import("../types").SavedRecord>} */
              const remoteRecord = savedRecord?.value ?? {};
              const canonicalCaptureKey = savedRecord?.key || item.capture.dedupeKey;
              // What may be missing from the page is known only here; Notion has no column for it.
              const reviewItems = shared.normalizeReviewFlags(
                captureEntries(item.capture).flatMap(entry => entry.reviewFlags ?? [])
              );
              const displayTitle = remoteRecord.title
                || shared.buildTitle(notion.captureTitleText(item.capture), item.capture.publishedAt, 30);
              const savedKeys = matchingSavedKeys(state, item.capture, [canonicalCaptureKey]);
              const previousAuthorReplyPostIds = [...new Set(savedKeys.flatMap(
                key => state.saved[key]?.authorReplyPostIds ?? []
              ))];
              const savedAuthorReplyPostIds = saved.duplicateFoundInNotion && !saved.updatedExisting
                ? previousAuthorReplyPostIds
                : authorReplyPostIds(item.capture);
              state.queue = state.queue.filter((entry) => entry.id !== item.id);
              for (const staleKey of savedKeys) {
                if (staleKey && staleKey !== canonicalCaptureKey) delete state.saved[staleKey];
              }
              state.saved[canonicalCaptureKey] = {
                sourceUrl: remoteRecord.sourceUrl || item.capture.sourceUrl,
                title: displayTitle,
                author: remoteRecord.author || item.capture.author,
                captureType: remoteRecord.captureType || item.capture.captureType,
                notionPageId: remoteRecord.notionPageId || saved.id || "",
                notionUrl: remoteRecord.notionUrl || saved.url || "",
                savedAt: remoteRecord.savedAt || shared.nowIso(),
                topicTag: remoteRecord.topicTag || item.capture.topicTag,
                reviewItems,
                duplicateFoundInNotion: Boolean(saved.duplicateFoundInNotion),
                updatedExisting: Boolean(saved.updatedExisting),
                longTextAttachmentCount: countLongTextAttachments(item.capture),
                authorReplyPostIds: savedAuthorReplyPostIds
              };
              state.recent.unshift({
                key: canonicalCaptureKey,
                title: displayTitle,
                notionUrl: remoteRecord.notionUrl || saved.url || "",
                reviewItems,
                result: saved.mediaUploadSummary?.failed
                  ? "saved_partial"
                  : saved.appendedContinuations
                    ? "appended"
                    : saved.updatedExisting
                      ? "updated"
                      : saved.duplicateFoundInNotion ? "already_saved" : "saved",
                at: shared.nowIso()
              });
              state.recent = state.recent.slice(0, 12);
              await writeState(state);
            });
          } catch (error) {
            await withStateLock(async () => {
              const state = await readState();
              const current = state.queue.find((entry) => entry.id === item.id);
              if (!current) return;
              current.attempts += 1;
              current.lastError = error.message || String(error);
              // Only a page this tool created but failed to finish may be rebuilt on retry.
              if (error.partialPageCreated) current.repairPartialPage = true;
              // A permanent error (e.g. the target page was deleted) will not succeed on retry.
              current.status = error.permanent || current.attempts >= 3 ? "failed" : "pending";
              await writeState(state);
            });
          }
          processed += 1;
          await shared.sleep(500);
        }
      } finally {
        processing = false;
        // If the status read fails, skip rescheduling; the next alarm or user action restarts the queue.
        const status = await getStatus().catch(() => /** @type {any} */ (null));
        if (status?.pending) {
          chromeApi.alarms.create(PROCESS_ALARM, { when: Date.now() + 1500 });
        }
      }
    }

    /**
     * Puts failed items back to pending with their attempt count reset. Items whose capture fails the integrity check stay failed.
     * @returns {Promise<{ retried: number }>}
     */
    async function retryFailedItems() {
      const count = await withStateLock(async () => {
        const state = await readState();
        let changed = 0;
        for (const item of state.queue) {
          if (item.status === "failed" && hasValidCaptureIntegrity(item.capture)) {
            item.status = "pending";
            item.attempts = 0;
            item.lastError = "";
            changed += 1;
          }
        }
        await writeState(state);
        return changed;
      });
      if (count) scheduleQueue(50);
      return { retried: count };
    }

    /**
     * On worker start: items left "processing" by a stopped worker go back to pending, and items whose capture fails its integrity check are marked failed.
     * @returns {Promise<void>}
     */
    async function recoverInterruptedItems() {
      await withStateLock(async () => {
        const state = await readState();
        let changed = false;
        for (const item of state.queue) {
          if (!hasValidCaptureIntegrity(item.capture)) {
            item.status = "failed";
            item.attempts = 3;
            item.lastError = t("這個項目的擷取資料無法驗證，請回到原貼文重新保存");
            changed = true;
            continue;
          }
          if (item.status === "processing") {
            item.status = "pending";
            changed = true;
          }
        }
        if (changed) await writeState(state);
      });
    }

    return {
      enqueueCaptures,
      enqueueSelectionAppend,
      isProcessing,
      processQueue,
      recoverInterruptedItems,
      retryFailedItems,
      scheduleQueue
    };
  }

  return {
    LARGE_CREATE_CONFIRMATION_CODE,
    LARGE_CREATE_LIMIT,
    PROCESS_ALARM,
    createQueueRetry
  };
});
