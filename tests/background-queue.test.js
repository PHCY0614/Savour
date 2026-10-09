"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createChromeMock } = require("./helpers/chrome-mock");

globalThis.SavourShared = require("../lib/shared.js");
globalThis.SavourNotion = require("../notion/index.js");
globalThis.importScripts = () => undefined;
const chromeMock = createChromeMock();
globalThis.chrome = chromeMock;
// Savour's own pages send from chrome-extension://extension-id/; content scripts do not.
chromeMock.runtime.id = "extension-id";
chromeMock.runtime.getURL = file => `chrome-extension://extension-id/${file}`;
const PAGE_SENDER = { id: "extension-id", url: "chrome-extension://extension-id/pages/popup/popup.html" };
const background = require("../background.js");
// The tests below put items on the queue without setting Notion up; the setup check has its own tests.
background.setSetupCheckForTests(async () => {});

const STATE_KEY = "savourState";
const CONFIG_KEY = "savourConfig";
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "notion", `${name}.json`), "utf8"));

test.after(() => {
  delete globalThis.chrome;
  delete globalThis.importScripts;
  delete globalThis.SavourShared;
  delete globalThis.SavourNotion;
});

function rawPost(overrides = {}) {
  return {
    captureType: "post",
    text: "  測試正文  ",
    sourceUrl: "https://threads.net/@Sample/post/root001?xmt=tracking",
    author: "@Sample",
    publishedAt: "2026-09-01T01:02:03Z",
    media: [],
    quotedPosts: [],
    continuations: [],
    authorReplies: [],
    longTextAttachments: [],
    captureValidation: {
      version: 2,
      source: "dom",
      rootPostId: "",
      postId: "root001",
      containerPostIds: ["root001"],
      excludedPostIds: [],
      validated: true
    },
    ...overrides
  };
}

function rawContinuation(overrides = {}) {
  return {
    text: "續文正文",
    sourceUrl: "https://www.threads.com/@sample/post/next002",
    author: "sample",
    publishedAt: "2026-09-01T01:03:03Z",
    threadPosition: "2/2",
    media: [],
    quotedPosts: [],
    longTextAttachments: [],
    captureValidation: {
      version: 2,
      source: "dom",
      rootPostId: "",
      postId: "next002",
      containerPostIds: ["next002"],
      excludedPostIds: [],
      validated: true
    },
    ...overrides
  };
}

async function resetStorage() {
  await chromeMock.storage.local.clear();
  await chromeMock.storage.session.clear();
  await background.initializeDefaults();
}

async function settleQueue() {
  await new Promise(resolve => setImmediate(resolve));
}

test("初始化會建立預設設定與空白狀態", async () => {
  await resetStorage();
  const snapshot = chromeMock.storage.local.snapshot();
  assert.deepEqual(snapshot[CONFIG_KEY], background.DEFAULT_CONFIG);
  assert.deepEqual(snapshot[STATE_KEY], background.DEFAULT_STATE);
});

test("擷取資料會清理文字、作者及網址", () => {
  const capture = background.sanitizeCapture(rawPost());
  assert.equal(capture.text, "測試正文");
  assert.equal(capture.author, "sample");
  assert.equal(capture.sourceUrl, "https://www.threads.com/@Sample/post/root001");
});

test("擷取資料會產生固定格式的去重鍵", () => {
  assert.equal(
    background.sanitizeCapture(rawPost()).dedupeKey,
    "tsc:root001"
  );
});

test("現有頁面擷取一律以保守完整度進入標準模型", () => {
  const capture = background.sanitizeCapture(rawPost({ completeness: "complete" }));
  assert.equal(capture.schemaVersion, 2);
  assert.equal(capture.sourceType, "page");
  assert.equal(capture.captureKind, "post");
  assert.equal(capture.completeness, "partial");
  assert.deepEqual(capture.incompleteReasons, ["page-completeness-unverified"]);
});

test("選取文字會標記為使用者主動確認的獨立來源", () => {
  const capture = background.sanitizeCapture(rawPost({ captureType: "selection" }));
  assert.equal(capture.sourceType, "selection");
  assert.equal(capture.captureKind, "selection");
  assert.equal(capture.completeness, "user-confirmed");
  assert.equal(capture.relationshipMethod, "manual");
  assert.match(capture.userConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("媒體資料只接受 HTTPS", () => {
  const capture = background.sanitizeCapture(rawPost({
    media: [
      { url: "http://example.test/a.jpg", width: 10, height: 10 },
      { url: "https://example.test/b.jpg", width: 20, height: 30, alt: "不保留" }
    ]
  }));
  assert.equal(capture.media.length, 1);
  assert.equal(capture.media[0].url, "https://example.test/b.jpg");
  assert.equal(capture.media[0].alt, "");
});

test("同路徑媒體會忽略不同查詢參數並去重", () => {
  const capture = background.sanitizeCapture(rawPost({ media: [
    { url: "https://example.test/a.jpg?one=1" },
    { url: "https://example.test/a.jpg?two=2" }
  ] }));
  assert.equal(capture.media.length, 1);
});

test("selection capture 不要求貼文容器驗證", () => {
  assert.equal(background.assertCaptureIntegrity({ captureType: "selection" }), true);
});

test("通過來源驗證的貼文可保存", () => {
  assert.equal(background.assertCaptureIntegrity(background.sanitizeCapture(rawPost())), true);
});

test("作者與來源網址不一致時拒絕保存", () => {
  assert.throws(
    () => background.sanitizeCapture(rawPost({ author: "other" })),
    /作者欄位與來源網址不一致/
  );
});

test("未通過來源容器驗證時拒絕保存", () => {
  const captureValidation = { ...rawPost().captureValidation, validated: false };
  assert.throws(() => background.sanitizeCapture(rawPost({ captureValidation })), /沒有通過來源容器驗證/);
});

test("同一份擷取資料不可出現重複貼文編號", () => {
  const duplicate = rawContinuation({
    sourceUrl: "https://www.threads.com/@sample/post/root001",
    threadPosition: "2/2",
    captureValidation: { ...rawPost().captureValidation }
  });
  assert.throws(
    () => background.sanitizeCapture(rawPost({ threadPosition: "1/2", continuations: [duplicate] })),
    /重複貼文編號/
  );
});

test("有續文時主貼文必須有串文序號", () => {
  assert.throws(() => background.sanitizeCapture(rawPost({ continuations: [rawContinuation()] })), /缺少主貼文串文序號/);
});

test("續文序號必須連續", () => {
  const continuation = rawContinuation({ threadPosition: "3/3" });
  assert.throws(
    () => background.sanitizeCapture(rawPost({ threadPosition: "1/3", continuations: [continuation] })),
    /續文序號不連續/
  );
});

test("無編號作者補充不可帶有串文序號", () => {
  assert.throws(
    () => background.sanitizeCapture(rawPost({ authorReplies: [rawContinuation()] })),
    /不應包含串文序號/
  );
});

test("空白主貼文且沒有媒體或附件時拒絕保存", () => {
  assert.throws(() => background.sanitizeCapture(rawPost({ text: "" })), /主貼文沒有正文/);
});

test("新擷取資料會加入 pending 佇列", async () => {
  await resetStorage();
  const result = await background.enqueueCaptures([rawPost()]);
  await settleQueue();
  const state = await background.readState();
  assert.equal(result.added, 1);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].status, "pending");
});

test("同一貼文重複入列時會略過", async () => {
  await resetStorage();
  await background.enqueueCaptures([rawPost()]);
  await settleQueue();
  const result = await background.enqueueCaptures([rawPost()]);
  await settleQueue();
  assert.equal(result.added, 0);
  assert.equal(result.duplicates, 1);
  assert.equal((await background.readState()).queue.length, 1);
});

test("本機已保存貼文不會再次加入一般佇列", async () => {
  await resetStorage();
  const capture = background.sanitizeCapture(rawPost());
  const state = structuredClone(background.DEFAULT_STATE);
  state.saved[capture.dedupeKey] = { notionPageId: "saved-page" };
  await background.writeState(state);
  const result = await background.enqueueCaptures([rawPost()]);
  await settleQueue();
  assert.equal(result.added, 0);
  assert.equal(result.duplicates, 1);
});

test("新文章一律排在佇列尾端，不會以覆寫項目插隊", async () => {
  await resetStorage();
  await background.enqueueCaptures([rawPost({ sourceUrl: "https://www.threads.com/@sample/post/other009", captureValidation: {
    ...rawPost().captureValidation,
    postId: "other009",
    containerPostIds: ["other009"]
  } })]);
  await settleQueue();
  const result = await background.enqueueCaptures([rawPost()], { replaceExisting: true });
  await settleQueue();
  const state = await background.readState();
  assert.equal(result.added, 1);
  assert.equal(state.queue.at(-1).capture.sourceUrl, "https://www.threads.com/@Sample/post/root001");
  assert.equal(state.queue.some(item => "replaceExisting" in item), false);
});

test("正在同步的同篇貼文再次保存只會略過", async () => {
  await resetStorage();
  const capture = background.sanitizeCapture(rawPost());
  const state = structuredClone(background.DEFAULT_STATE);
  state.queue.push({ id: capture.id, capture, status: "processing", attempts: 0, createdAt: capture.savedAt, lastError: "" });
  await background.writeState(state);
  const result = await background.enqueueCaptures([rawPost()], { replaceExisting: true });
  assert.equal(result.added, 0);
  assert.equal(result.duplicates, 1);
});

test("缺少 Notion 設定時 processQueue 保留 pending 狀態", async () => {
  await resetStorage();
  await background.enqueueCaptures([rawPost()]);
  await settleQueue();
  await background.processQueue();
  assert.equal((await background.readState()).queue[0].status, "pending");
});

test("SAVE_CAPTURES 訊息會交由佇列處理", async () => {
  await resetStorage();
  const result = await background.handleMessage({ type: "SAVE_CAPTURES", captures: [rawPost()] }, PAGE_SENDER);
  await settleQueue();
  assert.equal(result.added, 1);
});

test("選擇加入頁面在擴充功能自己的視窗進行：只接受選單頁的訊息與選單列出的頁面，網頁提示不含頁面標題", async () => {
  await resetStorage();
  const page = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const state = structuredClone(background.DEFAULT_STATE);
  state.appendTargets = [{ pageId: page, title: "噗文標題" }];
  await background.writeState(state);
  const toasts = [];
  const windows = [];
  const originalTabs = { ...chromeMock.tabs };
  chromeMock.runtime.id = "extension-id";
  chromeMock.runtime.getURL = file => `chrome-extension://extension-id/${file}`;
  chromeMock.windows = {
    async get() {
      return { left: 100, top: 50, width: 1200, height: 800 };
    },
    async create(details) {
      windows.push(details);
      return { id: 99 };
    }
  };
  Object.assign(chromeMock.tabs, {
    async sendMessage(tabId, message) {
      if (message.type === "PING") return { ok: true, result: { ready: true } };
      if (message.type === "CAPTURE_SELECTION") {
        return { ok: true, result: rawPost({ captureType: "selection", text: "讀者留言\n噗主回覆" }) };
      }
      if (message.type === "SHOW_TOAST") toasts.push(message.message);
      return { ok: true };
    }
  });
  try {
    await chromeMock.contextMenus.onClicked.dispatch(
      { menuItemId: "savour-append-selection-pick", selectionText: "讀者留言" },
      { id: 7, windowId: 1, url: "https://www.plurk.com/p/3abc0test1" }
    );
    assert.equal(windows.length, 1);
    assert.equal(windows[0].type, "popup");
    const token = windows[0].url.match(/^chrome-extension:\/\/extension-id\/pages\/picker\/picker\.html#(.+)$/)[1];
    const pickerSender = { id: "extension-id", url: windows[0].url };

    // Content scripts and other pages cannot use the picker's messages.
    for (const sender of [{ id: "extension-id", tab: { id: 7 }, url: "https://www.plurk.com/p/3abc0test1" }, {}]) {
      await assert.rejects(background.handleMessage({ type: "PICKER_SESSION", token }, sender), /不支援的操作/);
    }
    const view = await background.handleMessage({ type: "PICKER_SESSION", token }, pickerSender);
    assert.deepEqual(view.choices.recent, [{ pageId: page, title: "噗文標題" }]);
    assert.equal(view.choices.preselect, page);
    // The picker gets a short preview and the choices; the selection itself stays in the background.
    assert.deepEqual(Object.keys(view).sort(), ["choices", "previewText"]);
    assert.equal(view.previewText, "讀者留言 噗主回覆");
    await assert.rejects(background.handleMessage({ type: "PICKER_SESSION", token: "guessed" }, pickerSender), /選單已經失效/);

    // Only pages the picker offered can be chosen.
    await assert.rejects(
      background.handleMessage({ type: "PICKER_CHOOSE", token, target: { kind: "page", pageId: other } }, pickerSender),
      /請從清單中選擇頁面/
    );
    const chosen = await background.handleMessage({ type: "PICKER_CHOOSE", token, target: { kind: "page", pageId: page } }, pickerSender);
    assert.equal(chosen.message, "已加入佇列，會接在「噗文標題」最後面");
    const queued = await background.readState();
    assert.deepEqual(queued.queue[0].appendTo, { pageId: page, title: "噗文標題" });
    assert.equal(queued.queue[0].capture.text, "讀者留言\n噗主回覆");
    assert.deepEqual(toasts, ["已加入佇列，會接在這篇的 Notion 頁面最後面"]);
    assert.equal(toasts.some(message => message.includes("噗文標題")), false);
    // A session is used once.
    await assert.rejects(
      background.handleMessage({ type: "PICKER_CHOOSE", token, target: { kind: "new" } }, pickerSender),
      /選單已經失效/
    );
    await assert.rejects(background.handleMessage({ type: "SAVE_SELECTION_TO_TARGET" }, pickerSender), /不支援的操作/);
  } finally {
    Object.assign(chromeMock.tabs, originalTabs);
    delete chromeMock.windows;
  }
});

test("右鍵選單「保存目前頁面」保存的是目前頁面，不論點在頁面、連結或圖片上；彈出視窗可直接取得選單", async () => {
  await resetStorage();
  const toasts = [];
  const originalTabs = { ...chromeMock.tabs };
  chromeMock.runtime.id = "extension-id";
  Object.assign(chromeMock.tabs, {
    async query() {
      return [{ id: 7, windowId: 3, url: "https://www.threads.com/@Sample/post/root001" }];
    },
    async sendMessage(tabId, message) {
      if (message.type === "PING") return { ok: true, result: { ready: true } };
      if (message.type === "GET_PAGE_DATA_STATUS") return { ok: true, result: { stale: false } };
      if (message.type === "CAPTURE_CURRENT_THREAD") return { ok: true, result: rawPost() };
      if (message.type === "CAPTURE_SELECTION") return { ok: true, result: rawPost({ captureType: "selection", text: "選取的文字" }) };
      if (message.type === "SHOW_TOAST") toasts.push(message.message);
      return { ok: true };
    }
  });
  try {
    await chromeMock.runtime.onInstalled.dispatch();
    const menu = chromeMock.__createdMenus.find(item => item.id === "savour-save-post");
    assert.deepEqual(menu.contexts, ["page", "link", "image", "selection"]);
    const tab = { id: 7, url: "https://www.threads.com/@Sample/post/root001" };
    await chromeMock.contextMenus.onClicked.dispatch({ menuItemId: "savour-save-post", linkUrl: "https://www.threads.com/@Other/post/zzz" }, tab);
    await settleQueue();
    const queued = (await background.readState()).queue;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].capture.sourceUrl, "https://www.threads.com/@Sample/post/root001");
    assert.deepEqual(toasts, ["已加入保存佇列"]);

    const popupSender = { id: "extension-id", url: "chrome-extension://extension-id/pages/popup/popup.html" };
    await assert.rejects(background.handleMessage({ type: "PREPARE_APPEND_PICKER" }, { id: "extension-id", tab: { id: 7 }, url: tab.url }), /不支援的操作/);
    const { token } = await background.handleMessage({ type: "PREPARE_APPEND_PICKER" }, popupSender);
    const view = await background.handleMessage(
      { type: "PICKER_SESSION", token },
      { id: "extension-id", url: `chrome-extension://extension-id/pages/picker/picker.html#${token}` }
    );
    assert.equal(view.previewText, "選取的文字");
  } finally {
    Object.assign(chromeMock.tabs, originalTabs);
  }
});

test("保存選取文字的快捷鍵在工具列彈出視窗裡開啟選單；彈出視窗只領取一次、而且只給同一個分頁", async () => {
  await resetStorage();
  const opened = [];
  const windows = [];
  let activeTab = { id: 7, windowId: 3, url: "https://www.plurk.com/p/3abc0test1" };
  const originalTabs = { ...chromeMock.tabs };
  chromeMock.runtime.id = "extension-id";
  chromeMock.runtime.getURL = file => `chrome-extension://extension-id/${file}`;
  chromeMock.action = { async openPopup(options) { opened.push(options); } };
  chromeMock.windows = { async create(details) { windows.push(details); } };
  Object.assign(chromeMock.tabs, {
    async query() {
      return [activeTab];
    },
    async sendMessage(tabId, message) {
      if (message.type === "PING") return { ok: true, result: { ready: true } };
      if (message.type === "CAPTURE_SELECTION") return { ok: true, result: rawPost({ captureType: "selection", text: "選取的文字" }) };
      return { ok: true };
    }
  });
  const popupSender = { id: "extension-id", url: "chrome-extension://extension-id/pages/popup/popup.html" };
  try {
    await chromeMock.commands.onCommand.dispatch("save-selection");
    assert.deepEqual(opened, [{ windowId: 3 }]);
    assert.deepEqual(windows, []);
    await assert.rejects(background.handleMessage({ type: "TAKE_PENDING_PICKER" }, { id: "extension-id", tab: { id: 7 }, url: activeTab.url }), /不支援的操作/);
    const taken = await background.handleMessage({ type: "TAKE_PENDING_PICKER" }, popupSender);
    assert.match(taken.token, /^[0-9a-f-]{36}$/);
    const view = await background.handleMessage(
      { type: "PICKER_SESSION", token: taken.token },
      { id: "extension-id", url: `chrome-extension://extension-id/pages/picker/picker.html#${taken.token}` }
    );
    assert.equal(view.previewText, "選取的文字");
    assert.deepEqual(await background.handleMessage({ type: "TAKE_PENDING_PICKER" }, popupSender), { token: "" });

    // A popup opened on another tab gets the normal popup, not this picker.
    await chromeMock.commands.onCommand.dispatch("save-selection");
    activeTab = { id: 8, windowId: 3, url: "https://news.example.com/" };
    assert.deepEqual(await background.handleMessage({ type: "TAKE_PENDING_PICKER" }, popupSender), { token: "" });

    // Browsers that cannot open the popup get a separate window.
    activeTab = { id: 7, windowId: 3, url: "https://www.plurk.com/p/3abc0test1" };
    chromeMock.action.openPopup = async () => {
      throw new Error("Could not find an active browser window.");
    };
    await chromeMock.commands.onCommand.dispatch("save-selection");
    assert.equal(windows.length, 1);
    assert.match(windows[0].url, /picker\.html#/);
  } finally {
    Object.assign(chromeMock.tabs, originalTabs);
    delete chromeMock.action;
    delete chromeMock.windows;
  }
});

test("介面語言：設定成英文後，錯誤訊息、右鍵選單與送給頁面的訊息都改用英文；改回中文即恢復", async () => {
  await resetStorage();
  const sent = [];
  const originalTabs = { ...chromeMock.tabs };
  Object.assign(chromeMock.tabs, {
    async query() {
      return [{ id: 7, url: "https://news.example.com/story" }];
    },
    async sendMessage(tabId, message) {
      sent.push(message);
      if (message.type === "PING") return { ok: true, result: { ready: true } };
      return { ok: false, error: "頁面擷取失敗" };
    }
  });
  const setLanguage = async uiLanguage => {
    const config = (await chromeMock.storage.local.get("savourConfig")).savourConfig ?? {};
    await chromeMock.storage.local.set({ savourConfig: { ...config, uiLanguage } });
  };
  try {
    await setLanguage("en");
    await assert.rejects(background.handleMessage({ type: "NOPE" }, PAGE_SENDER), /^Error: Unsupported action$/);
    await chromeMock.runtime.onInstalled.dispatch();
    const titles = chromeMock.__createdMenus.map(menu => menu.title);
    assert.ok(titles.includes("Save the current page to Notion"));
    assert.ok(titles.includes("Save selected text to Notion"));
    assert.equal(titles.some(title => /[一-鿿]/.test(title)), false);
    await assert.rejects(background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER), /./);
    const captures = () => sent.filter(message => message.type !== "PING");
    assert.ok(captures().length > 0);
    assert.ok(captures().every(message => message.lang === "en"));

    await setLanguage("zh");
    sent.length = 0;
    await assert.rejects(background.handleMessage({ type: "NOPE" }, PAGE_SENDER), /^Error: 不支援的操作$/);
    await assert.rejects(background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER), /./);
    assert.ok(captures().length > 0);
    assert.ok(captures().every(message => message.lang === "zh"));
  } finally {
    Object.assign(chromeMock.tabs, originalTabs);
    await setLanguage("auto");
    await background.handleMessage({ type: "GET_STATUS" }, PAGE_SENDER);
  }
});

test("SAVE_CAPTURES 大量建立會保留確認資訊並在確認前不入列", async () => {
  await resetStorage();
  const state = structuredClone(background.DEFAULT_STATE);
  state.saved.existing = { title: "既有頁面" };
  await background.writeState(state);
  const captures = Array.from({ length: 21 }, (_, index) => {
    const postId = `bulk${String(index).padStart(3, "0")}`;
    return rawPost({
      sourceUrl: `https://www.threads.com/@sample/post/${postId}`,
      captureValidation: {
        ...rawPost().captureValidation,
        postId,
        containerPostIds: [postId]
      }
    });
  });

  await assert.rejects(
    background.handleMessage({ type: "SAVE_CAPTURES", captures }, PAGE_SENDER),
    error => error.code === "large_create_confirmation_required"
      && error.createCount === 21
      && error.limit === 20
  );
  assert.equal((await background.readState()).queue.length, 0);
  const response = await new Promise(resolve => {
    chromeMock.runtime.onMessage.listeners[0]({ type: "SAVE_CAPTURES", captures }, PAGE_SENDER, resolve);
  });
  assert.deepEqual({
    ok: response.ok,
    code: response.code,
    createCount: response.createCount,
    limit: response.limit
  }, {
    ok: false,
    code: "large_create_confirmation_required",
    createCount: 21,
    limit: 20
  });

  const result = await background.handleMessage({
    type: "SAVE_CAPTURES",
    captures,
    confirmedLargeCreate: true
  }, PAGE_SENDER);
  assert.equal(result.added, 21);
});

test("Notion fixture 涵蓋查詢、建立與驗證錯誤", () => {
  assert.equal(fixture("query-existing").results.length, 1);
  assert.equal(fixture("create-page").object, "page");
  assert.equal(fixture("validation-error").code, "validation_error");
});

test("GET_CONFIG 不會外洩 Token，只回報是否已設定", async () => {
  await resetStorage();
  await chromeMock.storage.session.set({ notionToken: "secret-token" });
  const config = await background.handleMessage({ type: "GET_CONFIG" }, PAGE_SENDER);
  assert.equal(config.hasToken, true);
  assert.equal(Object.hasOwn(config, "token"), false);
});

test("SAVE_SETTINGS 會正規化帳號並將非記憶 Token 留在 session", async () => {
  await resetStorage();
  const config = await background.handleMessage({
    type: "SAVE_SETTINGS",
    settings: { archiveName: " 測試整理庫 ", targetHandle: "@Sample", token: "token", rememberToken: false }
  }, PAGE_SENDER);
  assert.equal(config.archiveName, "測試整理庫");
  assert.equal(config.targetHandle, "sample");
  assert.equal(chromeMock.storage.session.snapshot().notionToken, "token");
  assert.equal(chromeMock.storage.local.snapshot().notionToken, undefined);
});

test("SAVE_SETTINGS 可將 Token 移至 local storage", async () => {
  await resetStorage();
  await chromeMock.storage.session.set({ notionToken: "remember-me" });
  const config = await background.handleMessage({
    type: "SAVE_SETTINGS",
    settings: { rememberToken: true }
  }, PAGE_SENDER);
  assert.equal(config.rememberToken, true);
  assert.equal(chromeMock.storage.local.snapshot().notionToken, "remember-me");
  assert.equal(chromeMock.storage.session.snapshot().notionToken, undefined);
});

test("CLEAR_RECENT 只清除最近紀錄", async () => {
  await resetStorage();
  const state = structuredClone(background.DEFAULT_STATE);
  state.recent = [{ key: "one" }, { key: "two" }];
  state.saved.keep = { title: "保留" };
  await background.writeState(state);
  const result = await background.handleMessage({ type: "CLEAR_RECENT" }, PAGE_SENDER);
  assert.equal(result.cleared, 2);
  assert.deepEqual((await background.readState()).recent, []);
  assert.equal((await background.readState()).saved.keep.title, "保留");
});

test("SYNC_NOTION_STATE 以 Notion 為準，並保留本機記下的作者回覆與待檢查標記", async () => {
  await resetStorage();
  const notion = globalThis.SavourNotion;
  const canonicalKey = "tsc:root001";
  await chromeMock.storage.local.set({
    [CONFIG_KEY]: { ...background.DEFAULT_CONFIG, dataSourceId: "data-source-one" }
  });
  await chromeMock.storage.session.set({ notionToken: "test-token" });
  const state = structuredClone(background.DEFAULT_STATE);
  state.saved[canonicalKey] = {
    sourceUrl: "https://www.threads.com/@sample/post/root001",
    title: "本機標題",
    authorReplyPostIds: ["reply-one"],
    reviewItems: ["串文未完整"]
  };
  state.saved["tsc:gone"] = { sourceUrl: "https://www.threads.com/@sample/post/gone", title: "已在 Notion 刪除" };
  state.recent = [{ key: canonicalKey, title: "本機標題" }];
  await background.writeState(state);

  const propertySchema = Object.fromEntries(
    Object.entries(notion.archivePropertySchema()).map(([name, definition]) => [
      name,
      { type: Object.keys(definition)[0], ...definition }
    ])
  );
  const page = {
    object: "page",
    id: "remote-page",
    url: "https://www.notion.so/remote-page",
    created_time: "2026-09-01T04:00:00.000Z",
    properties: {
      [notion.PROPERTY_NAMES.captureKey]: { rich_text: [{ plain_text: canonicalKey }] },
      [notion.PROPERTY_NAMES.sourceUrl]: { url: "https://threads.net/@sample/post/root001?xmt=tracking" },
      [notion.PROPERTY_NAMES.title]: { title: [{ plain_text: "遠端標題" }] },
      [notion.PROPERTY_NAMES.captureType]: { select: { name: "主貼文" } }
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.method === "GET"
      ? { object: "data_source", id: "data-source-one", properties: propertySchema }
      : { object: "list", results: [page], has_more: false, next_cursor: null };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
  };
  try {
    const result = await background.handleMessage({ type: "SYNC_NOTION_STATE" }, PAGE_SENDER);
    const synced = await background.readState();
    assert.equal(result.synced, 1);
    assert.equal(result.removed, 1);
    assert.deepEqual(Object.keys(synced.saved), [canonicalKey]);
    assert.equal(synced.saved[canonicalKey].title, "遠端標題");
    assert.deepEqual(synced.saved[canonicalKey].authorReplyPostIds, ["reply-one"]);
    assert.deepEqual(synced.saved[canonicalKey].reviewItems, ["串文未完整"]);
    assert.equal(synced.recent[0].key, canonicalKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EXPORT_AUDIT 會分別統計 pending、failed 與 saved", async () => {
  await resetStorage();
  const capture = background.sanitizeCapture(rawPost());
  const state = structuredClone(background.DEFAULT_STATE);
  state.queue = [
    { id: "p", capture, status: "pending" },
    { id: "f", capture: { ...capture, id: "f" }, status: "failed" }
  ];
  state.saved[capture.dedupeKey] = { title: "已保存" };
  await background.writeState(state);
  const audit = await background.handleMessage({ type: "EXPORT_AUDIT" }, PAGE_SENDER);
  assert.equal(audit.pendingCount, 1);
  assert.equal(audit.failedCount, 1);
  assert.equal(audit.savedCount, 1);
});

test("RETRY_FAILED 只重試完整性有效的失敗項目", async () => {
  await resetStorage();
  const valid = background.sanitizeCapture(rawPost());
  const invalid = { ...valid, id: "invalid", captureValidation: { ...valid.captureValidation, validated: false } };
  const state = structuredClone(background.DEFAULT_STATE);
  state.queue = [
    { id: "valid", capture: valid, status: "failed", attempts: 3, lastError: "x" },
    { id: "invalid", capture: invalid, status: "failed", attempts: 3, lastError: "x" }
  ];
  await background.writeState(state);
  const result = await background.handleMessage({ type: "RETRY_FAILED" }, PAGE_SENDER);
  await settleQueue();
  const updated = await background.readState();
  assert.equal(result.retried, 1);
  assert.equal(updated.queue.find(item => item.id === "valid").status, "pending");
  assert.equal(updated.queue.find(item => item.id === "invalid").status, "failed");
});

test("未知背景訊息會明確拒絕", async () => {
  await assert.rejects(background.handleMessage({ type: "UNKNOWN" }, PAGE_SENDER), /不支援的操作/);
});

const SOURCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATABASE_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

async function withFetch(handler, task) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function seedArchive(stateOverrides = {}) {
  await resetStorage();
  await chromeMock.storage.local.set({
    [CONFIG_KEY]: { ...background.DEFAULT_CONFIG, archiveTarget: SOURCE_A, dataSourceId: SOURCE_A },
    notionToken: "token"
  });
  const state = structuredClone(background.DEFAULT_STATE);
  state.saved = { "tsc:old": { title: "舊資料庫文章" } };
  state.recent = [{ key: "tsc:old", title: "舊資料庫文章" }];
  state.lastSyncedAt = "2026-09-01T00:00:00Z";
  Object.assign(state, stateOverrides);
  await background.writeState(state);
}

function switchFetch(requests) {
  return async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method });
    if (String(url).endsWith(`/v1/data_sources/${SOURCE_B}`)) {
      return jsonResponse({ object: "data_source", id: SOURCE_B, parent: { database_id: DATABASE_B } });
    }
    if (String(url).endsWith(`/v1/databases/${DATABASE_B}`)) {
      return jsonResponse({ object: "database", id: DATABASE_B, url: "https://www.notion.so/database-b" });
    }
    throw new Error(`未預期的 request：${url}`);
  };
}

test("LIST_NOTION_DATA_SOURCES 會分頁列出可用資料庫並標出目前使用中", async () => {
  await seedArchive();
  const bodies = [];
  const pages = [
    {
      object: "list",
      results: [
        { object: "data_source", id: SOURCE_B, parent: { database_id: DATABASE_B }, title: [{ plain_text: "乙 收藏" }], icon: { type: "emoji", emoji: "📚" } },
        { object: "data_source", id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", parent: { database_id: DATABASE_B }, in_trash: true, title: [{ plain_text: "垃圾桶" }] },
        { object: "page", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }
      ],
      has_more: true,
      next_cursor: "cursor-2"
    },
    {
      object: "list",
      results: [
        { object: "data_source", id: SOURCE_A, parent: { database_id: DATABASE_B }, title: [{ plain_text: "甲 收藏" }] }
      ],
      has_more: false,
      next_cursor: null
    }
  ];
  const result = await withFetch(async (url, options = {}) => {
    assert.match(String(url), /\/v1\/search$/);
    bodies.push(JSON.parse(options.body));
    return jsonResponse(pages[bodies.length - 1]);
  }, () => background.handleMessage({ type: "LIST_NOTION_DATA_SOURCES", token: "typed-token" }, PAGE_SENDER));

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].filter, { property: "object", value: "data_source" });
  assert.equal(bodies[1].start_cursor, "cursor-2");
  assert.deepEqual(result.dataSources.map(item => item.id).sort(), [SOURCE_A, SOURCE_B].sort());
  assert.equal(result.dataSources.find(item => item.id === SOURCE_B).emoji, "📚");
  assert.equal(result.currentDataSourceId, SOURCE_A);
  assert.equal(result.limitReached, false);
});

test("沒有 Token 時列出資料庫會提示先輸入 Token", async () => {
  await resetStorage();
  await assert.rejects(
    background.handleMessage({ type: "LIST_NOTION_DATA_SOURCES" }, PAGE_SENDER),
    /請先輸入 Notion Integration Token/
  );
});

test("換到另一個資料庫會清掉本機已保存索引與失敗項目，不呼叫任何 Notion 寫入", async () => {
  const capture = background.sanitizeCapture(rawPost());
  await seedArchive({ queue: [{ id: "failed", capture, status: "failed", attempts: 3, lastError: "x" }] });
  const requests = [];
  const config = await withFetch(switchFetch(requests), () => background.handleMessage({
    type: "SAVE_SETTINGS",
    settings: { archiveTarget: SOURCE_B }
  }, PAGE_SENDER));

  const state = await background.readState();
  assert.equal(config.dataSourceChanged, true);
  assert.equal(config.dataSourceId, SOURCE_B);
  assert.deepEqual(state.saved, {});
  assert.deepEqual(state.recent, []);
  assert.equal(state.lastSyncedAt, "");
  assert.deepEqual(state.queue, []);
  assert.equal(requests.every(item => item.method === "GET"), true);
});

test("保存佇列還有等待中的文章時不可更換資料庫", async () => {
  const capture = background.sanitizeCapture(rawPost());
  await seedArchive({ queue: [{ id: "pending", capture, status: "pending", attempts: 0, lastError: "" }] });
  await assert.rejects(
    withFetch(switchFetch([]), () => background.handleMessage({
      type: "SAVE_SETTINGS",
      settings: { archiveTarget: SOURCE_B }
    }, PAGE_SENDER)),
    /請等「等待中」歸零後再更換/
  );
  const stored = (await chromeMock.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
  const state = await background.readState();
  assert.equal(stored.dataSourceId, SOURCE_A);
  assert.deepEqual(Object.keys(state.saved), ["tsc:old"]);
});

test("沒有帶整理庫欄位的設定儲存不會更換資料庫或清掉索引", async () => {
  await seedArchive();
  const config = await background.handleMessage({
    type: "SAVE_SETTINGS",
    settings: { archiveName: "新名稱" }
  }, PAGE_SENDER);
  const state = await background.readState();
  assert.equal(config.dataSourceChanged, false);
  assert.equal(config.dataSourceId, SOURCE_A);
  assert.deepEqual(Object.keys(state.saved), ["tsc:old"]);
});

function mockThreadsTab({ stale = false, capture = rawPost(), needsInjection = false } = {}) {
  const calls = [];
  // With needsInjection the page answers only after its scripts were injected, and a reload drops them.
  let scripted = !needsInjection;
  const listeners = [];
  const tab = { id: 7, url: "https://www.threads.com/@Sample/post/root001" };
  const original = { ...chromeMock.tabs };
  Object.assign(chromeMock.tabs, {
    async query() {
      return [tab];
    },
    async sendMessage(tabId, message) {
      if (message.type === "PING") {
        if (!scripted) throw new Error("Receiving end does not exist.");
        return { ok: true, result: { ready: true } };
      }
      if (!scripted) throw new Error("Receiving end does not exist.");
      calls.push(message.type);
      if (message.type === "GET_PAGE_DATA_STATUS") return { ok: true, result: { stale } };
      if (message.type === "WAIT_FOR_POST") return { ok: true, result: { ready: true } };
      if (message.type === "CAPTURE_CURRENT_THREAD") return { ok: true, result: structuredClone(capture) };
      return { ok: true };
    },
    async get() {
      return tab;
    },
    async reload(tabId) {
      calls.push(`reload:${tabId}`);
      scripted = !needsInjection;
      setTimeout(() => listeners.forEach(listener => listener(tabId, { status: "complete" })), 0);
    },
    onUpdated: {
      addListener(listener) {
        listeners.push(listener);
      },
      removeListener(listener) {
        listeners.splice(listeners.indexOf(listener), 1);
      }
    }
  });
  if (needsInjection) {
    chromeMock.scripting = {
      async insertCSS() {},
      async executeScript() {
        calls.push("inject");
        scripted = true;
      }
    };
  }
  return {
    calls,
    restore: () => {
      Object.assign(chromeMock.tabs, original);
      delete chromeMock.scripting;
    }
  };
}

test("從站內換頁進入的貼文會先重新整理一次再保存", async () => {
  await resetStorage();
  const tab = mockThreadsTab({ stale: true });
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    await settleQueue();
    assert.equal(result.pageReloaded, true);
    assert.equal(result.added, 1);
    assert.deepEqual(tab.calls, ["GET_PAGE_DATA_STATUS", "reload:7", "WAIT_FOR_POST", "CAPTURE_CURRENT_THREAD"]);
  } finally {
    tab.restore();
  }
});

test("頁面沒有擷取程式時按保存才放入，重新整理後會再放入一次", async () => {
  await resetStorage();
  const tab = mockThreadsTab({ stale: true, needsInjection: true });
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    await settleQueue();
    assert.equal(result.pageReloaded, true);
    assert.deepEqual(tab.calls, ["inject", "GET_PAGE_DATA_STATUS", "reload:7", "inject", "WAIT_FOR_POST", "CAPTURE_CURRENT_THREAD"]);
  } finally {
    tab.restore();
  }
});

test("保存當下由頁面讀取圖片並暫存，擷取資料只留下鑰匙；讀不到的圖片留給上傳時回報", async () => {
  await resetStorage();
  const read = [];
  const photo = rawPost({
    media: [
      { type: "image", url: "https://scontent.cdninstagram.com/ok.jpg" },
      { type: "image", url: "https://scontent.cdninstagram.com/blocked.jpg" },
      { type: "image", url: "http://192.168.0.5/private.jpg" }
    ]
  });
  const tab = mockThreadsTab({ capture: photo });
  chromeMock.scripting = {
    async insertCSS() {},
    async executeScript(details) {
      read.push(details.args[0]);
      return [{ result: details.args[0].includes("blocked") ? { ok: false, error: "HTTP 403" } : { ok: true, type: "image/jpeg", size: 3, base64: "AQID" } }];
    }
  };
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    assert.equal(result.added, 1);
    assert.deepEqual(read, ["https://scontent.cdninstagram.com/ok.jpg", "https://scontent.cdninstagram.com/blocked.jpg"]);
    const queued = (await background.readState()).queue[0].capture;
    assert.deepEqual(Object.keys(queued.stagedImages), ["https://scontent.cdninstagram.com/ok.jpg"]);
    assert.equal(JSON.stringify(queued).includes("AQID"), false);
  } finally {
    tab.restore();
  }
});

test("直接開啟的貼文不會重新整理", async () => {
  await resetStorage();
  const tab = mockThreadsTab({ stale: false });
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    await settleQueue();
    assert.equal(result.pageReloaded, false);
    assert.deepEqual(tab.calls, ["GET_PAGE_DATA_STATUS", "CAPTURE_CURRENT_THREAD"]);
  } finally {
    tab.restore();
  }
});

test("已保存但標記串文未完整的文章會以只補缺漏段落的方式入列", async () => {
  await resetStorage();
  const capture = background.sanitizeCapture(rawPost());
  const state = structuredClone(background.DEFAULT_STATE);
  state.saved[capture.dedupeKey] = {
    sourceUrl: capture.sourceUrl,
    title: "缺段串文",
    reviewItems: ["串文未完整"]
  };
  await background.writeState(state);
  const tab = mockThreadsTab();
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    const updated = await background.readState();
    assert.equal(result.appendMissing, true);
    assert.equal(result.added, 1);
    assert.equal(updated.queue[0].appendMissing, true);
    assert.equal(updated.recent.some(item => item.result === "already_saved"), false);
  } finally {
    tab.restore();
  }
});

test("已保存且完整的文章仍只顯示已存在，不重新擷取", async () => {
  await resetStorage();
  const capture = background.sanitizeCapture(rawPost());
  const state = structuredClone(background.DEFAULT_STATE);
  state.saved[capture.dedupeKey] = { sourceUrl: capture.sourceUrl, title: "完整文章", reviewItems: [] };
  await background.writeState(state);
  const tab = mockThreadsTab();
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    assert.equal(result.localStatus, "saved");
    assert.deepEqual(tab.calls, []);
  } finally {
    tab.restore();
  }
});

test("更新 Notion 頁面：已保存的文章會重新擷取，並以只換原文的方式入列", async () => {
  await resetStorage();
  const capture = background.sanitizeCapture(rawPost());
  const state = structuredClone(background.DEFAULT_STATE);
  state.saved[capture.dedupeKey] = { sourceUrl: capture.sourceUrl, title: "完整文章", reviewItems: [], notionUrl: "https://notion.test/p" };
  await background.writeState(state);
  const tab = mockThreadsTab();
  try {
    const status = await background.handleMessage({ type: "GET_ACTIVE_PAGE_STATUS" }, PAGE_SENDER);
    assert.deepEqual(status, { supported: true, status: "saved", title: "完整文章", notionUrl: "https://notion.test/p" });
    const result = await background.handleMessage({ type: "UPDATE_ACTIVE_PAGE" }, PAGE_SENDER);
    const updated = await background.readState();
    assert.equal(result.updateExisting, true);
    assert.equal(result.added, 1);
    assert.equal(updated.queue[0].updateExisting, true);
    assert.equal(updated.queue[0].appendMissing, undefined);
    assert.ok(tab.calls.includes("CAPTURE_CURRENT_THREAD"));
  } finally {
    tab.restore();
  }
});

test("一般網頁在保存時才注入擷取程式，已注入時不重複注入", async () => {
  await resetStorage();
  const injected = [];
  let ready = false;
  const tab = { id: 9, url: "https://news.example.com/story?id=5&utm_source=x" };
  const originalTabs = { ...chromeMock.tabs };
  const article = {
    platform: "web",
    captureType: "post",
    sourceUrl: "https://news.example.com/story?id=5",
    title: "新聞標題",
    captureValidation: { version: 2, source: "web-page", validated: true },
    articleBlocks: [{ type: "paragraph", spans: [{ text: "新聞內容" }] }]
  };
  chromeMock.scripting = {
    async insertCSS(details) {
      injected.push(["css", details.target.tabId, ...details.files]);
    },
    async executeScript(details) {
      injected.push(["js", details.target.tabId, ...details.files]);
      ready = true;
    }
  };
  Object.assign(chromeMock.tabs, {
    async query() {
      return [tab];
    },
    async sendMessage(tabId, message) {
      if (message.type === "PING") {
        if (!ready) throw new Error("Could not establish connection. Receiving end does not exist.");
        return { ok: true, result: { ready: true } };
      }
      if (message.type === "GET_PAGE_DATA_STATUS") return { ok: true, result: { stale: false } };
      if (message.type === "CAPTURE_CURRENT_THREAD") return { ok: true, result: structuredClone(article) };
      return { ok: true };
    }
  });
  try {
    const first = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    assert.equal(first.added, 1);
    assert.deepEqual(injected.map(item => item.slice(0, 2)), [["css", 9], ["js", 9]]);
    assert.ok(injected[1].includes("vendor/readability/Readability.js"));
    const queued = (await background.readState()).queue[0].capture;
    assert.equal(queued.dedupeKey, "web:https://news.example.com/story?id=5");
    const again = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    assert.equal(again.localStatus, "pending");
    await background.handleMessage({ type: "CAPTURE_ACTIVE_SELECTION" }, PAGE_SENDER).catch(() => {});
    assert.equal(injected.length, 2);
  } finally {
    Object.assign(chromeMock.tabs, originalTabs);
    delete chromeMock.scripting;
  }
});

test("擴充功能更新前就開著的 Threads 分頁，保存時會補上 Threads 的擷取程式", async () => {
  await resetStorage();
  const injected = [];
  let loaded = false;
  const originalTabs = { ...chromeMock.tabs };
  chromeMock.scripting = {
    async insertCSS(details) {
      injected.push(details.files);
    },
    async executeScript(details) {
      injected.push(details.files);
      loaded = true;
    }
  };
  Object.assign(chromeMock.tabs, {
    async query() {
      return [{ id: 5, url: "https://www.threads.com/@Sample/post/root001" }];
    },
    async sendMessage(tabId, message) {
      if (!loaded) throw new Error("Receiving end does not exist.");
      if (message.type === "PING") return { ok: true, result: { ready: true } };
      if (message.type === "GET_PAGE_DATA_STATUS") return { ok: true, result: { stale: false } };
      if (message.type === "CAPTURE_CURRENT_THREAD") return { ok: true, result: rawPost() };
      return { ok: true };
    }
  });
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    assert.equal(result.added, 1);
    assert.deepEqual(injected[0], ["content/content.css"]);
    assert.equal(injected[1].at(-1), "content/threads-content.js");
    assert.ok(!injected[1].includes("content/web-content.js"));
  } finally {
    Object.assign(chromeMock.tabs, originalTabs);
    delete chromeMock.scripting;
  }
});

test("無法注入的頁面（例如 Chrome 線上應用程式商店）會顯示清楚的原因", async () => {
  await resetStorage();
  const originalTabs = { ...chromeMock.tabs };
  chromeMock.scripting = {
    async insertCSS() {
      throw new Error("The extensions gallery cannot be scripted.");
    },
    async executeScript() {
      throw new Error("The extensions gallery cannot be scripted.");
    }
  };
  Object.assign(chromeMock.tabs, {
    async query() {
      return [{ id: 3, url: "https://chromewebstore.google.com/detail/abc" }];
    },
    async sendMessage() {
      throw new Error("Receiving end does not exist.");
    }
  });
  try {
    await assert.rejects(background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER), /無法讀取這個頁面/);
    Object.assign(chromeMock.tabs, { async query() { return [{ id: 4, url: "chrome://extensions/" }]; } });
    await assert.rejects(background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER), /這個分頁不是網頁/);
    assert.deepEqual(await background.handleMessage({ type: "GET_ACTIVE_PAGE_STATUS" }, PAGE_SENDER), { supported: false, status: "unsupported" });
  } finally {
    Object.assign(chromeMock.tabs, originalTabs);
    delete chromeMock.scripting;
  }
});

const PASTE_URL = "https://paste.plurk.com/show/AbCdEf123456/";
const OWN_SENDER = () => ({ id: chromeMock.runtime.id, tab: { id: 7 } });

test("Plurk Paste 只能由擴充功能自己的頁面腳本要求，且只接受 Paste 文章網址", async () => {
  await assert.rejects(background.handleMessage({ type: "FETCH_PLURK_PASTE", url: PASTE_URL }, PAGE_SENDER), /不支援的操作/);
  await assert.rejects(
    background.handleMessage({ type: "FETCH_PLURK_PASTE", url: "https://www.plurk.com/settings" }, OWN_SENDER()),
    /不是 Plurk Paste 網址/
  );
});

test("Plurk Paste 以不帶登入資訊的方式讀取", async () => {
  const requests = [];
  const result = await withFetch(async (url, options = {}) => {
    requests.push({ url: String(url), credentials: options.credentials });
    return { ok: true, url: String(url), text: async () => "<html>paste</html>" };
  }, () => background.handleMessage({ type: "FETCH_PLURK_PASTE", url: PASTE_URL }, OWN_SENDER()));
  assert.deepEqual(requests, [{ url: PASTE_URL, credentials: "omit" }]);
  assert.equal(result.html, "<html>paste</html>");
});

test("Plurk Paste 被導到其他頁面（例如登入頁）時回傳空內容，改用分頁讀取", async () => {
  const result = await withFetch(async () => ({
    ok: true,
    url: "https://www.plurk.com/login",
    text: async () => "<html>login</html>"
  }), () => background.handleMessage({ type: "FETCH_PLURK_PASTE", url: PASTE_URL }, OWN_SENDER()));
  assert.equal(result.html, "");
});

test("在噗浪單篇頁按保存會擷取噗文並以噗浪去重鍵入列", async () => {
  await resetStorage();
  const plurkCapture = {
    platform: "plurk",
    captureType: "post",
    sourceUrl: "https://www.plurk.com/p/3abc0test1",
    author: "tester",
    text: "噗文正文",
    media: [],
    authorReplies: [],
    continuations: [],
    captureValidation: { version: 2, source: "plurk-page", postId: "3abc0test1", validated: true }
  };
  const tab = mockThreadsTab({ capture: plurkCapture });
  const originalQuery = chromeMock.tabs.query;
  chromeMock.tabs.query = async () => [{ id: 7, url: "https://www.plurk.com/p/3abc0test1" }];
  try {
    const result = await background.handleMessage({ type: "CAPTURE_ACTIVE_THREAD" }, PAGE_SENDER);
    const state = await background.readState();
    assert.equal(result.added, 1);
    assert.equal(state.queue[0].capture.dedupeKey, "plurk:3abc0test1");
  } finally {
    chromeMock.tabs.query = originalQuery;
    tab.restore();
  }
});

test("網站上的內容腳本不能讀設定、改設定或匯出紀錄，只能讀 Plurk Paste", async () => {
  const contentScript = { id: "extension-id", tab: { id: 7 }, url: "https://evil.example/page" };
  for (const message of [
    { type: "GET_CONFIG" },
    { type: "SAVE_SETTINGS", settings: { token: "attacker-token", archiveTarget: "x" } },
    { type: "LIST_NOTION_DATA_SOURCES", token: "attacker-token" },
    { type: "EXPORT_AUDIT" },
    { type: "GET_STATUS" },
    { type: "SAVE_CAPTURES", captures: [] }
  ]) {
    await assert.rejects(background.handleMessage(message, contentScript), /不支援的操作/, message.type);
  }
  // Another extension's page is not Savour's own page either.
  await assert.rejects(background.handleMessage({ type: "GET_CONFIG" }, { id: "other-extension", url: "chrome-extension://other-extension/x.html" }), /不支援的操作/);
  // Savour's settings page may.
  const config = await background.handleMessage({ type: "GET_CONFIG" }, { id: "extension-id", tab: { id: 3 }, url: "chrome-extension://extension-id/pages/options/options.html" });
  assert.equal(typeof config.hasToken, "boolean");
  assert.equal("token" in config, false);
});

test("設定還沒完成（沒有 Token 或整理庫）時不加入佇列，並說明要先去設定", async () => {
  background.setSetupCheckForTests(null);
  try {
    await resetStorage();
    await assert.rejects(background.enqueueCaptures([rawPost()]), /請先到設定頁填入 Notion Token/);
    await chromeMock.storage.session.set({ notionToken: "token" });
    await assert.rejects(background.enqueueCaptures([rawPost()]), /請先到設定頁選擇或建立整理庫/);
    assert.equal((await background.readState()).queue.length, 0);
  } finally {
    background.setSetupCheckForTests(async () => {});
  }
});

test("還沒選整理庫時留下的等待項目，不會擋住第一次設定整理庫", async () => {
  await resetStorage();
  const capture = background.sanitizeCapture(rawPost());
  const state = structuredClone(background.DEFAULT_STATE);
  state.queue = [{ id: "waiting", capture, status: "pending", attempts: 0 }];
  await background.writeState(state);
  await chromeMock.storage.session.set({ notionToken: "token" });
  const requests = [];
  await withFetch(switchFetch(requests), () => background.handleMessage({
    type: "SAVE_SETTINGS",
    settings: { archiveTarget: SOURCE_B }
  }, PAGE_SENDER));
  assert.equal((await background.readState()).queue.some(item => item.id === "waiting"), false);
});
