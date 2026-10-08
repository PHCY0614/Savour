"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/shared.js");
const M = require("../model/capture-model.js");
const N = require("../notion/index.js");
const { createYouTubeCapture, parsePlayerResponse, parseChapters } = require("../content/youtube-capture.js");

const VIDEO_ID = "Sample67890";
const DESCRIPTION = [
  "第一行說明，更多在 https://example.com/page.",
  "",
  "0:00 開場",
  "1:30 重點一",
  "12:05 重點二 (結尾)",
  "",
  "#標籤"
].join("\n");

function player(overrides = {}) {
  return {
    videoDetails: {
      videoId: VIDEO_ID,
      title: "範例影片",
      author: "範例頻道",
      channelId: "UC123",
      lengthSeconds: "3725",
      shortDescription: DESCRIPTION,
      ...overrides
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: "2026-03-04T10:00:00-08:00",
        ownerProfileUrl: "http://www.youtube.com/@sample"
      }
    }
  };
}

test("從頁面文字取出 ytInitialPlayerResponse，字串裡的大括號不影響範圍", () => {
  const text = `var a = 1; var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { title: "含 } 與 { 的標題" } })};var b = 2;`;
  assert.equal(parsePlayerResponse(text).videoDetails.title, "含 } 與 { 的標題");
  assert.equal(parsePlayerResponse("沒有資料"), null);
  assert.equal(parsePlayerResponse("ytInitialPlayerResponse = {壞掉"), null);
});

test("章節來自說明欄的時間碼；少於三個、不從 0:00 開始或時間倒退都不算章節", () => {
  assert.deepEqual(parseChapters(DESCRIPTION).map(item => [item.label, item.seconds, item.title]), [
    ["0:00", 0, "開場"],
    ["1:30", 90, "重點一"],
    ["12:05", 725, "重點二 (結尾)"]
  ]);
  assert.deepEqual(parseChapters("0:00 a\n1:00 b"), []);
  assert.deepEqual(parseChapters("0:10 a\n1:00 b\n2:00 c"), []);
  assert.deepEqual(parseChapters("0:00 a\n2:00 b\n1:00 c\n3:00 d").map(item => item.seconds), [0, 120, 180]);
  assert.equal(parseChapters("0:00 a\n0:30 b\n1:00 c\n1:02:03 d")[3].label, "1:02:03");
});

test("YouTube 影片存成網頁文章：影片嵌入、頻道、章節、說明欄，來源標示 YouTube", () => {
  const capture = createYouTubeCapture({ shared: S }).buildCapture(player(), VIDEO_ID);
  assert.equal(capture.sourceUrl, `https://www.youtube.com/watch?v=${VIDEO_ID}`);
  assert.equal(capture.title, "範例影片");
  assert.equal(capture.author, "範例頻道");
  assert.equal(capture.siteName, "YouTube");
  assert.equal(capture.publishedAt, "2026-03-04T10:00:00-08:00");
  assert.deepEqual(capture.articleBlocks[0], { type: "video", url: capture.sourceUrl });
  const types = capture.articleBlocks.map(block => block.type);
  assert.deepEqual(types.slice(0, 3), ["video", "paragraph", "heading"]);
  assert.equal(types.filter(type => type === "bulleted").length, 3);
  const chapter = capture.articleBlocks.find(block => block.type === "bulleted");
  assert.equal(chapter.spans[0].href, `${capture.sourceUrl}&t=0s`);
  const description = capture.articleBlocks.filter(block => block.type === "paragraph").slice(1);
  assert.ok(description[0].spans.some(span => span.href === "https://example.com/page"));

  const normalized = M.normalizeCapture(capture, { sourceType: "page" });
  assert.equal(M.validateCapture(normalized), true);
  assert.equal(normalized.dedupeKey, `web:${capture.sourceUrl}`);

  const payload = N.createPagePayload(normalized, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.properties[N.PROPERTY_NAMES.platform].select.name, "YouTube");
  assert.equal(payload.properties[N.PROPERTY_NAMES.title].title[0].text.content, "範例影片");
  assert.equal(payload.children[0].type, "video");
  assert.equal(payload.children[0].video.external.url, capture.sourceUrl);
  assert.equal(new URL(payload.icon.external.url).searchParams.get("domain"), "www.youtube.com");
});

test("影片資料不是目前這支影片時會取消，不會把別支影片存進來", () => {
  const youtube = createYouTubeCapture({ shared: S });
  assert.throws(() => youtube.buildCapture(player({ videoId: "AAAAAAAAAAA" }), VIDEO_ID), /沒有讀到這支影片的資料/);
  assert.throws(() => youtube.buildCapture(null, VIDEO_ID), /沒有讀到這支影片的資料/);
});

test("不同網址形式的同一支影片是同一篇，其他網站的 watch?v= 不受影響", () => {
  const key = S.webPageKey(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  for (const url of [
    `https://youtu.be/${VIDEO_ID}?si=abc`,
    `https://m.youtube.com/watch?v=${VIDEO_ID}&t=42s&list=PL1&index=3`,
    `https://www.youtube.com/shorts/${VIDEO_ID}`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}`
  ]) assert.equal(S.webPageKey(url), key);
  assert.equal(S.youtubeVideoId("https://www.youtube.com/"), "");
  assert.equal(S.youtubeVideoId(`https://example.com/watch?v=${VIDEO_ID}`), "");
  assert.equal(S.webPageKey(`https://example.com/watch?v=${VIDEO_ID}`), `web:https://example.com/watch?v=${VIDEO_ID}`);
});
