"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installDom } = require("./helpers/dom-env");
const S = require("../lib/shared.js");
const M = require("../model/capture-model.js");
const N = require("../notion/index.js");
const { createFacebookCapture, parseFacebookTime } = require("../content/facebook-capture.js");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "dom", `${name}.html`), "utf8");

function capture(name, url) {
  const env = installDom(fixture(name), { url });
  try {
    return createFacebookCapture({ shared: S }).captureStatus();
  } finally {
    env.restore();
  }
}

const POST_URL = "https://www.facebook.com/samplepage/posts/pfbid02ABC?fbclid=1";
const GROUP_URL = "https://www.facebook.com/groups/1000000000000001/posts/1000000000000003/";

test("Facebook 貼文：emoji 以 alt 保留、連結還原、貼文圖片與連結卡片；留言與表情圖片不混入", () => {
  const result = capture("facebook-post", POST_URL);
  assert.equal(result.siteName, "Facebook");
  assert.equal(result.author, "Sample Page");
  assert.equal(result.sourceUrl, "https://www.facebook.com/samplepage/posts/pfbid02ABC");
  assert.equal(result.title, "🇳🇴 Trip plan");
  assert.equal(result.downloadMedia, true);
  assert.equal(new Date(result.publishedAt).getHours(), 19);
  assert.equal(new Date(result.publishedAt).getMinutes(), 35);

  const paragraphs = result.articleBlocks.filter(block => block.type === "paragraph");
  assert.deepEqual(paragraphs.map(block => block.spans.map(span => span.text).join("").trim()), [
    "🇳🇴 Trip plan",
    "Line two,\nline three,",
    "Day 1: see https://example.com/plan #norway"
  ]);
  const links = paragraphs[2].spans.filter(span => span.href).map(span => span.href);
  assert.deepEqual(links, ["https://example.com/plan"]);
  assert.ok(paragraphs[2].spans.some(span => !span.href && span.text.includes("#norway")));

  const images = result.articleBlocks.filter(block => block.type === "image");
  assert.equal(images.length, 2);
  assert.ok(images.every(image => image.url.includes("scontent-syd2-1.xx.fbcdn.net/v/t39.30808-6/")));
  assert.deepEqual(result.articleBlocks.filter(block => block.type === "bookmark"), [{ type: "bookmark", url: "https://example.com/card" }]);
  assert.ok(!JSON.stringify(result.articleBlocks).includes("comment"));
});

test("社團貼文：作者是成員而不是社團，沒有可解析的時間時發布時間留空", () => {
  const result = capture("facebook-group-post", GROUP_URL);
  assert.equal(result.author, "Sample Member");
  assert.equal(result.sourceUrl, "https://www.facebook.com/groups/1000000000000001/posts/1000000000000003");
  assert.equal(result.publishedAt, "");
  assert.equal(result.articleBlocks.filter(block => block.type === "image").length, 1);
});

test("貼文在疊於動態牆上的對話框裡時，存的是對話框裡的貼文，不是底下動態牆的別人貼文", () => {
  const result = capture("facebook-dialog-post", "https://www.facebook.com/samplepage/posts/pfbid02ABC");
  assert.equal(result.author, "Sample Page");
  assert.equal(result.title, "The post in the dialog");
  assert.equal(result.articleBlocks.filter(block => block.type === "image").length, 1);
  assert.ok(!JSON.stringify(result.articleBlocks).includes("different post"));
  assert.ok(!JSON.stringify(result.articleBlocks).includes("comment"));
});

test("Facebook 貼文通過驗證，以 Facebook 來源與網址去重寫入 Notion，圖片由擴充功能下載", () => {
  const raw = capture("facebook-post", POST_URL);
  const normalized = M.normalizeCapture(raw, { sourceType: "page" });
  assert.equal(M.validateCapture(normalized), true);
  assert.equal(normalized.downloadMedia, true);
  assert.equal(normalized.dedupeKey, `web:${raw.sourceUrl}`);
  const payload = N.createPagePayload(normalized, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.properties[N.PROPERTY_NAMES.platform].select.name, "Facebook");
  assert.equal(new URL(payload.icon.external.url).searchParams.get("domain"), "www.facebook.com");
});

test("不是貼文頁、頁面上沒有這則貼文時會取消，不會存成別則", () => {
  assert.throws(() => capture("facebook-post", "https://www.facebook.com/"), /請先點開一則 Facebook 貼文/);
  assert.throws(() => capture("x-status", POST_URL), /找不到這則 Facebook 貼文/);
});

test("同一則貼文的不同網址形式是同一篇；其他 Facebook 頁面與其他網站不受影響", () => {
  const key = S.webPageKey("https://www.facebook.com/samplepage/posts/pfbid02ABC");
  for (const url of [
    "https://m.facebook.com/samplepage/posts/pfbid02ABC/?fbclid=1&__cft__[0]=x",
    "https://web.facebook.com/samplepage/posts/pfbid02ABC?comment_id=5#top"
  ]) assert.equal(S.webPageKey(url), key);
  assert.equal(
    S.webPageKey("https://m.facebook.com/permalink.php?story_fbid=pfbid1&id=100&ref=x"),
    "web:https://www.facebook.com/permalink.php?story_fbid=pfbid1&id=100"
  );
  assert.equal(S.facebookPostInfo("https://www.facebook.com/groups/12/permalink/99/").path, "/groups/12/posts/99");
  assert.equal(S.facebookPostInfo("https://www.facebook.com/photo/?fbid=1").token, "");
  assert.equal(S.facebookPostInfo("https://example.com/a/posts/b").token, "");
});

test("發布時間解析中文與英文格式，不認得的格式回傳空字串", () => {
  const hm = iso => { const d = new Date(iso); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };
  assert.deepEqual(hm(parseFacebookTime("2026年10月7日 星期三下午7:35")), [2026, 10, 7, 19, 35]);
  assert.deepEqual(hm(parseFacebookTime("2026年1月2日 上午12:05")), [2026, 1, 2, 0, 5]);
  assert.deepEqual(hm(parseFacebookTime("Wednesday, October 7, 2026 at 7:35 PM")), [2026, 10, 7, 19, 35]);
  assert.deepEqual(hm(parseFacebookTime("Oct 7, 2026 at 12:00 PM")), [2026, 10, 7, 12, 0]);
  assert.equal(parseFacebookTime("17小時"), "");
  assert.equal(parseFacebookTime("2026年10月7日"), "");
});
