"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { installDom } = require("./helpers/dom-env");
const S = require("../lib/shared.js");
const M = require("../model/capture-model.js");
const N = require("../notion/index.js");
const D = require("../model/dedupe-key.js");
const { createPlurkCapture } = require("../content/plurk-capture.js");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "dom", `${name}.html`), "utf8");
const PLURK_URL = "https://www.plurk.com/p/3abc0test1";
const PASTE_URL = "https://paste.plurk.com/show/AbCdEf123456/";

function pasteFromFixture() {
  return S.extractPlurkPasteFromDocument(new JSDOM(fixture("plurk-paste")).window.document);
}

async function capturePlurk({ url = PLURK_URL, readPaste } = {}) {
  const env = installDom(fixture("plurk-post"), { url });
  try {
    const reads = [];
    const capture = createPlurkCapture({
      shared: S,
      readPaste: readPaste ?? (async pasteUrl => {
        reads.push(pasteUrl);
        return pasteFromFixture();
      })
    });
    return { result: await capture.captureCurrentPlurk(), reads };
  } finally {
    env.restore();
  }
}

test("Plurk Paste 只取正文欄，不含行號，並保留段落", () => {
  assert.deepEqual(pasteFromFixture(), {
    title: "長文的第一句話",
    text: "長文的第一句話。\n\n第二段有 粗體 文字。\n第三段。"
  });
});

test("噗浪網址會正規化並使用獨立的去重鍵", () => {
  assert.equal(S.normalizeThreadsUrl("https://m.plurk.com/p/3ABC0TEST1?r=1#x"), PLURK_URL);
  assert.equal(D.captureKey({ sourceUrl: PLURK_URL }), "plurk:3abc0test1");
  assert.equal(S.isPlurkPasteUrl(PASTE_URL), true);
  assert.equal(S.isPlurkPasteUrl("https://paste.plurk.com/"), false);
  assert.equal(S.isPlurkPasteUrl("https://evil.example/show/abc"), false);
  assert.equal(S.isSupportedSourceUrl("https://www.plurk.com/top"), true);
});

test("單篇噗文保存正文、圖片、連結、預覽卡片、Plurk Paste 長文與噗主自己的補充", async () => {
  const { result, reads } = await capturePlurk();
  assert.deepEqual(reads, [PASTE_URL]);
  assert.equal(result.platform, "plurk");
  assert.equal(result.sourceUrl, PLURK_URL);
  assert.equal(result.author, "tester");
  assert.equal(result.publishedAt, "2026-09-29T05:34:32.000Z");
  assert.equal(result.text, [
    "一萬字，預估閱讀時間三十分鐘",
    "",
    "第二段，粗體重點",
    "長文的第一句話 (Plurk Paste)",
    "",
    "參考：https://example.test/...",
    "",
    "#測試"
  ].join("\n"));
  assert.deepEqual(result.media.map(item => item.url), ["https://images.plurk.com/SamplePhotoAaaaaaaaaa1.jpg"]);
  assert.deepEqual(result.links.find(link => link.text === "https://example.test/..."), {
    text: "https://example.test/...",
    url: "https://example.test/articles/very-long-path?ref=plurk"
  });
  assert.ok(result.links.some(link => link.url === PASTE_URL));
  assert.deepEqual(result.linkCards.map(card => card.url), ["https://news.example.test/story"]);
  assert.deepEqual(result.longTextAttachments, [{
    title: "Plurk Paste：長文的第一句話",
    text: "長文的第一句話。\n\n第二段有 粗體 文字。\n第三段。",
    source: "plurk_paste"
  }]);
  assert.deepEqual(result.authorReplies.map(reply => reply.text), ["補充：這是噗主自己的延伸內容"]);
  assert.deepEqual(result.authorReplies[0].media.map(item => item.url), ["https://images.plurk.com/SamplePhotoBbbbbbbbbb2.jpg"]);
  assert.equal(result.authorReplies[0].responseId, "640356842047885");
});

test("Plurk Paste 讀不到時仍保存噗文並標記正文疑似遺漏", async () => {
  const { result } = await capturePlurk({ readPaste: async () => { throw new Error("offline"); } });
  assert.deepEqual(result.longTextAttachments, []);
  assert.deepEqual(result.reviewFlags, ["正文疑似遺漏"]);
  assert.match(result.captureNotes[0], /Plurk Paste/);
});

test("網址與頁面上的噗文編號不一致時取消保存", async () => {
  await assert.rejects(capturePlurk({ url: "https://www.plurk.com/p/3abc0test2" }), /不是同一則噗/);
});

test("噗文擷取通過資料檢查，並以來源「噗浪」寫入 Notion", async () => {
  const { result } = await capturePlurk();
  const capture = M.normalizeCapture(result, { sourceType: "page", completeness: "partial", relationshipMethod: "page-inference" });
  assert.equal(capture.dedupeKey, "plurk:3abc0test1");
  assert.equal(M.validateCapture(capture), true);
  const payload = N.createPagePayload(capture, "data-source");
  assert.equal(payload.properties[N.PROPERTY_NAMES.platform].select.name, "噗浪");
  assert.equal(payload.properties[N.PROPERTY_NAMES.postId].rich_text[0].text.content, "3abc0test1");
  // The Paste's text goes straight into the page, with no "Plurk Paste：" heading.
  assert.equal(payload.children.some(block => /^heading_/.test(block.type) && JSON.stringify(block).includes("Plurk Paste")), false);
  assert.ok(payload.children.some(block => block.type === "paragraph" && JSON.stringify(block).includes("第二段有")));
  assert.ok(payload.children.some(block => block.type === "bookmark"
    && block.bookmark.url === "https://news.example.test/story"));
  const threadsPayload = N.createPagePayload({ ...capture, platform: undefined, sourceUrl: "https://www.threads.com/@a/post/ABC" }, "data-source");
  assert.equal(threadsPayload.properties[N.PROPERTY_NAMES.platform].select.name, "Threads");
});

test("噗主回應重複或屬於別則噗時無法通過資料檢查", async () => {
  const { result } = await capturePlurk();
  const capture = M.normalizeCapture(result);
  const duplicated = { ...capture, authorReplies: [capture.authorReplies[0], capture.authorReplies[0]] };
  assert.throws(() => M.validateCapture(duplicated), /重複回應編號/);
  const foreign = { ...capture, authorReplies: [{ ...capture.authorReplies[0], sourceUrl: "https://www.plurk.com/p/zzzz" }] };
  assert.throws(() => M.validateCapture(foreign), /不屬於這則噗/);
});

test("從噗浪頁面到 Notion 頁面：Paste 全文緊接在 Paste 連結下面，連結後面的文字在全文之後", async () => {
  const { result } = await capturePlurk();
  const normalized = M.normalizeCapture(result, { sourceType: "page" });
  const lines = N.buildPageChildren(normalized)
    .map(block => (block[block.type]?.rich_text ?? []).map(item => item.text.content).join(""))
    .filter(Boolean);
  const paste = lines.findIndex(line => line.startsWith("長文的第一句話。"));
  const link = lines.findIndex(line => line.includes("長文的第一句話 (Plurk Paste)"));
  assert.ok(link >= 0 && paste === link + 1, `Paste 全文應在連結正下方：${JSON.stringify(lines)}`);
  assert.ok(lines.findIndex(line => line.includes("#測試")) > paste, "標籤等後續文字應在 Paste 全文之後");
});

test("噗文裡嵌入的 YouTube / Vimeo 影片會以 Notion 影片區塊保存（YouTube 與其他影片網站的播放器都轉成觀看頁網址）", async () => {
  // This plurk has no Paste: with one, the Paste's own place in the text decides the order instead.
  const html = fixture("plurk-post").replace(/<a href="https:\/\/paste\.plurk\.com[^>]*>[^<]*<\/a>/, "").replace(
    "<span class=\"hashtag\">",
    `<iframe class="ogrendered" width="500" height="320" src="https://www.youtube.com/embed/Sample12345?feature=oembed"></iframe><iframe src="https://player.vimeo.com/video/123456789"></iframe><iframe src="https://ads.example.test/frame"></iframe><span class="hashtag">`
  );
  const env = installDom(html, { url: PLURK_URL });
  try {
    const capture = createPlurkCapture({ shared: S, readPaste: async () => pasteFromFixture() });
    const result = await capture.captureCurrentPlurk();
    assert.deepEqual(result.videos, ["https://www.youtube.com/watch?v=Sample12345", "https://vimeo.com/123456789"]);
    const normalized = M.normalizeCapture(result, { sourceType: "page" });
    assert.deepEqual(normalized.videos, result.videos);
    const videoUrls = N.buildPageChildren(normalized).filter(block => block.type === "video").map(block => block.video.external.url);
    assert.deepEqual(videoUrls, result.videos);
    // The video stays where the page shows it: after the text, before the hashtags that follow it.
    const kinds = N.buildPageChildren(normalized).map(block => (block.type === "video" ? "video" : (block[block.type]?.rich_text ?? []).map(/** @type {any} */ item => item.text.content).join("")));
    const firstVideo = kinds.indexOf("video");
    const tag = kinds.findIndex(line => line.includes("#測試"));
    assert.ok(firstVideo > 0 && tag > firstVideo, `影片應在標籤之前：${JSON.stringify(kinds)}`);
  } finally {
    env.restore();
  }
});

test("嵌入影片網址只認 https 的 YouTube / Vimeo，其他網站與不是影片的網址不算", () => {
  assert.equal(S.embeddedVideoWatchUrl("https://www.youtube-nocookie.com/embed/Sample12345"), "https://www.youtube.com/watch?v=Sample12345");
  assert.equal(S.embeddedVideoWatchUrl("http://www.youtube.com/embed/Sample12345"), "");
  assert.equal(S.embeddedVideoWatchUrl("https://evil.example/embed/Sample12345"), "");
  assert.equal(S.embeddedVideoWatchUrl("https://www.youtube.com/@channel"), "");
  assert.equal(S.embeddedVideoWatchUrl("javascript:alert(1)"), "");
});
