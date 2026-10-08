"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../notion/index.js");
const I = require("../i18n/index.js");
const M = require("../model/capture-model.js");
const { createChromeMock } = require("./helpers/chrome-mock");

globalThis.SavourShared = require("../lib/shared.js");
globalThis.SavourNotion = N;
globalThis.importScripts = () => undefined;
globalThis.chrome = createChromeMock();
chrome.runtime.id = "extension-id";
chrome.runtime.getURL = file => `chrome-extension://extension-id/${file}`;
const background = require("../background.js");

const PAGE_SENDER = { id: "extension-id", url: "chrome-extension://extension-id/pages/options/options.html" };
const DATA_SOURCE_ID = "11111111-1111-1111-1111-111111111111";
const DATABASE_ID = "22222222-2222-2222-2222-222222222222";
const ZH_NAMES = ["名稱", "來源網址", "作者", "發布時間", "保存時間", "貼文編號", "擷取鍵", "Threads 主題", "來源", "原文範圍"];
const EN_NAMES = ["Name", "Source URL", "Author", "Published", "Saved", "Post ID", "Capture key", "Threads topic", "Source", "Original range"];

test.afterEach(() => {
  I.setLanguage("zh");
  N.useColumnMap(null);
});

test.after(() => {
  delete globalThis.chrome;
  delete globalThis.importScripts;
  delete globalThis.SavourShared;
  delete globalThis.SavourNotion;
});

// The data source Notion returns for a schema: every column with an id, options with ids.
function dataSourceFor(schema, idPrefix = "p") {
  return Object.fromEntries(Object.entries(schema).map(([name, definition], index) => {
    const type = Object.keys(definition)[0];
    const property = { id: `${idPrefix}${index}`, name, type, [type]: structuredClone(definition[type]) };
    if (type === "select") {
      property.select.options = (definition.select.options ?? []).map((option, optionIndex) => ({ ...option, id: `${idPrefix}${index}-o${optionIndex}` }));
    }
    return [name, property];
  }));
}

function jsonResponse(value, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, async text() { return JSON.stringify(value); } };
}

// Runs `task` against a fake Notion whose data source has `properties`; PATCH adds the sent columns.
async function withNotion(properties, task) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let current = structuredClone(properties);
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace("https://api.notion.com", "");
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method, body });
    if (path === "/v1/databases" && options.method === "POST") {
      current = dataSourceFor(body.initial_data_source.properties);
      return jsonResponse({ id: DATABASE_ID, url: "https://www.notion.so/archive", data_sources: [{ id: DATA_SOURCE_ID }] });
    }
    if (path === `/v1/data_sources/${DATA_SOURCE_ID}` && options.method === "PATCH") {
      const added = dataSourceFor(body.properties, "new");
      current = { ...current, ...added };
    }
    if (path === `/v1/data_sources/${DATA_SOURCE_ID}`) {
      return jsonResponse({ id: DATA_SOURCE_ID, object: "data_source", parent: { database_id: DATABASE_ID }, properties: current });
    }
    if (path.startsWith("/v1/views")) return jsonResponse({ results: [] });
    return jsonResponse({});
  };
  try {
    return await task(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function resetConfig(extra = {}) {
  await chrome.storage.local.clear();
  await chrome.storage.session.set({ notionToken: "token" });
  await chrome.storage.local.set({ savourConfig: { ...background.DEFAULT_CONFIG, dataSourceId: DATA_SOURCE_ID, ...extra } });
}

async function savedColumnMap() {
  return (await chrome.storage.local.get("savourConfig")).savourConfig.columnMap;
}

// A saved web article; `sourceUrl` decides its 來源 option.
function capture(sourceUrl = "https://blog.example.com/post") {
  return M.normalizeCapture({
    platform: "web",
    captureType: "post",
    sourceUrl,
    title: "文章標題",
    author: "example",
    captureValidation: { version: 2, source: "web-page", validated: true },
    articleBlocks: [{ type: "paragraph", spans: [{ text: "內文" }] }]
  }, { sourceType: "page" });
}

// ---- New archives ----

test("新整理庫只有 10 個欄位，名稱與「來源」選項跟著介面語言", () => {
  assert.deepEqual(Object.keys(N.archivePropertySchema("zh")), ZH_NAMES);
  assert.deepEqual(Object.keys(N.archivePropertySchema("en")), EN_NAMES);
  const zhOptions = N.archivePropertySchema("zh")["來源"].select.options.map(option => option.name);
  const enOptions = N.archivePropertySchema("en").Source.select.options.map(option => option.name);
  assert.deepEqual(zhOptions, ["Threads", "噗浪", "X", "Instagram", "網頁", "YouTube", "LinkedIn", "Facebook"]);
  assert.deepEqual(enOptions, ["Threads", "Plurk", "X", "Instagram", "Web", "YouTube", "LinkedIn", "Facebook"]);
  const payload = N.createArchivePayload("For Later Me", "12345678-90ab-cdef-1234-567890abcdef", "en");
  assert.deepEqual(Object.keys(payload.initial_data_source.properties), EN_NAMES);
});

test("英文介面建立的整理庫用英文欄位，之後寫入一律用欄位 ID 與選項 ID", async () => {
  // The worker takes the interface language from the settings.
  await resetConfig({ dataSourceId: "", uiLanguage: "en", parentPageUrl: "https://www.notion.so/Parent-1234567890abcdef1234567890abcdef" });
  await withNotion({}, async requests => {
    await background.handleMessage({ type: "CREATE_ARCHIVE" }, PAGE_SENDER);
    const create = requests.find(request => request.path === "/v1/databases");
    assert.deepEqual(Object.keys(create.body.initial_data_source.properties), EN_NAMES);
    assert.equal(requests.some(request => request.method === "PATCH" && request.path.startsWith("/v1/data_sources/")), false);
  });
  const map = await savedColumnMap();
  assert.equal(map.language, "en");
  assert.equal(map.dataSourceId, DATA_SOURCE_ID);
  assert.deepEqual(map.columns.title, { id: "p0", name: "Name" });
  assert.deepEqual(map.platformOptions.plurk, { id: "p8-o1", name: "Plurk" });
  assert.deepEqual(map.platformOptions.web, { id: "p8-o4", name: "Web" });

  const payload = N.createPagePayload(capture(), DATA_SOURCE_ID);
  assert.equal(payload.properties.p0.title[0].text.content, "文章標題");
  assert.deepEqual(payload.properties.p8.select, { id: "p8-o4" });
  assert.equal(payload.properties.p6.rich_text[0].text.content, "web:https://blog.example.com/post");
  assert.equal(Object.keys(payload.properties).some(key => ZH_NAMES.includes(key) || EN_NAMES.includes(key)), false);
});

// ---- Connecting and reading an archive ----

test("中文整理庫連線時直接沿用，不補欄位也不改名", async () => {
  await resetConfig();
  await withNotion(dataSourceFor(N.archivePropertySchema("zh")), async requests => {
    const result = await background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true });
    assert.deepEqual(result.addedProperties, []);
    assert.equal(requests.filter(request => request.method === "PATCH").length, 0);
  });
  const map = await savedColumnMap();
  assert.equal(map.language, "zh");
  assert.deepEqual(map.columns.captureKey, { id: "p6", name: "擷取鍵" });
});

test("使用者改過名的欄位靠 ID 繼續使用；標題欄叫什麼都不會被改名", async () => {
  await resetConfig();
  const properties = dataSourceFor(N.archivePropertySchema("zh"));
  await withNotion(properties, () => background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true }));

  // The user renames 作者 and the title column in Notion; the ids stay.
  const renamed = Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const next = { 作者: "寫的人", 名稱: "標題", 保存時間: "存下時間" }[name] ?? name;
    return [next, { ...property, name: next }];
  }));
  await withNotion(renamed, async requests => {
    const result = await background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true });
    assert.deepEqual(result.addedProperties, []);
    assert.equal(requests.filter(request => request.method === "PATCH").length, 0);
  });
  const map = await savedColumnMap();
  assert.deepEqual(map.columns.author, { id: "p2", name: "寫的人" });
  assert.deepEqual(map.columns.title, { id: "p0", name: "標題" });

  const page = {
    id: "page",
    properties: {
      標題: { id: "p0", title: [{ plain_text: "改名後的標題" }] },
      寫的人: { id: "p2", rich_text: [{ plain_text: "someone" }] },
      擷取鍵: { id: "p6", rich_text: [{ plain_text: "plurk:abc123" }] }
    }
  };
  const record = N.savedRecordFromPage(page);
  assert.equal(record.key, "plurk:abc123");
  assert.equal(record.value.title, "改名後的標題");
  assert.equal(record.value.author, "someone");
  // Notion sorts by name only, so the search sorts by the name read with the archive.
  assert.deepEqual(N.archivePageSearchPayload("abc").sorts, [{ property: "存下時間", direction: "descending" }]);
  assert.equal(N.archivePageSearchPayload("abc").filter.property, "p0");
  assert.equal(N.queryByCaptureKeyPayload("plurk:abc123").filter.property, "p6");
});

test("缺少的欄位用介面語言補上，補上後立刻取得欄位 ID", async () => {
  await resetConfig();
  I.setLanguage("en");
  const properties = dataSourceFor({ Title: { title: {} }, Author: { rich_text: {} } });
  await withNotion(properties, async requests => {
    const result = await background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true });
    const patch = requests.find(request => request.method === "PATCH");
    assert.deepEqual(Object.keys(patch.body.properties).sort(), EN_NAMES.filter(name => !["Name", "Author"].includes(name)).sort());
    assert.deepEqual(result.addedProperties.sort(), Object.keys(patch.body.properties).sort());
  });
  const map = await savedColumnMap();
  assert.deepEqual(map.columns.title, { id: "p0", name: "Title" });
  assert.deepEqual(map.columns.author, { id: "p1", name: "Author" });
  assert.match(map.columns.captureKey.id, /^new\d+$/);
  assert.equal(map.columns.captureKey.name, "Capture key");
});

test("整理庫的語言在第一次讀取時決定，之後切換介面語言也不改", async () => {
  await resetConfig();
  await withNotion(dataSourceFor({ 名稱: { title: {} } }), () => background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true }));
  assert.equal((await savedColumnMap()).language, "zh");
  I.setLanguage("en");
  const { columns } = await savedColumnMap();
  // A column deleted later is added back in the archive's own language.
  const withoutAuthor = dataSourceFor(N.archivePropertySchema("zh"));
  delete withoutAuthor["作者"];
  for (const column of Object.values(columns)) {
    const property = Object.values(withoutAuthor).find(item => item.name === column.name);
    if (property) property.id = column.id;
  }
  await withNotion(withoutAuthor, async requests => {
    await background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true });
    assert.deepEqual(Object.keys(requests.find(request => request.method === "PATCH").body.properties), ["作者"]);
  });
});

test("要補的欄位名稱已被其他類型的欄位占用時，停止並說明是哪一欄", async () => {
  await resetConfig();
  const properties = dataSourceFor(N.archivePropertySchema("zh"));
  properties["來源網址"] = { ...properties["來源網址"], type: "rich_text", rich_text: {} };
  delete properties["來源網址"].url;
  await withNotion(properties, async requests => {
    await assert.rejects(
      background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true }),
      /Notion 欄位「來源網址」目前是 rich_text，但擴充功能需要 url/
    );
    assert.equal(requests.some(request => request.method === "PATCH"), false);
  });
  const { conflicts } = N.resolveColumnMap(properties, null, "zh");
  assert.deepEqual(conflicts, [{ name: "來源網址", actualType: "rich_text", expectedType: "url" }]);
});

test("中英文欄位名稱都認得；整理庫缺少的「來源」選項以整理庫的語言寫入", () => {
  const properties = dataSourceFor(N.archivePropertySchema("en"));
  properties.Source.select.options = properties.Source.select.options.filter(option => option.name !== "Facebook");
  const { map, missing, conflicts } = N.resolveColumnMap(properties, null, "zh");
  assert.deepEqual(missing, {});
  assert.deepEqual(conflicts, []);
  assert.equal(map.language, "zh");
  assert.deepEqual(map.columns.platform, { id: "p8", name: "Source" });
  assert.deepEqual(map.platformOptions.facebook, { id: "", name: "Facebook" });
  N.useColumnMap(map);
  const payload = N.createPagePayload(capture("https://www.facebook.com/samplepage/posts/pfbid02ABC"), DATA_SOURCE_ID);
  assert.deepEqual(payload.properties.p8.select, { name: "Facebook" });
});

// ---- Views ----

test("整理庫第一次連接時，在表格檢視隱藏內部欄位；之後不再重複，失敗也不影響保存", async () => {
  const properties = dataSourceFor(N.archivePropertySchema("zh"));
  const internalIds = ["擷取鍵", "貼文編號", "原文範圍"].map(name => properties[name].id);
  const originalFetch = globalThis.fetch;
  const requests = [];
  let viewsFail = false;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace("https://api.notion.com", "");
    requests.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    if (path.startsWith("/v1/views") && viewsFail) return jsonResponse({}, 404);
    if (path === `/v1/data_sources/${DATA_SOURCE_ID}`) {
      return jsonResponse({ id: DATA_SOURCE_ID, object: "data_source", parent: { database_id: DATABASE_ID }, properties });
    }
    if (path === `/v1/views?database_id=${DATABASE_ID}&page_size=100`) return jsonResponse({ results: [{ object: "view", id: "view-1" }] });
    if (path === "/v1/views/view-1" && options.method === "GET") {
      return jsonResponse({ id: "view-1", type: "table", data_source_id: DATA_SOURCE_ID, configuration: { type: "table", properties: null } });
    }
    return jsonResponse({});
  };
  try {
    await resetConfig({ internalColumnsHiddenFor: "" });
    viewsFail = true;
    await background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true });
    assert.equal((await chrome.storage.local.get("savourConfig")).savourConfig.internalColumnsHiddenFor, "");

    viewsFail = false;
    requests.length = 0;
    await background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true });
    const patch = requests.find(request => request.path === "/v1/views/view-1" && request.method === "PATCH");
    const hidden = patch.body.configuration.properties.filter(item => !item.visible).map(item => item.property_id);
    assert.deepEqual(hidden.sort(), [...internalIds].sort());
    assert.equal(patch.body.configuration.properties.length, Object.keys(properties).length);
    assert.equal((await chrome.storage.local.get("savourConfig")).savourConfig.internalColumnsHiddenFor, DATA_SOURCE_ID);

    requests.length = 0;
    await background.ensureArchiveSchema(DATA_SOURCE_ID, "token", { force: true });
    assert.equal(requests.some(request => request.path.startsWith("/v1/views")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
