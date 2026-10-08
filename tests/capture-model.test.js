"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../model/capture-model.js");
const F = require("../model/source-flags.js");

function rawPost(overrides = {}) {
  return {
    captureType: "post",
    text: "  標準化正文  ",
    sourceUrl: "https://threads.net/@Example/post/ABC123?xmt=tracking",
    author: "@Example",
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
      postId: "ABC123",
      containerPostIds: ["ABC123"],
      excludedPostIds: [],
      validated: true
    },
    ...overrides
  };
}

for (const sourceType of F.SOURCE_TYPES) {
  for (const completeness of F.COMPLETENESS_VALUES) {
    test(`capture model 接受 ${sourceType} × ${completeness}`, () => {
      const relationshipMethod = sourceType === "api" ? "api" : sourceType === "manual" ? "manual" : "page-inference";
      const capture = M.normalizeCapture(rawPost(), { sourceType, completeness, relationshipMethod });
      assert.equal(capture.schemaVersion, M.SCHEMA_VERSION);
      assert.equal(capture.sourceType, sourceType);
      assert.equal(capture.completeness, completeness);
      assert.equal(capture.relationshipMethod, relationshipMethod);
      assert.equal(M.validateCapture(capture), true);
    });
  }
}

test("未知來源與完整度採保守預設", () => {
  const capture = M.normalizeCapture(rawPost(), { sourceType: "unknown", completeness: "unknown" });
  assert.equal(capture.sourceType, "page");
  assert.equal(capture.completeness, "partial");
  assert.deepEqual(capture.incompleteReasons, ["page-completeness-unverified"]);
});

test("既有待檢查旗標會轉成缺漏原因", () => {
  const capture = M.normalizeCapture(rawPost({ reviewFlags: ["串文未完整", "圖片未完整"] }), {
    sourceType: "page",
    completeness: "partial"
  });
  assert.deepEqual(capture.incompleteReasons, ["thread-incomplete", "media-incomplete"]);
});

test("API 來源可用媒體 ID 驗證，不依賴 DOM 容器標記", () => {
  const raw = rawPost({
    threadsMediaId: "17912345678901234",
    captureValidation: undefined
  });
  const capture = M.normalizeCapture(raw, {
    sourceType: "api",
    completeness: "complete",
    relationshipMethod: "api"
  });
  assert.equal(M.validateCapture(capture), true);
});

test("page 擷取使用 shortcode 穩定去重鍵", () => {
  const capture = M.normalizeCapture(rawPost(), { sourceType: "page", completeness: "partial" });
  assert.equal(capture.dedupeKey, "tsc:ABC123");
});

test("selection 即使帶有媒體 ID 仍使用獨立文字去重鍵", () => {
  const capture = M.normalizeCapture(rawPost({
    captureType: "selection",
    threadsMediaId: "17912345678901234"
  }), { sourceType: "selection", completeness: "user-confirmed", relationshipMethod: "manual" });
  assert.match(capture.dedupeKey, /^selection:https:\/\/www\.threads\.com\/@Example\/post\/ABC123:/);
});

test("標記缺漏的資料不會被宣告為 complete", () => {
  const capture = M.normalizeCapture(rawPost({ reviewFlags: ["串文未完整"] }), {
    sourceType: "page",
    completeness: "complete"
  });
  assert.equal(capture.completeness, "partial");
  assert.deepEqual(capture.incompleteReasons, ["thread-incomplete"]);
});

test("續文與作者補充會建立排序後的識別清單", () => {
  const validation = postId => ({
    version: 2,
    source: "dom",
    rootPostId: "",
    postId,
    containerPostIds: [postId],
    excludedPostIds: [],
    validated: true
  });
  const capture = M.normalizeCapture(rawPost({
    threadPosition: "1/2",
    continuations: [{
      text: "續文",
      sourceUrl: "https://www.threads.com/@example/post/DEF456",
      author: "example",
      threadPosition: "2/2",
      captureValidation: validation("DEF456")
    }],
    authorReplies: [{
      text: "補充",
      sourceUrl: "https://www.threads.com/@example/post/GHI789",
      author: "example",
      captureValidation: validation("GHI789")
    }]
  }), { sourceType: "page", completeness: "partial" });
  assert.deepEqual(capture.continuationIds, ["DEF456"]);
  assert.deepEqual(capture.supplementIds, ["GHI789"]);
  assert.equal(capture.supplements[0].text, "補充");
});

test("text_attachment 支援 plaintext、連結與 styling info", () => {
  const capture = M.normalizeCapture(rawPost({
    text_attachment: {
      plaintext: "長文全文",
      link_attachment_url: "https://example.test/article",
      styling_info: [{ offset: 0, length: 2, style: "bold" }]
    }
  }), { sourceType: "api", completeness: "complete", relationshipMethod: "api" });
  assert.deepEqual(capture.longText, {
    plaintext: "長文全文",
    linkAttachmentUrl: "https://example.test/article",
    stylingInfo: [{ offset: 0, length: 2, style: "bold" }]
  });
});

test("引用貼文同時保留 legacy 與標準化形狀", () => {
  const capture = M.normalizeCapture(rawPost({
    quotedPosts: [{ sourceUrl: "https://www.threads.com/@quoted/post/QUOTE1" }]
  }), { sourceType: "page", completeness: "partial" });
  assert.equal(capture.quotedPosts[0].postId, "QUOTE1");
  assert.deepEqual(capture.quotes, [{
    mediaId: "",
    shortcode: "QUOTE1",
    canonicalUrl: "https://www.threads.com/@quoted/post/QUOTE1"
  }]);
});

test("page normalization 保留既有核心欄位語意", () => {
  const capture = M.normalizeCapture(rawPost({
    topicTag: "生活筆記",
    titleHint: "fixture",
    longTextAttachments: [{ text: "附件正文", title: "長文附件" }]
  }), { sourceType: "page", completeness: "partial" });
  assert.deepEqual({
    captureType: capture.captureType,
    text: capture.text,
    sourceUrl: capture.sourceUrl,
    author: capture.author,
    publishedAt: capture.publishedAt,
    topicTag: capture.topicTag,
    titleHint: capture.titleHint,
    longTextAttachments: capture.longTextAttachments
  }, {
    captureType: "post",
    text: "標準化正文",
    sourceUrl: "https://www.threads.com/@Example/post/ABC123",
    author: "example",
    publishedAt: "2026-09-01T01:02:03.000Z",
    topicTag: "生活筆記",
    titleHint: "fixture",
    longTextAttachments: [{ text: "附件正文", title: "長文附件" }]
  });
});

test("標準化 capture 會保留安全的連結與預覽卡片", () => {
  const capture = M.normalizeCapture(rawPost({
    links: [{ text: "a.test/x…", url: "https://l.threads.com/?u=https%3A%2F%2Fa.test%2Fx" }, { text: "壞", url: "javascript:alert(1)" }],
    linkCards: [{ url: "https://b.test/story", text: "B" }]
  }));
  assert.deepEqual(capture.links, [{ text: "a.test/x…", url: "https://a.test/x" }]);
  assert.deepEqual(capture.linkCards, [{ text: "B", url: "https://b.test/story" }]);
});
