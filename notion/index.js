/**
 * Facade over notion/schema.js and notion/page-builder.js: the query bodies and page payloads
 * the background worker needs, behind one object (`SavourNotion`).
 *
 * Builds request bodies only; it does not send anything (notion/http.js and notion/repository.js do).
 */
(function attachSavourNotion(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("../lib/shared.js")
    : root.SavourShared;
  const schema = typeof module === "object" && module.exports
    ? require("./schema.js")
    : root.SavourNotionSchema;
  const pageBuilder = typeof module === "object" && module.exports
    ? require("./page-builder.js")
    : root.SavourNotionPageBuilder;
  const api = factory(shared, schema, pageBuilder);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SavourNotion = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createNotion(/** @type {typeof import("../lib/shared.js")} */ shared, /** @type {typeof import("./schema.js")} */ schema, /** @type {typeof import("./page-builder.js")} */ pageBuilder) {
  "use strict";

  const API_VERSION = "2026-03-11";
  const {
    PROPERTY_NAMES,
    archivePropertySchema,
    createArchivePayload,
    defaultColumnMap,
    pageProperty,
    resolveColumnMap
  } = schema;

  // The column map of the archive in use. background/archive.js sets it each time it reads the
  // archive; until then the default map (Chinese names) is used.
  let columnMap = defaultColumnMap();

  /** @param {import("../types").ColumnMap | null | undefined} map */
  function useColumnMap(map) {
    columnMap = map ?? defaultColumnMap();
  }

  /** @returns {import("../types").ColumnMap} */
  function currentColumnMap() {
    return columnMap;
  }

  const column = (/** @type {string} */ key) => columnMap.columns[key];
  const valueOf = (/** @type {any} */ page, /** @type {string} */ key) => pageProperty(page?.properties, column(key));

  // Hides the internal columns of the archive in use; see notion/schema.js.
  function hiddenColumnsViewUpdate(/** @type {any} */ view, /** @type {any} */ dataSourceProperties, dataSourceId = "", /** @type {{ arrange?: boolean }} */ options = {}) {
    return schema.hiddenColumnsViewUpdate(view, dataSourceProperties, dataSourceId, columnMap, options);
  }

  const {
    blocksPlainText,
    buildContinuationBlocks,
    buildPageChildren,
    buildSelectionAppendBlocks,
    captureTitleText,
    chunkBlocks,
    contentRangeFromPage,
    contentRangePayload,
    createPagePayload,
    previousVersionNoticeBlocks,
    refreshPagePropertiesPayload,
    savedThreadPositions,
    updatePagePayload
  } = pageBuilder.createNotionPageBuilder({ shared, schema, columns: () => columnMap });

  function queryByCaptureKeyPayload(/** @type {any} */ key) {
    return {
      filter: {
        property: column("captureKey").id,
        rich_text: { equals: key }
      },
      page_size: 1
    };
  }

  function queryAllCapturesPayload(startCursor = "") {
    return {
      page_size: 100,
      ...(startCursor ? { start_cursor: startCursor } : {})
    };
  }

  // Pages of the archive whose title contains the query, newest saved first.
  function archivePageSearchPayload(query = "", pageSize = 10) {
    const text = shared.cleanText(query).slice(0, 100);
    return {
      page_size: pageSize,
      ...(text ? { filter: { property: column("title").id, title: { contains: text } } } : {}),
      // Notion sorts by column name only, so the name read with the archive is used.
      sorts: [{ property: column("savedAt").name, direction: "descending" }]
    };
  }

  // Keeps only what the selection target picker shows.
  function archivePageSummary(/** @type {any} */ page) {
    const pageId = shared.extractNotionId(page?.id);
    if (!pageId || page.in_trash === true || page.archived === true) return null;
    const title = propertyText(valueOf(page, "title")).slice(0, 200) || "未命名貼文";
    return { pageId, title };
  }

  function dataSourceSearchPayload(startCursor = "") {
    return {
      page_size: 100,
      filter: { property: "object", value: "data_source" },
      ...(startCursor ? { start_cursor: startCursor } : {})
    };
  }

  // Keeps only what the options picker shows; schema and page data are never copied.
  function dataSourceSummary(/** @type {any} */ dataSource) {
    if (dataSource?.object !== "data_source" || dataSource.in_trash === true) return null;
    const id = shared.extractNotionId(dataSource.id);
    const databaseId = shared.extractNotionId(dataSource.parent?.database_id);
    if (!id || !databaseId) return null;
    const title = shared.cleanText((dataSource.title ?? []).map((/** @type {any} */ item) => item?.plain_text ?? item?.text?.content ?? "").join(""))
      .slice(0, 200) || "未命名資料庫";
    const emoji = dataSource.icon?.type === "emoji" ? String(dataSource.icon.emoji ?? "").slice(0, 16) : "";
    return { id, databaseId, title, emoji };
  }

  function propertyText(/** @type {any} */ property) {
    const values = property?.title ?? property?.rich_text ?? [];
    return shared.cleanText(values.map((/** @type {any} */ item) => item?.plain_text ?? item?.text?.content ?? "").join(""));
  }

  function savedRecordFromPage(/** @type {any} */ page) {
    const key = propertyText(valueOf(page, "captureKey"));
    if (!key) return null;
    return {
      key,
      value: {
        sourceUrl: valueOf(page, "sourceUrl")?.url ?? "",
        title: propertyText(valueOf(page, "title")) || "未命名貼文",
        author: propertyText(valueOf(page, "author")),
        notionPageId: page.id ?? "",
        notionUrl: page.url ?? "",
        savedAt: valueOf(page, "savedAt")?.date?.start ?? page.created_time ?? "",
        topicTag: valueOf(page, "topicTag")?.select?.name ?? ""
      }
    };
  }

  return {
    API_VERSION,
    PROPERTY_NAMES,
    archivePageSearchPayload,
    archivePageSummary,
    archivePropertySchema,
    blocksPlainText,
    buildContinuationBlocks,
    buildPageChildren,
    buildSelectionAppendBlocks,
    captureTitleText,
    chunkBlocks,
    contentRangeFromPage,
    contentRangePayload,
    createArchivePayload,
    createPagePayload,
    currentColumnMap,
    dataSourceSearchPayload,
    dataSourceSummary,
    hiddenColumnsViewUpdate,
    previousVersionNoticeBlocks,
    refreshPagePropertiesPayload,
    queryAllCapturesPayload,
    queryByCaptureKeyPayload,
    resolveColumnMap,
    savedRecordFromPage,
    savedThreadPositions,
    updatePagePayload,
    useColumnMap
  };
});
