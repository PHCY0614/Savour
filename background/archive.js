/**
 * The archive database: resolve a pasted address to a data source, list the databases the integration can see, create a new archive in the interface language, test the connection, and keep the column map (notion/schema.js) and the database's columns up to date. Switching databases clears only local records.
 *
 * Created once by background.js with `createArchive(deps)`; `deps` carries the shared services
 * (storage, the Notion request function, the queue) so this file has no globals of its own.
 */
(function attachSavourBackgroundArchive(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourBackgroundArchive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBackgroundArchiveModule() {
  "use strict";

  /**
   * @param {Pick<import("../types").Services, "CONFIG_KEY" | "I" | "N" | "S" | "isProcessing" | "notionRequest" | "readConfig" | "readState" | "readToken" | "requireToken" | "scheduleQueue" | "withStateLock" | "writeState">} deps services from background.js
   */
  function createArchive(deps) {
    const { CONFIG_KEY, I, N, S, isProcessing, notionRequest, readConfig, readState, readToken, requireToken, scheduleQueue, withStateLock, writeState } = deps;

    let schemaReadyDataSourceId = "";

    async function resolveArchiveTarget(/** @type {any} */ target, /** @type {string} */ token) {
      const input = String(target ?? "").trim();
      if (!input) return { dataSourceId: "", databaseId: "", databaseUrl: "" };

      const databaseIdFromUrl = S.extractNotionDatabaseId(input);
      if (databaseIdFromUrl) {
        const database = await notionRequest(`/v1/databases/${databaseIdFromUrl}`, {
          method: "GET",
          token,
          retrySafe: true
        });
        const sources = database.data_sources ?? [];
        if (!sources.length) throw new Error(S.t("這個 Notion 資料庫沒有可使用的 Data Source"));
        if (sources.length > 1) {
          throw new Error(S.t("這個 Notion 資料庫包含多個 Data Source，無法安全判斷要使用哪一個。請改貼目標 Data Source ID。"));
        }
        return {
          dataSourceId: sources[0].id,
          databaseId: database.id || databaseIdFromUrl,
          databaseUrl: database.url || input
        };
      }

      if (/^https?:\/\//i.test(input)) {
        throw new Error(S.t("既有整理庫請貼上完整的 Notion 資料庫網址，請不要貼一般 Notion 頁面或其他網站連結"));
      }

      const dataSourceId = S.extractNotionId(input);
      if (!dataSourceId) {
        throw new Error(S.t("既有整理庫請貼上完整的 Notion 資料庫網址"));
      }
      const dataSource = await notionRequest(`/v1/data_sources/${dataSourceId}`, {
        method: "GET",
        token,
        retrySafe: true
      });
      const databaseId = dataSource.parent?.database_id || "";
      let databaseUrl = "";
      if (databaseId) {
        const database = await notionRequest(`/v1/databases/${databaseId}`, {
          method: "GET",
          token,
          retrySafe: true
        });
        databaseUrl = database.url || "";
      }
      return { dataSourceId: dataSource.id || dataSourceId, databaseId, databaseUrl };
    }

    const MAX_NOTION_DATA_SOURCES = 300;

    async function listNotionDataSources(suppliedToken = "") {
      const token = String(suppliedToken ?? "").trim() || await readToken();
      if (!token) throw new Error(S.t("請先輸入 Notion Integration Token"));
      const byId = new Map();
      const seenCursors = new Set();
      let cursor = "";
      let scanned = 0;
      let limitReached = false;
      while (scanned < MAX_NOTION_DATA_SOURCES) {
        const response = await notionRequest("/v1/search", {
          method: "POST",
          body: N.dataSourceSearchPayload(cursor),
          token,
          retrySafe: true
        });
        const results = (response.results ?? []).slice(0, MAX_NOTION_DATA_SOURCES - scanned);
        scanned += results.length;
        for (const result of results) {
          const summary = N.dataSourceSummary(result);
          if (summary && !byId.has(summary.id)) byId.set(summary.id, summary);
        }
        const nextCursor = typeof response.next_cursor === "string" ? response.next_cursor : "";
        if (scanned >= MAX_NOTION_DATA_SOURCES) {
          limitReached = Boolean(response.has_more);
          break;
        }
        if (!response.has_more || !nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      const collator = new Intl.Collator("zh-Hant-TW", { numeric: true, sensitivity: "base" });
      const dataSources = [...byId.values()].sort((left, right) => (
        collator.compare(left.title, right.title) || left.id.localeCompare(right.id)
      ));
      const config = await readConfig();
      return {
        dataSources,
        limitReached,
        currentDataSourceId: S.extractNotionId(config.dataSourceId)
      };
    }

    // The local saved index belongs to one data source; switching while a save is running could mix them.
    async function assertDataSourceChangeAllowed() {
      // With no database set up yet, waiting items have nowhere to go (saves made before setup was finished);
      // they are dropped so they cannot block the first setup.
      if (!(await readConfig()).dataSourceId) {
        await withStateLock(async () => {
          const pending = await readState();
          pending.queue = pending.queue.filter((item) => item.status !== "pending");
          await writeState(pending);
        });
      }
      const state = await readState();
      if (isProcessing() || state.queue.some((item) => item.status === "pending" || item.status === "processing")) {
        throw new Error(S.t("還有文章正在保存，請等「等待中」歸零後再更換 Notion 整理庫"));
      }
    }

    // Clears only this extension's local records for the old data source; Notion pages are never touched.
    async function resetLocalIndexForDataSource(/** @type {any} */ previousId, /** @type {any} */ nextId) {
      schemaReadyDataSourceId = "";
      N.useColumnMap(null);
      if (!nextId || previousId === nextId) return;
      await withStateLock(async () => {
        const state = await readState();
        state.saved = {};
        state.recent = [];
        state.lastSyncedAt = "";
        state.selectionAppends = {};
        state.appendTargets = [];
        state.queue = state.queue.filter((item) => item.status !== "failed");
        await writeState(state);
      });
    }

    async function createArchive() {
      const config = await readConfig();
      const token = await requireToken();
      const parentPageId = S.extractNotionId(config.parentPageUrl);
      if (!parentPageId) {
        throw new Error(S.t("請先填入已授權給 Notion Integration 的空白頁面網址"));
      }
      await assertDataSourceChangeAllowed();
      const response = await notionRequest("/v1/databases", {
        method: "POST",
        body: N.createArchivePayload(config.archiveName, parentPageId, I.getLanguage() === "en" ? "en" : "zh"),
        token,
        retrySafe: false
      });
      const dataSourceId = response.data_sources?.[0]?.id ?? "";
      if (!dataSourceId) throw new Error(S.t("Notion 已建立整理庫，但回應中沒有資料來源 ID"));
      const next = {
        ...config,
        archiveTarget: response.url || dataSourceId,
        dataSourceId,
        databaseId: response.id ?? "",
        databaseUrl: response.url ?? ""
      };
      await chrome.storage.local.set({ [CONFIG_KEY]: next });
      await resetLocalIndexForDataSource(config.dataSourceId, dataSourceId);
      // The new archive's default view shows every column until its internal ones are hidden.
      await ensureArchiveSchema(dataSourceId, token, { force: true, arrange: true }).catch(() => {});
      scheduleQueue(100);
      return { ...next, hasToken: true };
    }

    async function testNotionAuth() {
      const token = await requireToken();
      const response = await notionRequest("/v1/users/me", {
        method: "GET",
        token,
        retrySafe: true
      });
      return { id: response.id, object: response.object };
    }

    async function testConnection() {
      let config = await readConfig();
      const token = await requireToken();
      if (!config.dataSourceId && config.archiveTarget) {
        config = { ...config, ...(await resolveArchiveTarget(config.archiveTarget, token)) };
        await chrome.storage.local.set({ [CONFIG_KEY]: config });
      }
      if (!config.dataSourceId) throw new Error(S.t("尚未建立整理庫或填入既有 Notion 資料庫網址"));
      const response = await ensureArchiveSchema(config.dataSourceId, token, { force: true });
      return {
        id: response.dataSource.id,
        object: response.dataSource.object,
        title: response.dataSource.title ?? [],
        databaseUrl: config.databaseUrl,
        addedProperties: response.addedProperties
      };
    }


    /**
     * Reads the archive once per worker (or always with `options.force`): ties every column to its id,
     * adds the columns it lacks (named in the archive's language, the interface language for a new
     * one), stores the column map and hands it to notion/index.js. Throws when a column cannot be
     * added because its name is taken by a column of another type.
     * @param {string} dataSourceId
     * @param {string} token
     * @param {{ force?: boolean, arrange?: boolean }} [options] `arrange` puts a new archive's columns in reading order
     * @returns {Promise<{ dataSource: any, addedProperties: string[] }>}
     */
    async function ensureArchiveSchema(dataSourceId, token, options = {}) {
      if (!options.force && schemaReadyDataSourceId === dataSourceId) {
        return { dataSource: { id: dataSourceId, object: "data_source" }, addedProperties: [] };
      }
      let dataSource = await notionRequest(`/v1/data_sources/${dataSourceId}`, {
        method: "GET",
        token,
        retrySafe: true
      });
      const config = await readConfig();
      const saved = S.extractNotionId(config.columnMap?.dataSourceId) === S.extractNotionId(dataSourceId) ? config.columnMap : null;
      const language = I.getLanguage() === "en" ? "en" : "zh";
      let resolved = N.resolveColumnMap(dataSource.properties, saved, language);
      const [conflict] = resolved.conflicts;
      if (conflict) {
        throw new Error(
          S.t("Notion 欄位「{name}」目前是 {actual}，但擴充功能需要 {expected}；請先修正欄位類型後再測試連線", { name: conflict.name, actual: conflict.actualType || S.t("未知類型"), expected: conflict.expectedType })
        );
      }
      const addedProperties = Object.keys(resolved.missing);
      if (addedProperties.length) {
        dataSource = await notionRequest(`/v1/data_sources/${dataSourceId}`, {
          method: "PATCH",
          body: { properties: resolved.missing },
          token,
          retrySafe: false
        });
        // The added columns get their ids from Notion's answer.
        resolved = N.resolveColumnMap(dataSource.properties, resolved.map, language);
      }
      const columnMap = { ...resolved.map, dataSourceId };
      N.useColumnMap(columnMap);
      if (JSON.stringify(columnMap) !== JSON.stringify(saved)) {
        const latest = await readConfig();
        await chrome.storage.local.set({ [CONFIG_KEY]: { ...latest, columnMap } });
      }
      schemaReadyDataSourceId = dataSourceId;
      await ensureInternalColumnsHidden(dataSource, token, { arrange: Boolean(options.arrange) });
      return { dataSource, addedProperties };
    }

    // Hides 擷取鍵, 貼文編號 and 原文範圍 in the archive's views, once per data source: the first
    // time an archive is created or connected. Columns the user shows again later stay visible. Views
    // are only presentation, so a failure here never stops saving; it is tried again next time.
    async function ensureInternalColumnsHidden(/** @type {any} */ dataSource, /** @type {string} */ token, { arrange = false } = {}) {
      const config = await readConfig();
      const dataSourceId = S.extractNotionId(dataSource?.id);
      if (!dataSourceId || S.extractNotionId(config.internalColumnsHiddenFor) === dataSourceId) return;
      const databaseId = S.extractNotionId(dataSource.parent?.database_id || config.databaseId);
      if (!databaseId || !dataSource.properties) return;
      try {
        const listed = await notionRequest(`/v1/views?database_id=${databaseId}&page_size=100`, {
          method: "GET",
          token,
          retrySafe: true
        });
        for (const reference of listed.results ?? []) {
          const view = reference.type ? reference : await notionRequest(`/v1/views/${reference.id}`, {
            method: "GET",
            token,
            retrySafe: true
          });
          const update = N.hiddenColumnsViewUpdate(view, dataSource.properties, dataSourceId, { arrange });
          if (!update) continue;
          await notionRequest(`/v1/views/${view.id}`, { method: "PATCH", body: update, token, retrySafe: true });
        }
        const latest = await readConfig();
        await chrome.storage.local.set({ [CONFIG_KEY]: { ...latest, internalColumnsHiddenFor: dataSourceId } });
      } catch {
        // See above.
      }
    }

    return {
      assertDataSourceChangeAllowed,
      createArchive,
      ensureArchiveSchema,
      listNotionDataSources,
      resetLocalIndexForDataSource,
      resolveArchiveTarget,
      testConnection,
      testNotionAuth
    };
  }

  return { createArchive };
});
