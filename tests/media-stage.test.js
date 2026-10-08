"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMediaStage, isStageKey } = require("../storage/media-stage.js");

test("暫存的圖片以鑰匙取回，刪除後就找不到", async () => {
  const stage = createMediaStage({ indexedDB: null });
  const key = await stage.put(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  assert.equal(isStageKey(key), true);
  const blob = await stage.get(key);
  assert.equal(blob.size, 3);
  assert.equal(blob.type, "image/png");
  await stage.remove(key);
  assert.equal(await stage.get(key), null);
});

test("不合格式的鑰匙一律當作找不到，也不會被刪除操作影響", async () => {
  const stage = createMediaStage({ indexedDB: null });
  assert.equal(await stage.get("../escape"), null);
  assert.equal(await stage.get(""), null);
  await stage.remove("../escape");
  assert.equal(isStageKey("abc"), false);
});

test("清理只刪掉沒人引用而且超過期限的圖片", async () => {
  let clock = 1000;
  const stage = createMediaStage({ indexedDB: null, now: () => clock });
  const oldUnused = await stage.put(new Blob(["a"]));
  const oldUsed = await stage.put(new Blob(["b"]));
  clock += 25 * 60 * 60 * 1000;
  const fresh = await stage.put(new Blob(["c"]));
  assert.equal(await stage.prune(new Set([oldUsed])), 1);
  assert.equal(await stage.get(oldUnused), null);
  assert.ok(await stage.get(oldUsed));
  assert.ok(await stage.get(fresh));
});
