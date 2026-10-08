/**
 * The archive database's columns: a fixed key, a Chinese and an English name and a type for each, the
 * options of 來源, the payload that creates the database, and the column map that ties each key to the
 * column's Notion id.
 *
 * The rest of the extension names columns by key only. Notion is reached through the ids in the column
 * map, so a column the user renames keeps working and an archive can be in either language. Builds plain
 * objects only; background/archive.js fetches the data source and stores the map.
 */
(function attachSavourNotionSchema(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("../lib/shared.js")
    : root.SavourShared;
  const api = factory(shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourNotionSchema = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNotionSchema(/** @type {typeof import("../lib/shared.js")} */ shared) {
  "use strict";

  // ---- Columns and options ----

  /** @typedef {"zh" | "en"} Language */
  /** @typedef {{ type: string, names: Record<Language, string> }} ColumnDefinition */

  // In the order a new archive lists them.
  /** @type {Readonly<Record<string, ColumnDefinition>>} */
  const COLUMNS = Object.freeze({
    title: { type: "title", names: { zh: "名稱", en: "Name" } },
    sourceUrl: { type: "url", names: { zh: "來源網址", en: "Source URL" } },
    author: { type: "rich_text", names: { zh: "作者", en: "Author" } },
    publishedAt: { type: "date", names: { zh: "發布時間", en: "Published" } },
    savedAt: { type: "date", names: { zh: "保存時間", en: "Saved" } },
    postId: { type: "rich_text", names: { zh: "貼文編號", en: "Post ID" } },
    captureKey: { type: "rich_text", names: { zh: "擷取鍵", en: "Capture key" } },
    topicTag: { type: "select", names: { zh: "Threads 主題", en: "Threads topic" } },
    platform: { type: "select", names: { zh: "來源", en: "Source" } },
    contentRange: { type: "rich_text", names: { zh: "原文範圍", en: "Original range" } }
  });

  // The options of 來源, one per site the extension saves from.
  /** @type {Readonly<Record<string, { names: Record<Language, string>, color: string }>>} */
  const PLATFORM_OPTIONS = Object.freeze({
    threads: { names: { zh: "Threads", en: "Threads" }, color: "default" },
    plurk: { names: { zh: "噗浪", en: "Plurk" }, color: "orange" },
    x: { names: { zh: "X", en: "X" }, color: "gray" },
    instagram: { names: { zh: "Instagram", en: "Instagram" }, color: "pink" },
    web: { names: { zh: "網頁", en: "Web" }, color: "blue" },
    youtube: { names: { zh: "YouTube", en: "YouTube" }, color: "red" },
    linkedin: { names: { zh: "LinkedIn", en: "LinkedIn" }, color: "purple" },
    facebook: { names: { zh: "Facebook", en: "Facebook" }, color: "green" }
  });

  // The Chinese column names by key. Tests and the default column map use them.
  const PROPERTY_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(COLUMNS).map(([key, column]) => [key, column.names.zh])
  ));

  // Columns the extension needs but readers do not; they are hidden in the archive's views.
  const INTERNAL_COLUMNS = Object.freeze(["captureKey", "postId", "contentRange"]);
  // View types whose configuration has no other required fields, so only visibility is sent.
  const VIEW_TYPES_WITH_COLUMNS = new Set(["table", "list", "gallery"]);

  /** @returns {Language} */
  function languageOf(/** @type {any} */ value) {
    return value === "en" ? "en" : "zh";
  }

  function columnDefinition(/** @type {string} */ key, /** @type {Language} */ language) {
    const column = COLUMNS[key];
    if (column.type !== "select") return { [column.type]: {} };
    const options = key === "platform"
      ? Object.values(PLATFORM_OPTIONS).map(option => ({ name: option.names[language], color: option.color }))
      : [];
    return { select: { options } };
  }

  /**
   * The columns of a new archive, named in `language`.
   * @param {Language} [language]
   * @returns {Record<string, any>} column name -> Notion property definition
   */
  function archivePropertySchema(language = "zh") {
    const lang = languageOf(language);
    return Object.fromEntries(Object.keys(COLUMNS).map(key => [COLUMNS[key].names[lang], columnDefinition(key, lang)]));
  }

  // ---- Column map ----

  /**
   * The column map before an archive has been read: ids are the Chinese names, which Notion also
   * accepts, so payloads built without a map stay valid for an archive with the default names.
   * @returns {import("../types").ColumnMap}
   */
  function defaultColumnMap() {
    return {
      dataSourceId: "",
      language: "zh",
      columns: Object.fromEntries(Object.entries(COLUMNS).map(([key, column]) => [key, { id: column.names.zh, name: column.names.zh }])),
      platformOptions: Object.fromEntries(Object.entries(PLATFORM_OPTIONS).map(([key, option]) => [key, { id: "", name: option.names.zh }]))
    };
  }

  /**
   * Ties each column key to a property of the data source: the id saved last time when that property is
   * still there with the right type, otherwise a property named in either language with the right type,
   * and for the title the data source's one title property whatever it is called.
   * @param {Record<string, any>} properties the data source's `properties`, keyed by name
   * @param {import("../types").ColumnMap | null} saved the map saved for this data source, if any
   * @param {Language} language names for columns that have to be added
   * @returns {{ map: import("../types").ColumnMap, missing: Record<string, any>, conflicts: Array<{ name: string, actualType: string, expectedType: string }> }}
   *   `missing` is ready to send as the `properties` of a data source update; `conflicts` lists names
   *   that are taken by a property of another type, so the column cannot be added under them
   */
  function resolveColumnMap(properties, saved, language) {
    const lang = languageOf(saved?.language ?? language);
    const entries = Object.entries(properties ?? {}).map(([name, property]) => ({
      name,
      id: String(property?.id || name),
      type: String(property?.type || Object.keys(property ?? {}).find(field => field !== "id" && field !== "name") || ""),
      property
    }));
    const used = new Set();
    /** @type {Record<string, { id: string, name: string }>} */
    const columns = {};
    /** @type {Record<string, any>} */
    const missing = {};
    const conflicts = [];

    for (const [key, column] of Object.entries(COLUMNS)) {
      const fits = (/** @type {any} */ entry) => entry && !used.has(entry.id) && entry.type === column.type;
      const savedId = saved?.columns?.[key]?.id;
      let found = savedId ? entries.find(entry => entry.id === savedId && fits(entry)) : undefined;
      if (!found && key === "title") found = entries.find(fits);
      if (!found) found = entries.find(entry => fits(entry) && Object.values(column.names).includes(entry.name));
      if (found) {
        used.add(found.id);
        columns[key] = { id: found.id, name: found.name };
        continue;
      }
      const name = column.names[lang];
      const taken = entries.find(entry => entry.name === name);
      if (taken) {
        conflicts.push({ name, actualType: taken.type, expectedType: column.type });
        continue;
      }
      missing[name] = columnDefinition(key, lang);
      columns[key] = { id: name, name };
    }

    const platform = entries.find(entry => entry.id === columns.platform?.id);
    const options = /** @type {any[]} */ (platform?.property?.select?.options ?? []);
    /** @type {Record<string, { id: string, name: string }>} */
    const platformOptions = {};
    for (const [key, option] of Object.entries(PLATFORM_OPTIONS)) {
      const savedId = saved?.platformOptions?.[key]?.id;
      const found = (savedId && options.find(item => item?.id === savedId))
        || options.find(item => Object.values(option.names).includes(item?.name));
      // An option the archive lacks is written by name, and Notion adds it.
      platformOptions[key] = found ? { id: String(found.id ?? ""), name: String(found.name) } : { id: "", name: option.names[lang] };
    }

    return {
      map: { dataSourceId: String(saved?.dataSourceId ?? ""), language: lang, columns, platformOptions },
      missing,
      conflicts
    };
  }

  /**
   * A page's value for one column. Notion keys values by column name but includes each column's id,
   * so the id finds it after a rename; the name covers values built without ids.
   * @param {Record<string, any> | undefined} properties a page's `properties`
   * @param {{ id: string, name: string } | undefined} column
   */
  function pageProperty(properties, column) {
    if (!properties || !column) return undefined;
    return Object.values(properties).find(value => value?.id === column.id) ?? properties[column.name] ?? properties[column.id];
  }

  // ---- Views ----

  // The view update that hides the internal columns, or null when the view needs no change or is
  // of a type whose configuration cannot be sent on its own. Every other column keeps its place and
  // visibility; dataSourceProperties ({ name: { id } }) supplies ids for columns the view has not listed.
  function hiddenColumnsViewUpdate(/** @type {any} */ view, /** @type {any} */ dataSourceProperties, dataSourceId = "", /** @type {import("../types").ColumnMap} */ columnMap = defaultColumnMap()) {
    if (!VIEW_TYPES_WITH_COLUMNS.has(view?.type)) return null;
    // A database can hold other data sources; their views have other columns.
    if (dataSourceId && shared.extractNotionId(view.data_source_id) !== shared.extractNotionId(dataSourceId)) return null;
    const knownIds = new Set(Object.values(dataSourceProperties ?? {}).map(property => property?.id).filter(Boolean));
    const internalIds = new Set(INTERNAL_COLUMNS
      .map(key => columnMap.columns[key])
      .map(column => (knownIds.has(column?.id) ? column.id : dataSourceProperties?.[column?.name]?.id))
      .filter(Boolean));
    if (!internalIds.size) return null;
    const listed = Array.isArray(view.configuration?.properties) ? view.configuration.properties : null;
    const properties = listed
      ? listed.map((/** @type {any} */ item) => (internalIds.has(item?.property_id) ? { ...item, visible: false } : item))
      : Object.values(dataSourceProperties ?? {})
        .filter(property => property?.id)
        .map(property => ({ property_id: property.id, visible: !internalIds.has(property.id) }));
    for (const id of internalIds) {
      if (!properties.some((/** @type {any} */ item) => item?.property_id === id)) properties.push({ property_id: id, visible: false });
    }
    const changed = !listed
      || properties.length !== listed.length
      || properties.some((/** @type {any} */ item, /** @type {number} */ index) => item.visible !== listed[index]?.visible);
    return changed ? { configuration: { type: view.type, properties } } : null;
  }

  // ---- New archive ----

  /**
   * The request that creates a new archive, with its columns named in `language`.
   * @param {string} name
   * @param {string} parentPageId
   * @param {Language} [language]
   */
  function createArchivePayload(name, parentPageId, language = "zh") {
    /** @type {any} */
    const payload = {
      title: [{ type: "text", text: { content: shared.cleanText(name) || shared.t("留己看") } }],
      description: [{ type: "text", text: { content: shared.t("保存你感興趣、想收藏，等之後慢慢消化的文字。") } }],
      is_inline: false,
      icon: { type: "emoji", emoji: "📥" },
      initial_data_source: {
        properties: archivePropertySchema(language)
      }
    };
    if (parentPageId) payload.parent = { type: "page_id", page_id: parentPageId };
    return payload;
  }

  return {
    COLUMNS,
    PLATFORM_OPTIONS,
    PROPERTY_NAMES,
    INTERNAL_COLUMNS,
    archivePropertySchema,
    createArchivePayload,
    defaultColumnMap,
    hiddenColumnsViewUpdate,
    pageProperty,
    resolveColumnMap
  };
});
