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


// ---- Fixed outputs: the keys already stored in Notion and the local index ----
// These pin what every site produces today, so moving the code cannot change a stored key.

test("各平台的去重鍵維持既有格式", () => {
  const expected = [
    [{ sourceUrl: "https://threads.net/t/ABC123?xmt=x" }, "tsc:ABC123"],
    [{ sourceUrl: "https://www.threads.com/@Example/post/ABC123/media#r" }, "tsc:ABC123"],
    [{ sourceUrl: "https://www.plurk.com/p/3abc0test1" }, "plurk:3abc0test1"],
    [{ sourceUrl: "https://twitter.com/Sample/status/20?s=20" }, "x:20"],
    [{ sourceUrl: "https://www.instagram.com/p/Abc123Post1/" }, "ig:Abc123Post1"],
    [{ sourceUrl: "https://www.instagram.com/reel/Abc123Reel1/" }, "ig:Abc123Reel1"],
    [{ sourceUrl: "https://www.instagram.com/example_user/" }, "post:https://www.instagram.com/example_user/"],
    [{ sourceUrl: "https://news.example.com/a?id=3&utm_source=x#c" }, "web:https://news.example.com/a?id=3"],
    [{ sourceUrl: `https://example.com/?q=${"a".repeat(2000)}` }, "web:#5964ae77-2023"],
    [{ canonicalUrl: "https://news.example.com/b" }, "web:https://news.example.com/b"],
    [{ author: "a", text: "t" }, "post:a15ab530"],
    [
      { captureType: "selection", sourceUrl: "https://news.example.com/a", text: " 一段  文字 " },
      "selection:https://news.example.com/a:94c62574"
    ]
  ];
  for (const [capture, key] of expected) assert.equal(D.captureKey(capture), key, JSON.stringify(capture));
});

test("本機保存狀態在各平台都認得已保存、等待中與失敗的同一篇", () => {
  const urls = [
    "https://www.threads.com/@example/post/ABC123",
    "https://www.plurk.com/p/3abc0test1",
    "https://x.com/sample/status/20",
    "https://www.instagram.com/p/Abc123Post1/",
    "https://www.instagram.com/example_user/",
    "https://news.example.com/a?id=3"
  ];
  for (const sourceUrl of urls) {
    const key = D.captureKey({ sourceUrl });
    const record = { sourceUrl, title: "已保存" };
    const queued = (/** @type {string} */ status) => ({
      queue: [{ id: "Q1", status, capture: { captureType: "post", dedupeKey: key, sourceUrl } }],
      saved: {}
    });

    assert.deepEqual(S.localPostCaptureStatus({ queue: [], saved: { [key]: record } }, sourceUrl), {
      status: "saved", key, record
    }, sourceUrl);
    assert.deepEqual(S.localPostCaptureStatus(queued("pending"), sourceUrl), {
      status: "pending", key, queueId: "Q1"
    }, sourceUrl);
    assert.equal(S.localPostCaptureStatus(queued("failed"), sourceUrl).status, "failed", sourceUrl);
    assert.equal(S.localPostCaptureStatus({ queue: [], saved: {} }, sourceUrl).status, "new", sourceUrl);
    // A selection from the same page is not the post itself.
    const selectionKey = D.captureKey({ captureType: "selection", sourceUrl, text: "一段" });
    assert.equal(S.localPostCaptureStatus({
      queue: [],
      saved: { [selectionKey]: { sourceUrl, captureType: "selection" } }
    }, sourceUrl).status, "new", sourceUrl);
  }
});

test("本機保存狀態會忽略追蹤參數，不同網站的同名路徑不算同一篇", () => {
  const key = D.captureKey({ sourceUrl: "https://a.example.com/post/1" });
  const state = { queue: [], saved: { [key]: { sourceUrl: "https://a.example.com/post/1" } } };
  assert.equal(S.localPostCaptureStatus(state, "https://a.example.com/post/1?utm_source=x").status, "saved");
  assert.equal(S.localPostCaptureStatus(state, "https://b.example.com/post/1").status, "new");
  // Threads short and author URLs of one post are the same post.
  const threadsKey = D.captureKey({ sourceUrl: "https://www.threads.com/@example/post/ABC123" });
  const threads = { queue: [], saved: { [threadsKey]: { sourceUrl: "https://www.threads.com/@example/post/ABC123" } } };
  assert.equal(S.localPostCaptureStatus(threads, "https://threads.net/t/ABC123").status, "saved");
});
