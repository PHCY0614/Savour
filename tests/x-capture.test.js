"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installDom } = require("./helpers/dom-env");
const S = require("../lib/shared.js");
const M = require("../model/capture-model.js");
const N = require("../notion/index.js");
const { createXCapture } = require("../content/x-capture.js");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "dom", `${name}.html`), "utf8");

function captureX(name, url, statusId = "") {
  const env = installDom(fixture(name), { url });
  try {
    return createXCapture({ shared: S }).captureStatus(statusId);
  } finally {
    env.restore();
  }
}

const NEW_LAYOUT_URL = "https://x.com/Writer/status/1790000000000000034";

test("X 新版頁面：保存主貼文正文、emoji、連結、圖片原圖與引用網址，不混入被引用的內容", () => {
  const result = captureX("x-status", NEW_LAYOUT_URL);
  assert.equal(result.platform, "x");
  assert.equal(result.sourceUrl, "https://x.com/writer/status/1790000000000000034");
  assert.equal(result.author, "writer");
  assert.equal(result.publishedAt, "2024-05-13T12:43:51.248Z");
  assert.equal(result.text, "今天整理了三個重點 🧵\n1. 先寫大綱\n2. 再補細節✨\n\n參考 go.example.org/notes 與 @Friend");
  assert.doesNotMatch(result.text, /被引用/);
  assert.deepEqual(result.links.map(link => link.url), ["https://go.example.org/notes", "https://x.com/Friend"]);
  assert.deepEqual(result.media.map(item => item.url), [
    "https://pbs.twimg.com/media/SamplePhoto1?format=webp&name=large",
    "https://pbs.twimg.com/media/SECONDimg123?format=jpg&name=large"
  ]);
  assert.deepEqual(result.quotedPosts, [{ sourceUrl: "https://x.com/other/status/1770000000000000001" }]);
  assert.deepEqual(result.linkCards.map(card => card.url), ["https://t.co/cardlink"]);
  assert.deepEqual(result.reviewFlags, []);
});

test("X 只接續緊接在主貼文後面的作者自己的貼文，遇到別人就停止", () => {
  const result = captureX("x-status", NEW_LAYOUT_URL);
  assert.deepEqual(result.authorReplies.map(entry => entry.sourceUrl), [
    "https://x.com/writer/status/1790000000000000040",
    "https://x.com/writer/status/1790000000000000050"
  ]);
  assert.equal(result.authorReplies[0].text, "3. 最後校稿，完成。");
  assert.deepEqual(result.authorReplies[1].reviewFlags, ["正文疑似遺漏"]);
  assert.match(result.captureNotes.join("\n"), /顯示更多/);
  assert.equal(JSON.stringify(result).includes("讀者的回覆"), false);
  assert.equal(JSON.stringify(result).includes("作者回覆讀者"), false);
});

test("X 動態牆上右鍵的貼文只保存那一則，不接續後面的貼文", () => {
  const result = captureX("x-status", "https://x.com/home", "1790000000000000040");
  assert.equal(result.sourceUrl, "https://x.com/writer/status/1790000000000000040");
  assert.equal(result.text, "3. 最後校稿，完成。");
  assert.deepEqual(result.authorReplies, []);
});

test("X 經典版頁面：以 data-testid 讀取正文，引用卡片的文字與圖片不會混入", () => {
  const result = captureX("x-status-classic", "https://twitter.com/Classic/status/1800000000000000001?s=20");
  assert.equal(result.sourceUrl, "https://x.com/classic/status/1800000000000000001");
  assert.equal(result.text, "Main post text with a link https://example.com/a/very/long/path/that/continues");
  assert.deepEqual(result.links, [{ text: "https://example.com/a/very/long/path/that/continues", url: "https://t.co/abc" }]);
  assert.deepEqual(result.media.map(item => item.url), ["https://pbs.twimg.com/media/MainPhoto?format=jpg&name=large"]);
  assert.deepEqual(result.quotedPosts, [{ sourceUrl: "https://x.com/quoted/status/1800000000000000002" }]);
  assert.equal(result.authorReplies.length, 1);
  assert.deepEqual(result.authorReplies[0].reviewFlags, ["正文疑似遺漏"]);
});

test("找不到對應貼文或不在貼文頁時會明確取消", () => {
  assert.throws(() => captureX("x-status", "https://x.com/home"), /請先點開這則 X 貼文/);
  assert.throws(() => captureX("x-status", "https://x.com/Writer/status/999"), /找不到這則 X 貼文/);
});

test("X 擷取通過驗證，並以 X 來源、貼文編號與 x: 去重鍵寫入 Notion", () => {
  const capture = M.normalizeCapture(captureX("x-status", NEW_LAYOUT_URL), { sourceType: "page" });
  assert.equal(capture.dedupeKey, "x:1790000000000000034");
  assert.equal(capture.authorReplies.length, 2);
  assert.equal(capture.quotedPosts[0].canonicalUrl, "https://x.com/other/status/1770000000000000001");
  const payload = N.createPagePayload(capture, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.properties[N.PROPERTY_NAMES.platform].select.name, "X");
  assert.equal(payload.properties[N.PROPERTY_NAMES.postId].rich_text[0].text.content, "1790000000000000034");
  assert.equal(payload.properties[N.PROPERTY_NAMES.author].rich_text[0].text.content, "writer");
  assert.ok(payload.properties[N.PROPERTY_NAMES.title].title[0].text.content.startsWith("今天整理了三個重點"));
  assert.equal(payload.children.filter(block => block.type === "divider").length, 2);
  assert.ok(JSON.stringify(payload.children).includes("https://x.com/other/status/1770000000000000001"));
});

test("X 驗證會拒絕別人的貼文混進作者補充或缺少來源驗證", () => {
  const raw = captureX("x-status", NEW_LAYOUT_URL);
  assert.throws(() => M.normalizeCapture({
    ...raw,
    authorReplies: [{ ...raw.authorReplies[0], sourceUrl: "https://x.com/reader/status/1790000000000000060" }]
  }), /作者補充不屬於主貼文作者/);
  assert.throws(() => M.normalizeCapture({ ...raw, captureValidation: { ...raw.captureValidation, postId: "1" } }), /來源驗證/);
  assert.throws(() => M.normalizeCapture({ ...raw, continuations: [raw.authorReplies[0]] }), /作者補充/);
});
