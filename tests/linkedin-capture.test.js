"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installDom } = require("./helpers/dom-env");
const S = require("../lib/shared.js");
const I = require("../i18n/index.js");
const M = require("../model/capture-model.js");
const N = require("../notion/index.js");
const { createLinkedInCapture } = require("../content/linkedin-capture.js");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "dom", `${name}.html`), "utf8");

function capture(name, url, html = fixture(name)) {
  const env = installDom(html, { url });
  try {
    return createLinkedInCapture({ shared: S }).captureStatus();
  } finally {
    env.restore();
  }
}

const SHARE_URL = "https://www.linkedin.com/feed/update/urn:li:share:7400000000000000001/";
const REPOST_URL = "https://www.linkedin.com/feed/update/urn:li:ugcPost:7400000000000000004/";

test("LinkedIn 貼文：正文、連結、圖片與連結卡片；留言與頭像不混入，編號與時間來自頁面", () => {
  const result = capture("linkedin-post", SHARE_URL);
  assert.equal(result.siteName, "LinkedIn");
  assert.equal(result.author, "Sample Author");
  assert.equal(result.sourceUrl, "https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000002/");
  assert.equal(result.publishedAt, "2025-11-28T02:38:05.351Z");
  assert.equal(result.title, "Hello everyone!");

  const [first, second] = result.articleBlocks.filter(block => block.type === "paragraph");
  assert.equal(first.spans.map(span => span.text).join(""), "Hello everyone!");
  const links = second.spans.filter(span => span.href).map(span => [span.text, span.href]);
  assert.deepEqual(links, [
    ["https://example.com/form", "https://example.com/form"],
    ["Friend One", "https://www.linkedin.com/in/friend-one/"]
  ]);
  assert.ok(second.spans.some(span => !span.href && span.text.includes("#Topic")));

  const images = result.articleBlocks.filter(block => block.type === "image");
  assert.deepEqual(images.map(image => image.caption), ["", "Slide about risk"]);
  assert.ok(images.every(image => image.url.startsWith("https://media.licdn.com/dms/image/v2/")));
  assert.deepEqual(result.articleBlocks.filter(block => block.type === "bookmark"), [{ type: "bookmark", url: "https://example.com/card" }]);
  assert.ok(!JSON.stringify(result.articleBlocks).includes("A comment"));
});

test("轉貼：保存自己的評語，原貼文只留作者、摘要與連結書籤，不存完整內容與圖片", () => {
  const result = capture("linkedin-repost", REPOST_URL);
  assert.equal(result.author, "Re Poster");
  assert.equal(result.title, "My thoughts on this event.");
  assert.deepEqual(result.articleBlocks.map(block => block.type), ["paragraph", "quote", "bookmark"]);
  const quote = result.articleBlocks[1];
  assert.equal(quote.spans[0].text, "轉貼自 Original Author");
  assert.ok(quote.spans[1].text.startsWith("\nThrilled to have attended"));
  assert.ok(quote.spans[1].text.endsWith("…"));
  assert.ok(quote.spans[1].text.length <= 150);
  assert.ok(!quote.spans[1].text.includes("more"));
  assert.deepEqual(result.articleBlocks[2], { type: "bookmark", url: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7400000000000000003/" });
});

test("沒有評語的轉貼以原作者當標題，冒號跟著介面語言", () => {
  const html = fixture("linkedin-repost").replace("<span>My thoughts on this event.</span>", "");
  assert.equal(capture("linkedin-repost", REPOST_URL, html).title, "轉貼：Original Author");
  I.setLanguage("en");
  try {
    assert.equal(capture("linkedin-repost", REPOST_URL, html).title, "Repost: Original Author");
  } finally {
    I.setLanguage("zh");
  }
});

test("LinkedIn 貼文通過驗證並以 LinkedIn 來源與貼文編號去重寫入 Notion", () => {
  const raw = capture("linkedin-repost", REPOST_URL);
  const normalized = M.normalizeCapture(raw, { sourceType: "page" });
  assert.equal(M.validateCapture(normalized), true);
  assert.equal(normalized.dedupeKey, `web:${raw.sourceUrl}`);
  const payload = N.createPagePayload(normalized, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.properties[N.PROPERTY_NAMES.platform].select.name, "LinkedIn");
  assert.equal(new URL(payload.icon.external.url).searchParams.get("domain"), "www.linkedin.com");
  assert.ok(payload.children.some(block => block.type === "bookmark"));
});

test("不是貼文頁、頁面上沒有這則貼文或網址與頁面不符時會取消", () => {
  assert.throws(() => capture("linkedin-post", "https://www.linkedin.com/feed/"), /請先點開一則 LinkedIn 貼文/);
  assert.throws(() => capture("linkedin-post", "https://www.linkedin.com/feed/update/urn:li:share:7000000000000000000/"), /找不到這則 LinkedIn 貼文/);
  assert.throws(() => capture("x-status", SHARE_URL), /找不到這則 LinkedIn 貼文/);
});

test("不同網址形式的同一則貼文是同一篇，其他網站的相同路徑不受影響", () => {
  const key = S.webPageKey(SHARE_URL);
  assert.equal(S.webPageKey(`${SHARE_URL}?utm_source=share&rcm=abc`), key);
  assert.equal(S.webPageKey("https://linkedin.com/feed/update/urn%3Ali%3Ashare%3A7400000000000000001"), key);
  assert.equal(
    S.webPageKey("https://www.linkedin.com/posts/someone_hello-activity-7400000000000000002-AbCd?utm_source=share"),
    S.webPageKey("https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000002/")
  );
  assert.equal(S.linkedInPostInfo("https://example.com/feed/update/urn:li:share:7400000000000000001/").id, "");
});
