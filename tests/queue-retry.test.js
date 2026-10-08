"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const shared = require("../lib/shared.js");
const {
  LARGE_CREATE_CONFIRMATION_CODE,
  LARGE_CREATE_LIMIT,
  PROCESS_ALARM,
  createQueueRetry
} = require("../queue/retry.js");

function capture(id, overrides = {}) {
  return {
    id,
    dedupeKey: `post:${id}`,
    captureType: "post",
    sourceUrl: `https://www.threads.com/@sample/post/${id}`,
    author: "sample",
    text: `正文 ${id}`,
    publishedAt: "2026-09-01T01:02:03Z",
    topicTag: "測試",
    continuations: [],
    authorReplies: [],
    longTextAttachments: [],
    reviewFlags: [],
    ...overrides
  };
}

function createHarness(overrides = {}) {
  let state = {
    queue: [],
    saved: {},
    recent: [],
    lastSyncedAt: ""
  };
  let mutex = Promise.resolve();
  const alarms = [];
  const calls = { ensure: 0, save: 0 };
  const chromeApi = {
    alarms: {
      create(name, details) {
        alarms.push({ name, details });
      }
    }
  };
  const readState = async () => structuredClone(state);
  const writeState = async next => {
    state = structuredClone(next);
  };
  const withStateLock = task => {
    const result = mutex.then(task, task);
    mutex = result.catch(() => {});
    return result;
  };
  const getStatus = async () => ({
    pending: state.queue.filter(item => item.status === "pending" || item.status === "processing").length
  });
  const queue = createQueueRetry({
    chromeApi,
    shared: { ...shared, sleep: async () => undefined },
    notion: {
      captureTitleText: item => item.text,
      savedRecordFromPage: page => ({
        key: page.dedupeKey,
        value: page.record ?? {}
      })
    },
    readState,
    writeState,
    withStateLock,
    readConfig: async () => ({ dataSourceId: "source" }),
    readToken: async () => "token",
    ensureArchiveSchema: async () => {
      calls.ensure += 1;
    },
    saveCaptureToNotion: async item => {
      calls.save += 1;
      return {
        id: `page-${item.id}`,
        url: `https://notion.test/${item.id}`,
        dedupeKey: item.dedupeKey,
        record: {}
      };
    },
    sanitizeCapture: item => structuredClone(item),
    assertCaptureIntegrity: item => {
      if (item.valid === false) throw new Error("invalid capture");
      return true;
    },
    hasValidCaptureIntegrity: item => item?.valid !== false,
    getStatus,
    cloneQueueItem: item => structuredClone(item),
    ...overrides
  });
  return {
    alarms,
    calls,
    queue,
    getState: () => structuredClone(state),
    setState: next => {
      state = structuredClone(next);
    }
  };
}

test("入列會去重並排入佇列尾端", async () => {
  const harness = createHarness({ readToken: async () => "" });
  const first = capture("first");
  const root = capture("root");
  await harness.queue.enqueueCaptures([first]);
  const result = await harness.queue.enqueueCaptures([root]);
  assert.equal(result.added, 1);
  assert.deepEqual(harness.getState().queue.map(item => item.capture.id), ["first", "root"]);
  const again = await harness.queue.enqueueCaptures([capture("root")]);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(harness.alarms.some(alarm => alarm.name === PROCESS_ALARM), true);
});

test("已保存文章即使傳入 replaceExisting 也只會略過，不會建立覆寫項目", async () => {
  const harness = createHarness({ readToken: async () => "" });
  const item = capture("one", { dedupeKey: "tsc:one" });
  const oldKey = "post:https://www.threads.com/@sample/post/one";
  harness.setState({
    queue: [],
    saved: {
      [oldKey]: {
        sourceUrl: item.sourceUrl,
        authorReplyPostIds: ["reply"]
      }
    },
    recent: [],
    lastSyncedAt: ""
  });

  const result = await harness.queue.enqueueCaptures([item], { replaceExisting: true });
  assert.equal(result.added, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(harness.getState().queue.length, 0);
});

test("本機已保存但要求 Notion 核對時，入列項目不帶任何覆寫旗標", async () => {
  const options = [];
  const item = capture("one", { dedupeKey: "tsc:one" });
  const harness = createHarness({
    saveCaptureToNotion: async (saved, dataSourceId, token, saveOptions) => {
      options.push(saveOptions);
      return { id: "page-one", url: "https://notion.test/one", dedupeKey: saved.dedupeKey, duplicateFoundInNotion: true, record: {} };
    }
  });
  harness.setState({
    queue: [],
    saved: { "tsc:one": { sourceUrl: item.sourceUrl } },
    recent: [],
    lastSyncedAt: ""
  });

  await harness.queue.enqueueCaptures([item], { replaceExisting: true, verifyExisting: true });
  const queued = harness.getState().queue[0];
  assert.equal("replaceExisting" in queued, false);
  assert.equal("repairPartialPage" in queued, false);
  while (harness.queue.isProcessing()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(options.length, 1);
  assert.equal(options[0].repairPartialPage, false);
  assert.equal("replaceExisting" in options[0], false);
});

test("舊版佇列殘留的 replaceExisting 項目不會觸發覆寫", async () => {
  const options = [];
  const harness = createHarness({
    saveCaptureToNotion: async (saved, dataSourceId, token, saveOptions) => {
      options.push(saveOptions);
      return { id: "page-one", url: "https://notion.test/one", dedupeKey: saved.dedupeKey, record: {} };
    }
  });
  harness.setState({
    queue: [{
      id: "one",
      capture: capture("one"),
      replaceExisting: true,
      status: "pending",
      attempts: 0,
      createdAt: "2026-09-01T00:00:00Z",
      lastError: ""
    }],
    saved: {},
    recent: [],
    lastSyncedAt: ""
  });

  await harness.queue.processQueue(1);
  assert.equal(options[0].repairPartialPage, false);
});

test("selection 的本機索引比對不會誤用同網址貼文紀錄", async () => {
  const harness = createHarness({ readToken: async () => "" });
  const selection = capture("selection", {
    captureType: "selection",
    sourceUrl: "https://www.threads.com/@sample/post/one",
    dedupeKey: "selection:https://www.threads.com/@sample/post/one:12345678"
  });
  harness.setState({
    queue: [],
    saved: {
      "post:https://www.threads.com/@sample/post/one": {
        sourceUrl: selection.sourceUrl,
        authorReplyPostIds: ["reply"]
      }
    },
    recent: [],
    lastSyncedAt: ""
  });

  const result = await harness.queue.enqueueCaptures([selection]);
  assert.equal(result.added, 1);
  assert.equal(harness.getState().queue[0].capture.dedupeKey, selection.dedupeKey);
});

test("已有 saved 時單次預計新增超過二十頁會先要求確認且不部分入列", async () => {
  const harness = createHarness({ readToken: async () => "" });
  harness.setState({
    queue: [],
    saved: { existing: { title: "既有頁面" } },
    recent: [],
    lastSyncedAt: ""
  });
  const captures = Array.from({ length: LARGE_CREATE_LIMIT + 1 }, (_, index) => capture(`bulk-${index}`));

  await assert.rejects(
    harness.queue.enqueueCaptures(captures),
    error => {
      assert.equal(error.code, LARGE_CREATE_CONFIRMATION_CODE);
      assert.equal(error.createCount, LARGE_CREATE_LIMIT + 1);
      assert.equal(error.limit, LARGE_CREATE_LIMIT);
      return true;
    }
  );
  assert.equal(harness.getState().queue.length, 0);

  const result = await harness.queue.enqueueCaptures(captures, { confirmedLargeCreate: true });
  assert.equal(result.added, LARGE_CREATE_LIMIT + 1);
  assert.equal(harness.getState().queue.length, LARGE_CREATE_LIMIT + 1);
});

test("大量建立門檻會計入同次收集已新增數，空白 saved 則不阻擋首次匯入", async () => {
  const offsetHarness = createHarness({ readToken: async () => "" });
  offsetHarness.setState({
    queue: [],
    saved: { existing: { title: "既有頁面" } },
    recent: [],
    lastSyncedAt: ""
  });
  await assert.rejects(
    offsetHarness.queue.enqueueCaptures(
      Array.from({ length: 11 }, (_, index) => capture(`offset-${index}`)),
      { createCountOffset: 10 }
    ),
    error => error.code === LARGE_CREATE_CONFIRMATION_CODE && error.createCount === 21
  );

  const emptyHarness = createHarness({ readToken: async () => "" });
  const firstImport = Array.from({ length: LARGE_CREATE_LIMIT + 1 }, (_, index) => capture(`first-${index}`));
  const result = await emptyHarness.queue.enqueueCaptures(firstImport);
  assert.equal(result.added, LARGE_CREATE_LIMIT + 1);
});

test("processQueue 成功時只驗證一次 schema 並建立 saved 與 recent", async () => {
  const harness = createHarness();
  const reply = capture("reply", {
    sourceUrl: "https://www.threads.com/@sample/post/reply",
    longTextAttachments: [{ plaintext: "長文" }],
    reviewFlags: ["串文未完整"]
  });
  harness.setState({
    queue: ["one", "two"].map(id => ({
      id,
      capture: capture(id, { authorReplies: id === "one" ? [reply] : [] }),
      status: "pending",
      attempts: 0,
      createdAt: "2026-09-01T00:00:00Z",
      lastError: ""
    })),
    saved: {},
    recent: [],
    lastSyncedAt: ""
  });
  await harness.queue.processQueue();
  const state = harness.getState();
  assert.equal(harness.calls.ensure, 1);
  assert.equal(harness.calls.save, 2);
  assert.equal(state.queue.length, 0);
  assert.equal(Object.keys(state.saved).length, 2);
  assert.deepEqual(state.saved["post:one"].authorReplyPostIds, ["reply"]);
  assert.equal(state.saved["post:one"].longTextAttachmentCount, 1);
  assert.deepEqual(state.saved["post:one"].reviewItems, ["串文未完整"]);
  assert.equal(state.recent.length, 2);
  // Notion has no column for it, so the popup's recent list is where the user sees it.
  assert.deepEqual(state.recent.find(item => item.key === "post:one").reviewItems, ["串文未完整"]);
});

test("換成遠端 canonical key 時會合併作者回覆並移除所有同貼文舊鍵", async () => {
  const item = capture("one", { dedupeKey: "tsc:one" });
  const oldKey = "post:https://www.threads.com/@sample/post/one";
  const harness = createHarness({
    saveCaptureToNotion: async () => ({
      id: "page-one",
      url: "https://notion.test/one",
      dedupeKey: "tmid:179123",
      duplicateFoundInNotion: true,
      record: { sourceUrl: item.sourceUrl }
    })
  });
  harness.setState({
    queue: [{
      id: item.id,
      capture: item,
      status: "pending",
      attempts: 0,
      createdAt: "2026-09-01T00:00:00Z",
      lastError: ""
    }],
    saved: {
      [oldKey]: { sourceUrl: item.sourceUrl, authorReplyPostIds: ["old-reply"] },
      "tsc:one": { sourceUrl: item.sourceUrl, authorReplyPostIds: ["new-reply"] }
    },
    recent: [],
    lastSyncedAt: ""
  });

  await harness.queue.processQueue(1);
  const state = harness.getState();
  assert.equal(state.saved[oldKey], undefined);
  assert.equal(state.saved["tsc:one"], undefined);
  assert.deepEqual(
    state.saved["tmid:179123"].authorReplyPostIds.sort(),
    ["new-reply", "old-reply"]
  );
});

test("處理失敗會累計次數，只有 partial page 會標記為修補自建頁面", async () => {
  const error = new Error("Notion write failed");
  error.partialPageCreated = true;
  const harness = createHarness({
    saveCaptureToNotion: async () => {
      throw error;
    }
  });
  harness.setState({
    queue: [{
      id: "one",
      capture: capture("one"),
      status: "pending",
      attempts: 2,
      createdAt: "2026-09-01T00:00:00Z",
      lastError: ""
    }],
    saved: {},
    recent: [],
    lastSyncedAt: ""
  });
  await harness.queue.processQueue(1);
  const item = harness.getState().queue[0];
  assert.equal(item.status, "failed");
  assert.equal(item.attempts, 3);
  assert.equal(item.lastError, "Notion write failed");
  assert.equal(item.repairPartialPage, true);
  assert.equal(harness.queue.isProcessing(), false);
});

test("同一個 queue instance 不會並行處理兩次", async () => {
  let releaseSave;
  let markStarted;
  let saveCalls = 0;
  const saveGate = new Promise(resolve => {
    releaseSave = resolve;
  });
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  const harness = createHarness({
    saveCaptureToNotion: async item => {
      saveCalls += 1;
      markStarted();
      await saveGate;
      return { id: `page-${item.id}`, url: "", dedupeKey: item.dedupeKey, record: {} };
    }
  });
  harness.setState({
    queue: [{
      id: "one",
      capture: capture("one"),
      status: "pending",
      attempts: 0,
      createdAt: "2026-09-01T00:00:00Z",
      lastError: ""
    }],
    saved: {},
    recent: [],
    lastSyncedAt: ""
  });
  const firstRun = harness.queue.processQueue(1);
  await started;
  assert.equal(harness.queue.isProcessing(), true);
  await harness.queue.processQueue(1);
  assert.equal(saveCalls, 1);
  releaseSave();
  await firstRun;
  assert.equal(harness.queue.isProcessing(), false);
  assert.equal(harness.getState().queue.length, 0);
});

test("重試只恢復有效資料，啟動復原會處理 processing 與無法驗證的項目", async () => {
  const harness = createHarness({ readToken: async () => "" });
  harness.setState({
    queue: [
      { id: "processing", capture: capture("processing"), status: "processing", attempts: 0, lastError: "" },
      { id: "valid", capture: capture("valid"), status: "failed", attempts: 3, lastError: "x" },
      { id: "invalid", capture: capture("invalid", { valid: false }), status: "processing", attempts: 0, lastError: "" }
    ],
    saved: {},
    recent: [],
    lastSyncedAt: ""
  });
  await harness.queue.recoverInterruptedItems();
  let state = harness.getState();
  assert.equal(state.queue[0].status, "pending");
  assert.equal(state.queue[2].status, "failed");
  assert.equal(state.queue[2].attempts, 3);
  assert.match(state.queue[2].lastError, /擷取資料無法驗證/);
  const result = await harness.queue.retryFailedItems();
  state = harness.getState();
  assert.equal(result.retried, 1);
  assert.equal(state.queue[1].status, "pending");
  assert.equal(state.queue[2].status, "failed");
});

test("瀏覽器模式會暴露 queue retry factory 與 alarm 名稱", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "queue", "retry.js"), "utf8");
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  assert.equal(context.globalThis.SavourQueueRetry.PROCESS_ALARM, PROCESS_ALARM);
  assert.equal(context.globalThis.SavourQueueRetry.LARGE_CREATE_LIMIT, LARGE_CREATE_LIMIT);
  assert.equal(
    context.globalThis.SavourQueueRetry.LARGE_CREATE_CONFIRMATION_CODE,
    LARGE_CREATE_CONFIRMATION_CODE
  );
  assert.equal(typeof context.globalThis.SavourQueueRetry.createQueueRetry, "function");
});
