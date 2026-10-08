"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../lib/shared.js");
const notion = require("../notion/index.js");
const { createNotionRepository } = require("../notion/repository.js");
const { createQueueRetry, PROCESS_ALARM } = require("../queue/retry.js");
const { installDom } = require("./helpers/dom-env");
const { createPicker } = require("../pages/picker/picker.js");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAGE = "11111111-1111-4111-8111-111111111111";
const SELECTED = "讀者一號\n請問第二段的資料來源是哪裡？\n測試噗主\n謝謝提問，來源是 XX 報告第 3 章。";

function selection(overrides = {}) {
  return {
    id: "selection-1",
    captureType: "selection",
    text: SELECTED,
    links: [],
    sourceUrl: "https://www.plurk.com/p/3abc0test1",
    dedupeKey: "selection:https://www.plurk.com/p/3abc0test1:abcd1234",
    continuations: [],
    authorReplies: [],
    ...overrides
  };
}

function paragraphBlock(text) {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

test("加到既有頁面的選取文字只有分隔線與文字", () => {
  const blocks = notion.buildSelectionAppendBlocks({ text: "第一段\n第二行\n\n第三段", links: [] });
  assert.deepEqual(blocks.map(block => block.type), ["paragraph", "divider", "paragraph", "paragraph", "paragraph"]);
  assert.deepEqual(blocks[0].paragraph.rich_text, []);
  assert.equal(blocks[3].paragraph.rich_text.map(item => item.text.content).join(""), "第一段\n第二行");
  assert.equal(blocks[4].paragraph.rich_text.map(item => item.text.content).join(""), "第三段");
  assert.deepEqual(notion.buildSelectionAppendBlocks({ text: "  " }), []);
});

test("整理庫頁面搜尋以標題比對並依保存時間排序", () => {
  assert.deepEqual(notion.archivePageSearchPayload("  噗文 "), {
    page_size: 10,
    filter: { property: "名稱", title: { contains: "噗文" } },
    sorts: [{ property: "保存時間", direction: "descending" }]
  });
  assert.equal(notion.archivePageSearchPayload("").filter, undefined);
  assert.deepEqual(notion.archivePageSummary({
    id: PAGE,
    properties: { 名稱: { title: [{ plain_text: "噗文標題" }] } }
  }), { pageId: PAGE, title: "噗文標題" });
  assert.equal(notion.archivePageSummary({ id: PAGE, in_trash: true }), null);
});

function repositoryHarness({ page = {}, blocks = [] } = {}) {
  const requests = [];
  const repository = createNotionRepository({
    shared: { ...shared, sleep: async () => undefined },
    notion,
    notionRequest: async (requestPath, options) => {
      requests.push({ path: requestPath, options });
      if (requestPath === `/v1/pages/${PAGE}`) {
        return { id: PAGE, url: "https://notion.test/page", parent: { type: "data_source_id", data_source_id: SOURCE.replace(/-/g, "") }, ...page };
      }
      if (requestPath.startsWith(`/v1/blocks/${PAGE}/children?`)) return { results: blocks, has_more: false };
      return {};
    },
    captureEntries: value => [value],
    fetchImpl: async () => { throw new Error("不應下載圖片"); },
    cloneCapture: value => structuredClone(value),
    createFormData: () => ({ append() {} })
  });
  return { repository, requests };
}

test("選取文字接在整理庫頁面的最後，不改動原本的區塊", async () => {
  const { repository, requests } = repositoryHarness({ blocks: [paragraphBlock("噗文正文")] });
  const result = await repository.appendSelectionToPage(selection(), PAGE, SOURCE, "token");
  const appends = requests.filter(item => item.path === `/v1/blocks/${PAGE}/children`);
  assert.equal(appends.length, 1);
  assert.equal(appends[0].options.method, "PATCH");
  assert.equal(appends[0].options.body.children[1].type, "divider");
  assert.equal(requests.some(item => item.options.method === "DELETE" || item.path === "/v1/pages"), false);
  assert.equal(result.appendedSelection, true);
});

test("頁面上已經有同一段選取文字時不會再加一次", async () => {
  const { repository, requests } = repositoryHarness({
    blocks: [paragraphBlock("噗文正文"), { type: "divider", divider: {} }, paragraphBlock(SELECTED)]
  });
  const result = await repository.appendSelectionToPage(selection(), PAGE, SOURCE, "token");
  assert.equal(result.selectionAlreadyOnPage, true);
  assert.equal(requests.some(item => item.options.method === "PATCH"), false);
});

test("很短的選取文字即使頁面上有相同字也會加入", async () => {
  const { repository, requests } = repositoryHarness({ blocks: [paragraphBlock("謝謝大家")] });
  await repository.appendSelectionToPage(selection({ text: "謝謝" }), PAGE, SOURCE, "token");
  assert.equal(requests.some(item => item.options.method === "PATCH"), true);
});

test("不屬於目前整理庫或已刪除的頁面會被拒絕且不再重試", async () => {
  const other = repositoryHarness({ page: { parent: { type: "data_source_id", data_source_id: OTHER_SOURCE } } });
  await assert.rejects(
    other.repository.appendSelectionToPage(selection(), PAGE, SOURCE, "token"),
    error => error.permanent === true && /只能加到目前整理庫/.test(error.message)
  );
  assert.equal(other.requests.some(item => item.options.method === "PATCH"), false);

  const trashed = repositoryHarness({ page: { in_trash: true } });
  await assert.rejects(
    trashed.repository.appendSelectionToPage(selection(), PAGE, SOURCE, "token"),
    error => error.permanent === true && /被刪除/.test(error.message)
  );
});

function queueHarness(appendSelectionToPage) {
  let state = { queue: [], saved: {}, recent: [], lastSyncedAt: "", selectionAppends: {}, appendTargets: [] };
  let mutex = Promise.resolve();
  let token = "";
  const alarms = [];
  const queue = createQueueRetry({
    chromeApi: { alarms: { create: (name, details) => alarms.push({ name, details }) } },
    shared: { ...shared, sleep: async () => undefined },
    notion: { captureTitleText: item => item.text, savedRecordFromPage: () => null },
    readState: async () => structuredClone(state),
    writeState: async next => { state = structuredClone(next); },
    withStateLock: task => {
      const result = mutex.then(task, task);
      mutex = result.catch(() => {});
      return result;
    },
    readConfig: async () => ({ dataSourceId: SOURCE }),
    // No token until the test runs the queue itself, so enqueueing does not start processing.
    readToken: async () => token,
    ensureArchiveSchema: async () => undefined,
    saveCaptureToNotion: async () => { throw new Error("不應建立新頁面"); },
    appendSelectionToPage,
    sanitizeCapture: item => structuredClone(item),
    assertCaptureIntegrity: () => true,
    hasValidCaptureIntegrity: () => true,
    getStatus: async () => ({ pending: state.queue.filter(item => item.status === "pending").length }),
    cloneQueueItem: item => structuredClone(item)
  });
  return {
    queue,
    alarms,
    process: async () => {
      token = "token";
      await queue.processQueue();
    },
    getState: () => structuredClone(state),
    setState: next => { state = { ...state, ...structuredClone(next) }; }
  };
}

test("選取文字加到既有頁面會排入佇列、記住目標，完成後不再重複加入", async () => {
  const calls = [];
  const harness = queueHarness(async (capture, pageId, dataSourceId) => {
    calls.push({ text: capture.text, pageId, dataSourceId });
    return { id: pageId, url: "https://notion.test/page", appendedSelection: true };
  });
  harness.setState({ saved: { "plurk:3abc0test1": { notionPageId: PAGE, title: "噗文標題", notionUrl: "https://notion.test/page" } } });

  const queued = await harness.queue.enqueueSelectionAppend(selection(), { pageId: PAGE.replace(/-/g, ""), title: "噗文標題" });
  assert.equal(queued.added, 1);
  assert.equal(queued.target.pageId, PAGE);
  assert.equal(harness.getState().queue[0].appendTo.pageId, PAGE);
  assert.deepEqual(harness.getState().appendTargets, [{ pageId: PAGE, title: "噗文標題" }]);
  assert.equal(harness.alarms.some(alarm => alarm.name === PROCESS_ALARM), true);

  const pending = await harness.queue.enqueueSelectionAppend(selection({ id: "selection-2" }), { pageId: PAGE, title: "噗文標題" });
  assert.equal(pending.added, 0);

  await harness.process();
  assert.deepEqual(calls, [{ text: SELECTED, pageId: PAGE, dataSourceId: SOURCE }]);
  const state = harness.getState();
  assert.equal(state.queue.length, 0);
  assert.equal(Object.keys(state.saved).length, 1, "不會替選取文字建立新的保存紀錄");
  assert.equal(state.recent[0].result, "selection_appended");
  assert.equal(state.recent[0].title, "噗文標題");

  const again = await harness.queue.enqueueSelectionAppend(selection({ id: "selection-3" }), { pageId: PAGE, title: "噗文標題" });
  assert.equal(again.added, 0);
  assert.equal(again.alreadyOnPage, true);
});

test("同一段選取文字仍可另存成新頁面，兩種工作不互相擋住", async () => {
  const harness = queueHarness(async () => ({}));
  await harness.queue.enqueueSelectionAppend(selection(), { pageId: PAGE, title: "噗文標題" });
  const asNewPage = await harness.queue.enqueueCaptures([selection({ id: "selection-new" })]);
  assert.equal(asNewPage.added, 1);
  assert.equal(harness.getState().queue.length, 2);
});

test("目標頁面無法使用時立刻標為失敗，不重試三次", async () => {
  let attempts = 0;
  const harness = queueHarness(async () => {
    attempts += 1;
    const error = new Error("只能加到目前整理庫裡的頁面");
    error.permanent = true;
    throw error;
  });
  await harness.queue.enqueueSelectionAppend(selection(), { pageId: PAGE, title: "噗文標題" });
  await harness.process();
  assert.equal(attempts, 1);
  assert.equal(harness.getState().queue[0].status, "failed");
  assert.match(harness.getState().queue[0].lastError, /只能加到目前整理庫/);
});

const PICKER_HTML = fs.readFileSync(path.join(__dirname, "..", "pages/picker/picker.html"), "utf8");

// The picker window, with events counted as real input unless a test says otherwise.
async function pickerHarness(responses = {}, { trusted = true } = {}) {
  const env = installDom(PICKER_HTML, { url: "chrome-extension://extension-id/picker.html#token-1" });
  const sent = [];
  let closed = 0;
  const picker = createPicker({
    doc: document,
    token: "token-1",
    debounceMs: 0,
    isTrusted: () => trusted,
    sendMessage: async message => {
      sent.push(message);
      return responses[message.type] ?? {
        ok: true,
        result: message.type === "PICKER_SESSION"
          ? {
            previewText: "讀者一號 請問第二段的資料來源是哪裡？",
            choices: {
              current: { pageId: PAGE, title: "噗文標題" },
              recent: [{ pageId: OTHER_SOURCE, title: "另一篇" }],
              preselect: PAGE
            }
          }
          : { message: "已加入佇列，會接在「噗文標題」最後面" }
      };
    },
    closeWindow: () => {
      closed += 1;
    }
  });
  await picker.load();
  const options = () => [...document.querySelectorAll(".option")].map(button => button.textContent);
  const active = () => document.querySelector(".option.is-active")?.textContent;
  const key = keyName => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: keyName, bubbles: true }));
  return { env, sent, options, active, key, closedCount: () => closed };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("選單預先選好這篇的頁面，按 Enter 就加到該頁；選單只送出頁面編號，選取文字留在背景", async () => {
  const harness = await pickerHarness();
  try {
    assert.deepEqual(harness.sent[0], { type: "PICKER_SESSION", token: "token-1" });
    assert.equal(document.getElementById("picker-preview").textContent, "讀者一號 請問第二段的資料來源是哪裡？");
    assert.deepEqual(harness.options(), ["噗文標題", "另一篇", "存成新頁面"]);
    assert.equal(harness.active(), "噗文標題");
    harness.key("Enter");
    await tick();
    assert.deepEqual(harness.sent[1], { type: "PICKER_CHOOSE", token: "token-1", target: { kind: "page", pageId: PAGE } });
    assert.equal(document.getElementById("picker-status").textContent, "已加入佇列，會接在「噗文標題」最後面");
  } finally {
    harness.env.restore();
  }
});

test("方向鍵可以改選存成新頁面，Esc 關閉視窗且不送出", async () => {
  const harness = await pickerHarness();
  try {
    harness.key("ArrowDown");
    harness.key("ArrowDown");
    assert.equal(harness.active(), "存成新頁面");
    harness.key("Escape");
    assert.equal(harness.closedCount(), 1);
    assert.equal(harness.sent.length, 1);
    harness.key("Enter");
    await tick();
    assert.deepEqual(harness.sent[1].target, { kind: "new" });
  } finally {
    harness.env.restore();
  }
});

test("網頁或程式產生的假事件不會選擇頁面", async () => {
  const harness = await pickerHarness({}, { trusted: false });
  try {
    harness.key("Enter");
    document.querySelector(".option").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.closedCount(), 0);
  } finally {
    harness.env.restore();
  }
});

test("輸入文字會搜尋整理庫並列出結果", async () => {
  const harness = await pickerHarness({
    PICKER_SEARCH: { ok: true, result: { results: [{ pageId: PAGE, title: "搜到的頁面" }] } }
  });
  try {
    const search = document.getElementById("picker-search");
    search.value = "搜到";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
    await tick();
    assert.deepEqual(harness.sent[1], { type: "PICKER_SEARCH", token: "token-1", query: "搜到" });
    assert.deepEqual(harness.options(), ["搜到的頁面", "存成新頁面"]);
  } finally {
    harness.env.restore();
  }
});

test("保存失敗時在視窗內顯示錯誤，可以改選其他頁面", async () => {
  const harness = await pickerHarness({ PICKER_CHOOSE: { ok: false, error: "只能加到目前整理庫裡的頁面" } });
  try {
    harness.key("Enter");
    await tick();
    assert.equal(document.getElementById("picker-status").textContent, "只能加到目前整理庫裡的頁面");
    assert.equal(document.querySelector(".option").disabled, false);
    assert.equal(harness.closedCount(), 0);
  } finally {
    harness.env.restore();
  }
});

test("過期的選單只顯示失效說明", async () => {
  const harness = await pickerHarness({ PICKER_SESSION: { ok: false, error: "這個選單已經失效，請重新選取文字" } });
  try {
    assert.deepEqual(harness.options(), []);
    assert.equal(document.getElementById("picker-search").disabled, true);
    assert.equal(document.getElementById("picker-status").textContent, "這個選單已經失效，請重新選取文字");
  } finally {
    harness.env.restore();
  }
});
