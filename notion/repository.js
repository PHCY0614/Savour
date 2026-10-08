/**
 * Notion read/write flows for captures: find an existing page, create, update or append to one,
 * and import images. Built on notion/http.js and notion/page-builder.js.
 *
 * Never overwrites a page the user edited: an existing page is skipped, appended to, or has only its
 * original range replaced, so the user's own notes survive.
 */
(function attachSavourNotionRepository(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourNotionRepository = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNotionRepositoryModule() {
  "use strict";

  /**
   * @typedef {object} NotionRepositoryOptions
   * @property {typeof import("../lib/shared.js")} shared
   * @property {typeof import("./index.js")} notion
   * @property {import("../types").Services["notionRequest"]} notionRequest from notion/http.js
   * @property {typeof fetch} fetchImpl for downloading images the page did not already hand over
   * @property {{ get(key: string): Promise<Blob | null>, removeMany(keys: Iterable<string>): Promise<void> }} [mediaStage] images read from the page when the user saved
   * @property {(capture: import("../types").Capture) => import("../types").CaptureEntry[]} captureEntries the capture, then its continuations and author replies
   * @property {(capture: import("../types").Capture) => import("../types").Capture} cloneCapture
   * @property {() => FormData} createFormData
   * @property {number} [imageTimeoutMs] tests shorten this
   * @property {number[]} [importPollDelaysMs] tests shorten this
   */

  /**
   * @param {NotionRepositoryOptions} options
   */
  function createNotionRepository(options) {
    /**
     * @param {string} text
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    const t = (text, params) => (shared.t ? shared.t(text, params) : String(text).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match)));
    const {
      shared,
      notion,
      notionRequest,
      captureEntries,
      fetchImpl,
      cloneCapture,
      createFormData,
      mediaStage = null
    } = options;

    /** @param {(page: any) => boolean} [acceptPage] */
    async function queryFirst(/** @type {string} */ dataSourceId, /** @type {string} */ token, /** @type {any} */ body, acceptPage = () => true) {
      let cursor = "";
      do {
        const response = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
          method: "POST",
          body: { ...body, ...(cursor ? { start_cursor: cursor } : {}) },
          token,
          retrySafe: true
        });
        const page = (response.results ?? []).find(acceptPage);
        if (page) return page;
        cursor = response.has_more ? response.next_cursor ?? "" : "";
      } while (cursor);
      return null;
    }

    /**
     * The archive page saved under the capture's key, or null.
     * @param {import("../types").Capture} capture
     * @param {string} dataSourceId
     * @param {string} token
     */
    async function findExistingCapture(capture, dataSourceId, token) {
      return queryFirst(dataSourceId, token, notion.queryByCaptureKeyPayload(capture.dedupeKey));
    }

    function imageExtension(/** @type {any} */ contentType, /** @type {string} */ sourceUrl) {
      /** @type {Record<string, string>} */
      const known = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/avif": "avif"
      };
      if (known[contentType]) return known[contentType];
      try {
        const match = new URL(sourceUrl).pathname.match(/\.([a-z0-9]{2,5})$/i);
        if (match) return match[1].toLowerCase();
      } catch {
        // Fall back to a common image extension.
      }
      return "jpg";
    }

    function capturePlatform(/** @type {import("../types").Capture} */ capture) {
      return capture?.platform || shared.parseThreadsUrl(capture?.sourceUrl ?? "").platform || "threads";
    }

    const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
    const IMAGE_TIMEOUT_MS = options.imageTimeoutMs ?? 30000;

    function tooLargeError() {
      return new Error(t("單張圖片超過 20 MB，暫不支援直接上傳"));
    }

    // A page may point images at the user's own machine or local network; those are not fetched,
    // unless the page itself is on that host (an intranet article).
    function assertPublicImageUrl(/** @type {any} */ value, /** @type {any} */ pageHost) {
      let host;
      try {
        host = new URL(value).hostname.toLowerCase();
      } catch {
        throw new Error(t("圖片網址無效"));
      }
      if (shared.isPrivateNetworkHost(host) && host !== pageHost) {
        const error = new Error(t("圖片位在本機或區域網路，已略過"));
        error.privateNetwork = true;
        throw error;
      }
    }

    // Stops reading as soon as the image passes the size limit instead of after the whole download.
    async function readLimitedBlob(/** @type {any} */ response, /** @type {any} */ contentType) {
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw tooLargeError();
      const reader = response.body?.getReader?.();
      if (!reader) {
        const blob = await response.blob();
        if (blob.size > MAX_IMAGE_BYTES) throw tooLargeError();
        return blob;
      }
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          throw tooLargeError();
        }
        chunks.push(value);
      }
      return new Blob(chunks, contentType ? { type: contentType } : {});
    }

    // Images that need the user's session are read inside the page when saving (stagedImages); this
    // fallback never sends cookies. The whole download, body included, has a time limit.
    async function downloadImage(/** @type {any} */ media, /** @type {{ credentials?: RequestCredentials, pageHost?: string }} */ { credentials = "omit", pageHost = "" } = {}) {
      assertPublicImageUrl(media.url, pageHost);
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS) : 0;
      try {
        const response = await fetchImpl(media.url, {
          method: "GET",
          credentials,
          cache: "no-store",
          redirect: "follow",
          ...(controller ? { signal: controller.signal } : {})
        });
        // A public address may redirect to a local one.
        if (response.url) assertPublicImageUrl(response.url, pageHost);
        if (!response.ok) throw new Error(t("圖片下載失敗 {status}", { status: response.status }));
        const headerType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const blob = await readLimitedBlob(response, headerType);
        const contentType = String(blob.type || headerType).split(";")[0].toLowerCase();
        if (!contentType.startsWith("image/")) throw new Error(t("下載內容不是圖片檔案"));
        if (!blob.size) throw new Error(t("下載到的圖片是空檔案"));
        return { blob, contentType };
      } catch (error) {
        if (error?.name === "AbortError") throw new Error(t("圖片下載逾時"), { cause: error });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function uploadImageToNotion(/** @type {any} */ media, /** @type {import("../types").Capture} */ capture, /** @type {number} */ index, /** @type {string} */ token) {
      const platform = capturePlatform(capture);
      // Instagram shares the Threads image servers.
      let pageHost = "";
      try {
        pageHost = new URL(capture.sourceUrl).hostname.toLowerCase();
      } catch {
        // No page address; only public image hosts are fetched.
      }
      // The image was read from the page when the user saved; only without that is it fetched from here.
      const stagedKey = capture.stagedImages?.[media.url];
      const stagedBlob = stagedKey && mediaStage ? await mediaStage.get(stagedKey).catch(() => null) : null;
      const { blob, contentType } = stagedBlob
        ? { blob: stagedBlob, contentType: String(stagedBlob.type || "").split(";")[0].toLowerCase() || "image/jpeg" }
        : await downloadImage(media, { credentials: "omit", pageHost });
      const postId = shared.parseThreadsUrl(capture.sourceUrl).postId || shared.hashString(capture.dedupeKey);
      const filename = `${platform}-${postId}-${String(index + 1).padStart(2, "0")}.${imageExtension(contentType, media.url)}`;
      const upload = await notionRequest("/v1/file_uploads", {
        method: "POST",
        body: {
          mode: "single_part",
          filename,
          content_type: contentType
        },
        token,
        retrySafe: false
      });
      if (!upload.id) throw new Error(t("Notion 沒有回傳圖片上傳 ID"));

      const form = createFormData();
      form.append("file", blob, filename);
      const sent = await notionRequest(`/v1/file_uploads/${upload.id}/send`, {
        method: "POST",
        body: form,
        token,
        retrySafe: false
      });
      if (sent.status && sent.status !== "uploaded") throw new Error(t("Notion 尚未完成圖片上傳"));
      return upload.id;
    }

    // Images of a web page are imported by Notion itself: Notion downloads them from their public
    // https address into the workspace, so the extension needs no access to those sites. Images
    // Notion cannot fetch (login required, hotlink protection, http) stay linked to the original
    // address, which is not reported as missing. Addresses on the user's own network are neither
    // fetched nor linked.
    const IMPORT_POLL_DELAYS_MS = options.importPollDelaysMs ?? [3000, 5000, 8000, 12000, 15000];

    function pageHostOf(/** @type {import("../types").Capture} */ capture) {
      try {
        return new URL(capture.sourceUrl).hostname.toLowerCase();
      } catch {
        return "";
      }
    }

    function importFilename(/** @type {any} */ media, /** @type {number} */ index) {
      let extension = "jpg";
      try {
        const match = new URL(media.url).pathname.match(/\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|heic)$/i);
        if (match) extension = match[1].toLowerCase().replace("jpeg", "jpg");
      } catch {
        // A common image extension is used.
      }
      return `web-${String(index + 1).padStart(2, "0")}.${extension}`;
    }

    async function prepareWebMedia(/** @type {any} */ prepared, /** @type {any} */ entries, /** @type {string} */ token) {
      const pageHost = pageHostOf(prepared);
      /** @type {any[]} */
      const pending = [];
      let detected = 0;
      let index = 0;
      for (const entry of entries) {
        for (const media of entry.media ?? []) {
          detected += 1;
          let host = "";
          try {
            host = new URL(media.url).hostname.toLowerCase();
          } catch {
            media.blocked = true;
          }
          if (!media.blocked) {
            const isPrivate = shared.isPrivateNetworkHost(host);
            if (isPrivate && host !== pageHost) {
              media.blocked = true;
            } else if (isPrivate || !/^https:/i.test(media.url)) {
              media.external = true;
            } else {
              try {
                const upload = await notionRequest("/v1/file_uploads", {
                  method: "POST",
                  body: { mode: "external_url", external_url: media.url, filename: importFilename(media, index) },
                  token,
                  retrySafe: false
                });
                if (upload.id) pending.push({ media, id: upload.id });
                else media.external = true;
              } catch {
                media.external = true;
              }
              await shared.sleep(250);
            }
          }
          index += 1;
        }
      }
      for (const delay of IMPORT_POLL_DELAYS_MS) {
        if (!pending.some(item => !item.done)) break;
        await shared.sleep(delay);
        for (const item of pending.filter(entryItem => !entryItem.done)) {
          try {
            const upload = await notionRequest(`/v1/file_uploads/${item.id}`, { method: "GET", token, retrySafe: true });
            if (upload.status === "uploaded") {
              item.media.notionFileId = item.id;
              item.done = true;
            } else if (upload.status === "failed" || upload.status === "expired") {
              item.media.external = true;
              item.done = true;
            }
          } catch {
            // Asked again on the next round.
          }
        }
      }
      for (const item of pending.filter(entryItem => !entryItem.done)) item.media.external = true;
      for (const entry of entries) {
        entry.mediaDiagnostics = {
          detected: entry.media?.length ?? 0,
          captured: (entry.media ?? []).filter((/** @type {any} */ media) => media.notionFileId).length,
          warnings: [...(entry.mediaDiagnostics?.warnings ?? [])].slice(0, 10)
        };
      }
      prepared.mediaUploadSummary = { detected, uploaded: pending.filter(item => item.media.notionFileId).length, failed: 0 };
      return prepared;
    }

    /**
     * Imports the capture's images into Notion and returns a copy whose media point at the imported files.
     * @param {import("../types").Capture} capture
     * @param {string} token
     * @returns {Promise<import("../types").Capture & { mediaUploadSummary: import("../types").MediaUploadSummary }>}
     */
    async function prepareCaptureMedia(capture, token) {
      const prepared = /** @type {import("../types").Capture & { mediaUploadSummary: import("../types").MediaUploadSummary }} */ (cloneCapture(capture));
      const entries = captureEntries(prepared);
      // A web capture whose images only the user's own browser can fetch (Facebook) is downloaded and uploaded like a post.
      if (capturePlatform(prepared) === "web" && !prepared.downloadMedia) return prepareWebMedia(prepared, entries, token);
      let detected = 0;
      let uploaded = 0;
      let failed = 0;
      let mediaIndex = 0;

      for (const entry of entries) {
        const warnings = [...(entry.mediaDiagnostics?.warnings ?? [])];
        let entryUploaded = 0;
        detected += entry.media?.length ?? 0;
        for (const media of entry.media ?? []) {
          try {
            media.notionFileId = await uploadImageToNotion(media, prepared, mediaIndex, token);
            uploaded += 1;
            entryUploaded += 1;
          } catch (error) {
            failed += 1;
            warnings.push(t("圖片 {n} 未能保存：{reason}", { n: mediaIndex + 1, reason: error.message || String(error) }));
          }
          mediaIndex += 1;
          await shared.sleep(250);
        }
        entry.mediaDiagnostics = {
          detected: entry.media?.length ?? 0,
          captured: entryUploaded,
          warnings: [...new Set(warnings)].slice(0, 10)
        };
        if (warnings.length) {
          entry.reviewFlags = shared.normalizeReviewFlags([...(entry.reviewFlags ?? []), "圖片未完整"]);
        }
      }
      prepared.mediaUploadSummary = { detected, uploaded, failed };
      return prepared;
    }

    // Writes blocks in request-sized chunks, in order. Without a position they go to the end of the
    // page; with one, the first chunk goes there and each next chunk follows the previous one.
    // Returns the ids of the written top-level blocks.
    async function insertPageChildren(/** @type {string} */ pageId, /** @type {any} */ children, /** @type {string} */ token, /** @type {any} */ position = null) {
      const ids = [];
      let nextPosition = position;
      for (const chunk of notion.chunkBlocks(children)) {
        const response = await notionRequest(`/v1/blocks/${pageId}/children`, {
          method: "PATCH",
          body: { children: chunk, ...(nextPosition ? { position: nextPosition } : {}) },
          token,
          retrySafe: false
        });
        const written = (response.results ?? []).map((/** @type {any} */ block) => block?.id).filter(Boolean);
        ids.push(...written);
        if (nextPosition) {
          // Without the new ids the next chunk would land above this one.
          if (!written.length) throw new Error(t("Notion 沒有回傳新增的區塊，已停止寫入以免順序錯亂"));
          nextPosition = { type: "after_block", after_block: { id: written.at(-1) } };
        }
        await shared.sleep(400);
      }
      return ids;
    }

    async function appendPageChildren(/** @type {string} */ pageId, /** @type {any} */ children, /** @type {string} */ token) {
      return insertPageChildren(pageId, children, token);
    }

    async function writeContentRange(/** @type {string} */ pageId, /** @type {any} */ firstId, /** @type {any} */ lastId, /** @type {string} */ token) {
      return notionRequest(`/v1/pages/${pageId}`, {
        method: "PATCH",
        body: notion.contentRangePayload(firstId, lastId),
        token,
        retrySafe: true
      });
    }

    // Where the original sits on the page now: the index of its first and last top-level block.
    function locateContentRange(/** @type {any} */ page, /** @type {any} */ blocks) {
      const range = notion.contentRangeFromPage(page);
      if (!range) return null;
      const ids = blocks.map((/** @type {any} */ block) => shared.extractNotionId(block?.id));
      const first = ids.indexOf(range.first);
      const last = ids.indexOf(range.last);
      return first !== -1 && last >= first ? { first, last } : null;
    }

    async function listPageChildren(/** @type {string} */ pageId, /** @type {string} */ token) {
      const blocks = [];
      let cursor = "";
      do {
        const query = `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await notionRequest(`/v1/blocks/${pageId}/children?${query}`, {
          method: "GET",
          token,
          retrySafe: true
        });
        blocks.push(...(response.results ?? []));
        cursor = response.has_more ? response.next_cursor ?? "" : "";
      } while (cursor);
      return blocks;
    }

    // Adds only the numbered thread parts the page does not show yet, at the end of the page.
    // Existing blocks (including the user's own notes) are never changed or removed. Re-running is
    // safe: parts already on the page are recognised by their "N/M" markers and skipped.
    async function appendMissingContinuations(/** @type {any} */ existing, /** @type {import("../types").Capture} */ capture, /** @type {string} */ token) {
      const blocks = await listPageChildren(existing.id, token);
      const savedPositions = notion.savedThreadPositions(blocks);
      // Pages with a recorded original get the parts right after it, above the user's notes.
      const range = locateContentRange(existing, blocks);
      const missing = (capture.continuations ?? []).filter((/** @type {any} */ entry) => {
        const position = shared.parseThreadPosition(entry?.threadPosition);
        return position && !savedPositions.has(position.index);
      });
      /** @type {any} */
      let mediaUploadSummary = { detected: 0, uploaded: 0, failed: 0 };
      if (missing.length) {
        const prepared = await prepareCaptureMedia({ ...capture, media: [], continuations: missing, authorReplies: [] }, token);
        mediaUploadSummary = prepared.mediaUploadSummary;
        const continuationBlocks = notion.buildContinuationBlocks(prepared.continuations);
        if (range) {
          const ids = await insertPageChildren(existing.id, continuationBlocks, token, {
            type: "after_block",
            after_block: { id: blocks[range.last].id }
          });
          if (ids.length) await writeContentRange(existing.id, blocks[range.first].id, ids.at(-1), token);
        } else {
          await appendPageChildren(existing.id, continuationBlocks, token);
        }
      }
      return {
        ...existing,
        duplicateFoundInNotion: true,
        appendedContinuations: missing.length,
        mediaUploadSummary
      };
    }

    function permanentError(/** @type {any} */ message) {
      const error = new Error(message);
      error.permanent = true;
      return error;
    }

    function compactText(/** @type {any} */ value) {
      return String(value ?? "").replace(/\s+/g, "");
    }

    // Adds a selection to the end of a page in the archive. Only pages of dataSourceId are accepted,
    // and nothing already on the page is changed. A selection whose text is already on the page
    // (for example after a retry) is not added again.
    /**
     * Adds a selected passage to the end of an existing page, unless it is already there.
     * @param {import("../types").Capture} capture a selection capture
     * @param {string} pageId
     * @param {string} dataSourceId
     * @param {string} token
     * @returns {Promise<import("../types").NotionSaveResult>}
     */
    async function appendSelectionToPage(capture, pageId, dataSourceId, token) {
      const targetId = shared.extractNotionId(pageId);
      if (!targetId) throw permanentError(t("沒有指定要加入的 Notion 頁面"));
      const page = await notionRequest(`/v1/pages/${targetId}`, { method: "GET", token, retrySafe: true });
      if (page.in_trash === true || page.archived === true) {
        throw permanentError(t("目標頁面已經在 Notion 被刪除，請改選其他頁面"));
      }
      if (shared.extractNotionId(page.parent?.data_source_id) !== shared.extractNotionId(dataSourceId)) {
        throw permanentError(t("只能加到目前整理庫裡的頁面"));
      }
      const blocks = notion.buildSelectionAppendBlocks(capture);
      if (!blocks.length) throw permanentError(t("沒有可加入的文字"));
      const selection = compactText(capture.text);
      const pageText = compactText(notion.blocksPlainText(await listPageChildren(targetId, token)));
      // Very short selections ("謝謝") would match almost any page, so they are always added.
      if (selection.length >= 10 && pageText.includes(selection)) {
        return { ...page, selectionAlreadyOnPage: true };
      }
      await appendPageChildren(targetId, blocks, token);
      return { ...page, appendedSelection: true };
    }

    // Records the original's block range; a page without it can still be saved, it just cannot have
    // its original replaced later, so a failure here is not an error.
    async function recordContentRange(/** @type {string} */ pageId, /** @type {any} */ appendedIds, /** @type {string} */ token) {
      try {
        let firstId = "";
        let lastId = appendedIds.at(-1) ?? "";
        if (lastId) {
          const head = await notionRequest(`/v1/blocks/${pageId}/children?page_size=1`, { method: "GET", token, retrySafe: true });
          firstId = head.results?.[0]?.id ?? "";
        } else {
          const blocks = await listPageChildren(pageId, token);
          firstId = blocks[0]?.id ?? "";
          lastId = blocks.at(-1)?.id ?? "";
        }
        if (firstId && lastId) await writeContentRange(pageId, firstId, lastId, token);
      } catch {
        // See above.
      }
    }

    async function replaceExistingCapture(/** @type {any} */ existing, /** @type {import("../types").Capture} */ capture, /** @type {string} */ token) {
      const children = notion.buildPageChildren(capture);
      const updated = await notionRequest(`/v1/pages/${existing.id}`, {
        method: "PATCH",
        body: notion.updatePagePayload(capture),
        token,
        retrySafe: false
      });
      const ids = await appendPageChildren(existing.id, children, token);
      if (ids.length) await writeContentRange(existing.id, ids[0], ids.at(-1), token).catch(() => {});
      return { ...updated, updatedExisting: true };
    }

    async function createCapturePage(/** @type {import("../types").Capture} */ capture, /** @type {string} */ dataSourceId, /** @type {string} */ token) {
      const [firstChunk = [], ...rest] = notion.chunkBlocks(notion.buildPageChildren(capture));
      const created = await notionRequest("/v1/pages", {
        method: "POST",
        body: notion.createPagePayload(capture, dataSourceId, { children: firstChunk }),
        token,
        retrySafe: false
      });
      let appendedIds = [];
      if (rest.length) {
        try {
          appendedIds = await appendPageChildren(created.id, rest.flat(), token);
        } catch (error) {
          error.partialPageCreated = true;
          throw error;
        }
      }
      if (firstChunk.length) await recordContentRange(created.id, appendedIds, token);
      return created;
    }

    // Replaces the original on a saved page with a fresh capture. Only the blocks recorded as the
    // original are removed; everything the user added above or below it stays where it is. When the
    // recorded original cannot be found on the page, nothing is removed: the new version goes on top.
    async function updateExistingCapture(/** @type {any} */ existing, /** @type {import("../types").Capture} */ capture, /** @type {string} */ token) {
      const prepared = await prepareCaptureMedia(capture, token);
      const children = notion.buildPageChildren(prepared);
      const blocks = await listPageChildren(existing.id, token);
      const range = locateContentRange(existing, blocks);
      const position = range && range.first > 0
        ? { type: "after_block", after_block: { id: blocks[range.first - 1].id } }
        : { type: "start" };
      const ids = await insertPageChildren(existing.id, children, token, position);
      if (!range && blocks.length && ids.length) {
        await insertPageChildren(existing.id, notion.previousVersionNoticeBlocks(), token, {
          type: "after_block",
          after_block: { id: ids.at(-1) }
        });
      }
      const rangeProperties = ids.length ? notion.contentRangePayload(ids[0], ids.at(-1)).properties : {};
      const updated = await notionRequest(`/v1/pages/${existing.id}`, {
        method: "PATCH",
        body: { properties: { ...notion.refreshPagePropertiesPayload(prepared).properties, ...rangeProperties } },
        token,
        retrySafe: false
      });
      // The new version is recorded before the old one is removed, so an interruption leaves an
      // extra copy rather than a page without its original.
      if (range && ids.length) {
        for (const block of blocks.slice(range.first, range.last + 1)) {
          await notionRequest(`/v1/blocks/${block.id}`, { method: "DELETE", token, retrySafe: true });
          await shared.sleep(150);
        }
      }
      return {
        ...existing,
        ...updated,
        duplicateFoundInNotion: true,
        updatedExisting: true,
        keptPreviousVersion: !range && blocks.length > 0,
        mediaUploadSummary: prepared.mediaUploadSummary
      };
    }

    /**
     * Creates the page, or - if the capture is already in Notion - skips, appends missing parts or replaces only the original text, according to `saveOptions`. Never erases the user's notes.
     * @param {import("../types").Capture} capture
     * @param {string} dataSourceId
     * @param {string} token
     * @param {{ repairPartialPage?: boolean, appendMissing?: boolean, updateExisting?: boolean }} [saveOptions]
     * @returns {Promise<import("../types").NotionSaveResult>} the page id and url plus flags such as `duplicateFoundInNotion`, `updatedExisting`
     */
    async function saveCaptureToNotionOnce(capture, dataSourceId, token, saveOptions = {}) {
      const existing = await findExistingCapture(capture, dataSourceId, token);
      // Rebuild only a page this tool created but failed to finish writing; any other
      // existing page is skipped so the user's own Notion notes are never erased.
      if (existing && saveOptions.repairPartialPage) {
        const prepared = await prepareCaptureMedia(capture, token);
        const result = await replaceExistingCapture(existing, prepared, token);
        return { ...result, mediaUploadSummary: prepared.mediaUploadSummary };
      }
      if (existing && saveOptions.updateExisting) return updateExistingCapture(existing, capture, token);
      if (existing && saveOptions.appendMissing) return appendMissingContinuations(existing, capture, token);
      if (existing) return { ...existing, duplicateFoundInNotion: true };
      const prepared = await prepareCaptureMedia(capture, token);
      try {
        const result = await createCapturePage(prepared, dataSourceId, token);
        return { ...result, mediaUploadSummary: prepared.mediaUploadSummary };
      } catch (error) {
        if (error.partialPageCreated) throw error;
        if ([429, 500, 502, 503, 504, 529].includes(error.status)) {
          const afterFailure = await findExistingCapture(capture, dataSourceId, token).catch(recoveryError => {
            // The original error is the one worth reporting; the recovery lookup is best effort.
            console.warn("Savour: duplicate lookup after a failed save also failed", recoveryError);
            return /** @type {any} */ (null);
          });
          if (afterFailure) return { ...afterFailure, duplicateFoundInNotion: true };
        }
        throw error;
      }
    }

    // Once the capture is in Notion its staged images are no longer needed; after a failure they stay for the retry.
    async function saveCaptureToNotion(/** @type {import("../types").Capture} */ capture, /** @type {string} */ dataSourceId, /** @type {string} */ token, /** @type {any} */ saveOptions = {}) {
      const saved = await saveCaptureToNotionOnce(capture, dataSourceId, token, saveOptions);
      if (mediaStage) await mediaStage.removeMany(Object.values(capture?.stagedImages ?? {})).catch(() => {});
      return saved;
    }

    return {
      appendSelectionToPage,
      findExistingCapture,
      prepareCaptureMedia,
      saveCaptureToNotion
    };
  }

  return { createNotionRepository };
});
