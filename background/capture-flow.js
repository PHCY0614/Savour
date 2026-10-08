/**
 * Saving from the active tab: ask the page's content script for a capture, check the local index first, and hand the result to the queue. Also answers whether the open page is already saved.
 *
 * Created once by background.js with `createCaptureFlow(deps)`; `deps` carries the shared services
 * (storage, the Notion request function, the queue) so this file has no globals of its own.
 */
(function attachSavourBackgroundCaptureFlow(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourBackgroundCaptureFlow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundCaptureFlowModule() {
  "use strict";

  /**
   * @param {Pick<import("../types").Services, "INCOMPLETE_THREAD_FLAG" | "S" | "activeThreadsTab" | "enqueueCaptures" | "ensureFreshThreadPage" | "ensurePageScripts" | "fetchImageInTab" | "mediaStage" | "getStatus" | "readState" | "sendToTab" | "withStateLock" | "writeState">} deps services from background.js
   */
  function createCaptureFlow(deps) {
    const { INCOMPLETE_THREAD_FLAG, S, activeThreadsTab, enqueueCaptures, ensureFreshThreadPage, ensurePageScripts, fetchImageInTab, getStatus, mediaStage, readState, sendToTab, withStateLock, writeState } = deps;

    const MAX_STAGED_IMAGES = 60;
    const MAX_STAGED_BYTES = 120 * 1024 * 1024;

    // What the popup needs to offer 更新 Notion 頁面 for the open tab, from the local index only.
    async function activePageStatus() {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = tab?.url ?? "";
      if (!tab?.id || !S.isSupportedSourceUrl(url)) return { supported: false, status: "unsupported" };
      const local = S.localPostCaptureStatus(await readState(), url);
      return {
        supported: true,
        status: local.status,
        title: S.cleanText(local.record?.title ?? ""),
        notionUrl: String(local.record?.notionUrl ?? "")
      };
    }

    async function captureActiveSelection() {
      const tab = await activeThreadsTab();
      await ensurePageScripts(tab);
      const capture = await sendToTab(tab.id, { type: "CAPTURE_SELECTION" });
      const result = await enqueueCaptures([capture], { verifyExisting: true });
      return { ...result, captureSummary: captureDiagnosticsSummary(capture) };
    }

    function captureDiagnosticsSummary(/** @type {any} */ capture) {
      const entries = [capture, ...(capture?.continuations ?? []), ...(capture?.authorReplies ?? [])];
      return {
        longTextCount: entries.reduce((total, item) => total + (item.longTextAttachments?.length ?? 0), 0),
        imageCount: entries.reduce((total, item) => total + (item.media?.length ?? 0), 0),
        warnings: [...(capture?.captureNotes ?? []), ...entries.flatMap(item => item.mediaDiagnostics?.warnings ?? [])]
      };
    }

    // The addresses of the images the extension uploads itself: those of a post (Threads, Plurk, Instagram, X) and
    // of a web capture marked for it (Facebook). Other web pages' images are imported by Notion instead.
    function imageUrlsToStage(/** @type {any} */ capture) {
      const platform = capture?.platform || S.parseThreadsUrl(capture?.sourceUrl ?? "").platform || "threads";
      if (platform === "web" && !capture.downloadMedia) return [];
      const entries = [capture, ...(capture.continuations ?? []), ...(capture.authorReplies ?? [])];
      const urls = entries.flatMap(entry => (entry?.media ?? []).map((/** @type {any} */ media) => media?.url));
      if (capture.downloadMedia) {
        urls.push(...(capture.articleBlocks ?? []).filter((/** @type {any} */ block) => block?.type === "image").map((/** @type {any} */ block) => block.url));
      }
      return [...new Set(urls.filter(url => {
        try {
          return typeof url === "string" && /^https:/.test(url) && !S.isPrivateNetworkHost(new URL(url).hostname);
        } catch {
          return false;
        }
      }))].slice(0, MAX_STAGED_IMAGES);
    }

    /**
     * Reads the capture's images from the page while the user is on it and keeps them in the media stage;
     * the capture gets `stagedImages` (address -> key). An image that cannot be read is left out and fails
     * later, at upload, like any other missing image. Returns the keys, so they can be dropped again.
     * @param {any} capture
     * @param {number} tabId
     * @returns {Promise<string[]>}
     */
    async function stageCaptureImages(capture, tabId) {
      /** @type {Record<string, string>} */
      const staged = {};
      let total = 0;
      for (const url of imageUrlsToStage(capture)) {
        if (total >= MAX_STAGED_BYTES) break;
        const image = await fetchImageInTab(tabId, url);
        if (!image?.ok || !image.base64) continue;
        try {
          const bytes = Uint8Array.from(atob(image.base64), char => char.charCodeAt(0));
          staged[url] = await mediaStage.put(new Blob([bytes], { type: image.type }));
          total += bytes.length;
        } catch {
          // This image is read again at upload time, which reports it if it fails.
        }
      }
      if (Object.keys(staged).length) capture.stagedImages = staged;
      return Object.values(staged);
    }

    // options.update: capture a saved page again and replace its original on Notion; notes stay.
    async function captureActiveThread(/** @type {import("../types").PageTab | null} */ tab = null, /** @type {any} */ options = {}) {
      tab ||= await activeThreadsTab();
      const update = Boolean(options.update);
      const local = update
        ? S.localPostCaptureStatus(await readState(), tab.url)
        : await preflightActiveThreadFromLocalState(tab.url);
      // A saved page flagged 串文未完整 gets its missing parts added; nothing already on the page is rewritten.
      const appendMissing = !update && local.status === "saved" && isIncompleteThreadRecord(local.record);
      const skip = update ? local.status === "pending" : local.status !== "new" && !appendMissing;
      if (skip) {
        return {
          ...(await getStatus()),
          added: 0,
          duplicates: 1,
          enqueuedIds: /** @type {string[]} */ ([]),
          appendMissing: false,
          localStatus: local.status,
          captureSummary: { longTextCount: 0, imageCount: 0, warnings: /** @type {string[]} */ ([]) }
        };
      }
      await ensurePageScripts(tab);
      const pageReloaded = await ensureFreshThreadPage(tab.id);
      const capture = await sendToTab(tab.id, { type: "CAPTURE_CURRENT_THREAD", includeContinuations: true });
      const summary = captureDiagnosticsSummary(capture);
      const stagedKeys = await stageCaptureImages(capture, tab.id);
      const enqueueOptions = update
        ? { updateExisting: true }
        : appendMissing ? { appendMissing: true } : { verifyExisting: true };
      const result = await enqueueCaptures([capture], enqueueOptions);
      // A capture that did not join the queue (already saved) has no use for its images.
      if (!result.added && stagedKeys.length) await mediaStage.removeMany(stagedKeys).catch(() => {});
      return {
        ...result,
        appendMissing,
        updateExisting: update && local.status === "saved",
        pageReloaded,
        captureSummary: summary
      };
    }

    function isIncompleteThreadRecord(/** @type {import("../types").SavedRecord} */ record) {
      return (record?.reviewItems ?? []).includes(INCOMPLETE_THREAD_FLAG);
    }

    async function preflightActiveThreadFromLocalState(/** @type {string} */ sourceUrl) {
      return withStateLock(async () => {
        const state = await readState();
        const local = S.localPostCaptureStatus(state, sourceUrl);
        if (local.status !== "saved" || isIncompleteThreadRecord(local.record)) return local;
        const record = local.record ?? {};
        state.recent.unshift({
          key: local.key,
          title: S.cleanText(record.title) || S.t("已保存的頁面"),
          notionUrl: String(record.notionUrl ?? ""),
          result: "already_saved",
          at: S.nowIso()
        });
        state.recent = state.recent.slice(0, 12);
        await writeState(state);
        return local;
      });
    }

    return {
      activePageStatus,
      captureActiveSelection,
      captureActiveThread
    };
  }

  return { createCaptureFlow };
});
