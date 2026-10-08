"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeMock } = require("./helpers/chrome-mock");
const {
  STATE_KEY,
  DEFAULT_STATE,
  createStateStorage
} = require("../storage/state.js");

function createFixture(initial = {}) {
  const chromeApi = createChromeMock(initial);
  const storage = createStateStorage({
    chromeApi,
    cloneState: value => structuredClone(value)
  });
  return { chromeApi, storage };
}

test("讀取狀態會補上獨立的預設容器且不寫回", async () => {
  const fixture = createFixture({ local: { [STATE_KEY]: { lastSyncedAt: "2026-09-21T00:00:00Z" } } });
  const state = await fixture.storage.readState();
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.saved, {});
  assert.deepEqual(state.recent, []);
  assert.equal(state.lastSyncedAt, "2026-09-21T00:00:00Z");
  assert.deepEqual(
    fixture.chromeApi.storage.local.snapshot()[STATE_KEY],
    { lastSyncedAt: "2026-09-21T00:00:00Z" }
  );
  state.queue.push({ id: "local-only" });
  assert.deepEqual(DEFAULT_STATE.queue, []);
});

test("寫入狀態會原樣更新指定的 local storage key", async () => {
  const fixture = createFixture();
  const state = { ...structuredClone(DEFAULT_STATE), saved: { one: { title: "已保存" } } };
  await fixture.storage.writeState(state);
  assert.deepEqual(fixture.chromeApi.storage.local.snapshot()[STATE_KEY], state);
});

test("狀態鎖會依序執行同時任務", async () => {
  const fixture = createFixture();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const first = fixture.storage.withStateLock(async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = fixture.storage.withStateLock(async () => {
    order.push("second");
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("狀態鎖在前一個任務失敗後仍會執行後續任務", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.storage.withStateLock(async () => {
      throw new Error("expected failure");
    }),
    /expected failure/
  );
  let completed = false;
  await fixture.storage.withStateLock(async () => {
    completed = true;
  });
  assert.equal(completed, true);
});

test("清除最近紀錄會保留佇列、已保存索引與同步時間", async () => {
  const initialState = {
    queue: [{ id: "pending" }],
    saved: { keep: { title: "保留" } },
    recent: [{ key: "one" }, { key: "two" }],
    lastSyncedAt: "2026-09-21T01:00:00Z"
  };
  const fixture = createFixture({ local: { [STATE_KEY]: initialState } });
  assert.deepEqual(await fixture.storage.clearRecentItems(), { cleared: 2 });
  assert.deepEqual(fixture.chromeApi.storage.local.snapshot()[STATE_KEY], {
    ...initialState,
    selectionAppends: {},
    appendTargets: [],
    recent: []
  });
});

test("瀏覽器模式會暴露全域 storage state API", () => {
  const source = require("node:fs").readFileSync(require.resolve("../storage/state.js"), "utf8");
  assert.match(source, /root\.SavourStorageState = api/);
});
