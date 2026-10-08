/**
 * What the popup shows and the maintenance jobs behind its menu: status counts, the list of incomplete threads, syncing the local index with Notion, applying icon rules, and exporting the saved list.
 *
 * Created once by background.js with `createStatusSync(deps)`; `deps` carries the shared services
 * (storage, the Notion request function, the queue) so this file has no globals of its own.
 */
(function attachSavourBackgroundStatusSync(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourBackgroundStatusSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundStatusSyncModule() {
  "use strict";

  /**
   * @param {Pick<import("../types").Services, "INCOMPLETE_THREAD_FLAG" | "N" | "S" | "ensureArchiveSchema" | "isProcessing" | "notionRequest" | "readConfig" | "readState" | "readToken" | "requireToken" | "withStateLock" | "writeState">} deps services from background.js
   */
  function createStatusSync(deps) {
    const { INCOMPLETE_THREAD_FLAG, N, S, ensureArchiveSchema, isProcessing, notionRequest, readConfig, readState, readToken, requireToken, withStateLock, writeState } = deps;

    /**
     * What the popup shows: counts, recent items and whether setup is complete.
     * @returns {Promise<import("../types").Status>}
     */
    async function getStatus() {
      const [state, config, token] = await Promise.all([readState(), readConfig(), readToken()]);
      return {
        configured: Boolean(token && config.dataSourceId),
        hasToken: Boolean(token),
        hasArchive: Boolean(config.dataSourceId),
        databaseUrl: config.databaseUrl,
        archiveName: config.archiveName,
        pending: state.queue.filter((item) => item.status === "pending" || item.status === "processing").length,
        failed: state.queue.filter((item) => item.status === "failed").length,
        saved: Object.keys(state.saved).length,
        incompleteThreads: incompleteThreadItems(state),
        recent: state.recent,
        lastSyncedAt: state.lastSyncedAt || ""
      };
    }

    function incompleteThreadItems(/** @type {import("../types").State} */ state) {
      return Object.entries(state?.saved ?? {})
        .map(([key, value]) => {
          if (!(value?.reviewItems ?? []).includes(INCOMPLETE_THREAD_FLAG)) return null;
          const sourceUrl = S.normalizeThreadsUrl(value?.sourceUrl ?? "");
          const parsed = S.parseThreadsUrl(sourceUrl);
          if (!parsed.postId) return null;
          return {
            key,
            title: S.cleanText(value?.title) || `${parsed.handle || "Threads"} · ${parsed.postId}`,
            sourceUrl,
            notionUrl: String(value?.notionUrl ?? ""),
            savedAt: String(value?.savedAt ?? "")
          };
        })
        .filter(item => item !== null)
        .sort((left, right) => {
          const timeDifference = (Date.parse(left.savedAt) || 0) - (Date.parse(right.savedAt) || 0);
          return timeDifference || left.title.localeCompare(right.title, "zh-Hant");
        })
        .slice(0, 200);
    }

    async function syncNotionState() {
      const config = await readConfig();
      const token = await requireToken();
      if (!config.dataSourceId) throw new Error(S.t("尚未建立整理庫或填入既有 Notion 資料庫網址"));
      const currentState = await readState();
      if (isProcessing() || currentState.queue.some((item) => item.status === "pending" || item.status === "processing")) {
        throw new Error(S.t("請先等待保存佇列完成，再同步 Notion 狀態"));
      }
      await ensureArchiveSchema(config.dataSourceId, token, { force: true });

      /** @type {any} */ const remoteSaved = {};
      let cursor = "";
      do {
        const response = await notionRequest(`/v1/data_sources/${config.dataSourceId}/query`, {
          method: "POST",
          body: N.queryAllCapturesPayload(cursor),
          token,
          retrySafe: true
        });
        for (const page of response.results ?? []) {
          const record = N.savedRecordFromPage(page);
          if (record) remoteSaved[record.key] = record.value;
        }
        cursor = response.has_more ? response.next_cursor ?? "" : "";
      } while (cursor);

      const lastSyncedAt = S.nowIso();
      return withStateLock(async () => {
        const state = await readState();
        // Notion does not store which author replies were saved or what may be missing from a page;
        // the local record keeps both.
        for (const [key, record] of Object.entries(remoteSaved)) {
          record.authorReplyPostIds = [...(state.saved[key]?.authorReplyPostIds ?? [])];
          record.reviewItems = [...(state.saved[key]?.reviewItems ?? [])];
        }

        const before = new Set(Object.keys(state.saved));
        const after = new Set(Object.keys(remoteSaved));
        const added = [...after].filter(key => !before.has(key)).length;
        const removed = [...before].filter(key => !after.has(key)).length;
        state.saved = remoteSaved;
        // Notion is the source of truth; a selection removed from a page there may be added again.
        state.selectionAppends = {};
        state.lastSyncedAt = lastSyncedAt;
        await writeState(state);
        return { synced: after.size, added, removed, lastSyncedAt };
      });
    }

    async function exportAudit() {
      const [state, config] = await Promise.all([readState(), readConfig()]);
      const pending = state.queue.filter((item) => item.status === "pending" || item.status === "processing");
      const failed = state.queue.filter((item) => item.status === "failed");
      return {
        exportedAt: S.nowIso(),
        archiveName: config.archiveName,
        lastSyncedAt: state.lastSyncedAt || "",
        savedCount: Object.keys(state.saved).length,
        pendingCount: pending.length,
        failedCount: failed.length,
        pending,
        failed,
        saved: Object.entries(state.saved).map(([key, value]) => ({ key, ...value }))
      };
    }

    return {
      exportAudit,
      getStatus,
      syncNotionState
    };
  }

  return { createStatusSync };
});
