"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/shared.js");
const D = require("../model/dedupe-key.js");

test("短網址與作者貼文網址會產生同一個 shortcode key", () => {
  const shortUrl = "https://threads.net/t/ABC123?xmt=tracking";
  const authorUrl = "https://www.threads.com/@Example/post/ABC123/media#reply";
  assert.equal(D.captureKey({ sourceUrl: shortUrl }), "tsc:ABC123");
  assert.equal(D.captureKey({ sourceUrl: authorUrl }), "tsc:ABC123");
  assert.equal(D.captureKey({ sourceUrl: shortUrl }), D.captureKey({ sourceUrl: authorUrl }));
});

test("Threads 路徑別名會折疊為穩定 canonical URL", () => {
  assert.equal(
    S.normalizeThreadsUrl("https://threads.net/@Example/t/ABC123/extra"),
    "https://www.threads.com/@Example/post/ABC123"
  );
  assert.equal(
    S.normalizeThreadsUrl("https://threads.com/post/ABC123"),
    "https://www.threads.com/t/ABC123"
  );
});

test("Threads 貼文以 shortcode 為鍵，網頁以整理過的網址為鍵", () => {
  assert.equal(D.captureKey({
    sourceUrl: "https://www.threads.com/@example/post/ABC123",
    threadsMediaId: "179123"
  }), "tsc:ABC123");
  assert.equal(D.captureKey({ shortcode: "ABC123" }), "tsc:ABC123");
  assert.equal(
    D.captureKey({ sourceUrl: "https://example.com/article" }),
    "web:https://example.com/article"
  );
});

test("X 貼文與一般網頁各自只有一種身分鍵", () => {
  const x = { sourceUrl: "https://twitter.com/Someone/status/1790000000000000034" };
  assert.equal(D.captureKey(x), "x:1790000000000000034");
  const page = { sourceUrl: "https://news.example.com/2026/10/story.html?utm_source=feed" };
  assert.equal(D.captureKey(page), "web:https://news.example.com/2026/10/story.html");
});

test("選取文字維持同步 FNV key 且不與完整貼文相等", () => {
  const capture = {
    sourceUrl: "https://threads.net/t/ABC123",
    text: "同一段文字"
  };
  const selectionKey = D.captureKey({ ...capture, captureType: "selection" });
  assert.match(selectionKey, /^selection:https:\/\/www\.threads\.com\/t\/ABC123:[0-9a-f]{8}$/);
  assert.notEqual(selectionKey, D.captureKey({ ...capture, captureType: "post" }));
  assert.equal(selectionKey, S.captureKey({ ...capture, captureType: "selection" }));
});

