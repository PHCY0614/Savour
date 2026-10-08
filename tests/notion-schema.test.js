"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../notion/schema.js");
const notion = require("../notion/index.js");

test("Notion schema 模組保留 facade 的資料庫契約", () => {
  assert.deepEqual(Object.keys(schema).sort(), [
    "COLUMNS",
    "INTERNAL_COLUMNS",
    "PLATFORM_OPTIONS",
    "PROPERTY_NAMES",
    "archivePropertySchema",
    "createArchivePayload",
    "defaultColumnMap",
    "hiddenColumnsViewUpdate",
    "pageProperty",
    "resolveColumnMap"
  ]);
  assert.strictEqual(notion.PROPERTY_NAMES, schema.PROPERTY_NAMES);
  assert.strictEqual(notion.archivePropertySchema, schema.archivePropertySchema);
  assert.strictEqual(notion.createArchivePayload, schema.createArchivePayload);
  assert.strictEqual(notion.resolveColumnMap, schema.resolveColumnMap);
  // The facade's version hides the internal columns of the archive in use.
  assert.equal(typeof notion.hiddenColumnsViewUpdate, "function");
});

const DATA_SOURCE_ID = "11111111-1111-1111-1111-111111111111";
const dataSourceProperties = {
  名稱: { id: "title" },
  來源網址: { id: "url1" },
  擷取鍵: { id: "key1" },
  貼文編號: { id: "pid1" },
  原文範圍: { id: "rng1" },
  我的備註: { id: "mine" }
};

test("內部欄位（擷取鍵、貼文編號、原文範圍）在表格檢視中隱藏，其他欄位的順序與顯示不變", () => {
  assert.deepEqual(schema.INTERNAL_COLUMNS, ["captureKey", "postId", "contentRange"]);
  const view = {
    id: "view-1",
    type: "table",
    data_source_id: DATA_SOURCE_ID,
    configuration: {
      type: "table",
      properties: [
        { property_id: "title", visible: true, width: 300 },
        { property_id: "key1", visible: true },
        { property_id: "mine", visible: false },
        { property_id: "url1", visible: true }
      ]
    }
  };
  assert.deepEqual(schema.hiddenColumnsViewUpdate(view, dataSourceProperties, DATA_SOURCE_ID), {
    configuration: {
      type: "table",
      properties: [
        { property_id: "title", visible: true, width: 300 },
        { property_id: "key1", visible: false },
        { property_id: "mine", visible: false },
        { property_id: "url1", visible: true },
        { property_id: "pid1", visible: false },
        { property_id: "rng1", visible: false }
      ]
    }
  });
});

test("已經隱藏、其他資料來源或需要額外設定的檢視不會被修改", () => {
  const hidden = {
    type: "table",
    data_source_id: DATA_SOURCE_ID,
    configuration: {
      type: "table",
      properties: ["title", "key1", "pid1", "rng1"].map(id => ({ property_id: id, visible: id === "title" }))
    }
  };
  assert.equal(schema.hiddenColumnsViewUpdate(hidden, dataSourceProperties, DATA_SOURCE_ID), null);
  assert.equal(schema.hiddenColumnsViewUpdate({ ...hidden, data_source_id: "22222222-2222-2222-2222-222222222222" }, dataSourceProperties, DATA_SOURCE_ID), null);
  assert.equal(schema.hiddenColumnsViewUpdate({ type: "board", data_source_id: DATA_SOURCE_ID, configuration: { type: "board" } }, dataSourceProperties, DATA_SOURCE_ID), null);
  // A view that has never listed its columns gets the full list, with only the internal ones hidden.
  const fresh = schema.hiddenColumnsViewUpdate({ type: "gallery", data_source_id: DATA_SOURCE_ID, configuration: null }, dataSourceProperties, DATA_SOURCE_ID);
  assert.deepEqual(fresh.configuration.properties.filter(item => !item.visible).map(item => item.property_id), ["key1", "pid1", "rng1"]);
  assert.equal(fresh.configuration.properties.length, 6);
});
