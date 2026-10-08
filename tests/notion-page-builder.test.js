"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const shared = require("../lib/shared.js");
const schema = require("../notion/schema.js");
const notion = require("../notion/index.js");
const { createNotionPageBuilder } = require("../notion/page-builder.js");

function fixtureCapture(overrides = {}) {
  return {
    captureType: "post",
    text: "主貼文內容",
    author: "example",
    sourceUrl: "https://www.threads.com/@example/post/ABC123",
    savedAt: "2026-09-20T00:00:00.000Z",
    dedupeKey: "tsc:ABC123",
    shortcode: "ABC123",
    topicTag: "測試",
    reviewFlags: ["需複核"],
    continuations: [{ text: "作者續文", threadPosition: "2/2", reviewFlags: [] }],
    authorReplies: [],
    longTextAttachments: [],
    media: [],
    quotedPosts: [],
    ...overrides
  };
}

test("page builder 模組維持 facade 的輸出契約與結果", () => {
  const pageBuilder = createNotionPageBuilder({
    shared,
    schema,
    columns: () => schema.defaultColumnMap()
  });
  assert.deepEqual(Object.keys(pageBuilder).sort(), [
    "blocksPlainText",
    "buildContinuationBlocks",
    "buildPageChildren",
    "buildSelectionAppendBlocks",
    "captureTitleText",
    "chunkBlocks",
    "contentRangeFromPage",
    "contentRangePayload",
    "createPagePayload",
    "previousVersionNoticeBlocks",
    "refreshPagePropertiesPayload",
    "savedThreadPositions",
    "updatePagePayload"
  ]);

  const capture = fixtureCapture();
  assert.deepEqual(pageBuilder.buildPageChildren(capture), notion.buildPageChildren(capture));
  assert.deepEqual(pageBuilder.createPagePayload(capture, "data-source"), notion.createPagePayload(capture, "data-source"));
  assert.deepEqual(pageBuilder.updatePagePayload(capture), notion.updatePagePayload(capture));
});

test("瀏覽器載入順序會建立完整 Notion facade", () => {
  const context = { console, Intl };
  for (const file of ["lib/shared.js", "notion/schema.js", "notion/page-builder.js", "notion/index.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    vm.runInNewContext(source, context, { filename: file });
  }

  assert.equal(typeof context.SavourNotionPageBuilder?.createNotionPageBuilder, "function");
  assert.equal(typeof context.SavourNotion?.createPagePayload, "function");
  assert.equal(typeof context.SavourNotion?.savedRecordFromPage, "function");
  assert.equal(context.SavourNotion.captureTitleText(fixtureCapture()), "主貼文內容");
});

function paragraphs(payload) {
  return payload.children.filter(block => block.type === "paragraph").map(block => block.paragraph.rich_text);
}

test("內文連結以原本顯示文字寫入並可點擊到完整網址", () => {
  const payload = notion.createPagePayload(fixtureCapture({
    text: "推薦這篇 blog.example.test/posts/long-a…，很好看",
    continuations: [],
    links: [{ text: "blog.example.test/posts/long-a…", url: "https://blog.example.test/posts/long-article" }]
  }), "data-source");
  const [richText] = paragraphs(payload);
  assert.deepEqual(richText.map(item => item.text.content), ["推薦這篇 ", "blog.example.test/posts/long-a…", "，很好看"]);
  assert.equal(richText[1].text.link.url, "https://blog.example.test/posts/long-article");
  assert.equal(richText[0].text.link, undefined);
});

test("正文與長文中直接打出的完整網址會自動變成連結，句尾標點不算在網址內", () => {
  const payload = notion.createPagePayload(fixtureCapture({
    text: "原文 https://example.test/a?b=1。",
    continuations: [],
    longTextAttachments: [{ text: "延伸閱讀：https://www.threads.com/@example/post/XYZ789" }]
  }), "data-source");
  const [main, longText] = paragraphs(payload);
  assert.equal(main[1].text.content, "https://example.test/a?b=1");
  assert.equal(main[1].text.link.url, "https://example.test/a?b=1");
  assert.equal(main[2].text.content, "。");
  assert.equal(longText[1].text.link.url, "https://www.threads.com/@example/post/XYZ789");
});

test("連結預覽卡片寫成 Notion 書籤，不安全網址會被略過", () => {
  const payload = notion.createPagePayload(fixtureCapture({
    continuations: [{
      text: "續文",
      threadPosition: "2/2",
      linkCards: [{ url: "https://news.example.test/story", text: "新聞" }, { url: "javascript:alert(1)" }]
    }]
  }), "data-source");
  const bookmarks = payload.children.filter(block => block.type === "bookmark");
  assert.deepEqual(bookmarks.map(block => block.bookmark.url), ["https://news.example.test/story"]);
});

test("沒有連結的段落維持單一純文字", () => {
  const [richText] = paragraphs(notion.createPagePayload(fixtureCapture({ continuations: [] }), "data-source"));
  assert.deepEqual(richText, [{ type: "text", text: { content: "主貼文內容" } }]);
});

test("同一段連結太多時退回純文字，避免超過 Notion 單段 100 個片段的限制", () => {
  const text = Array.from({ length: 60 }, (_, index) => `https://example.test/${index}`).join(" ");
  const [richText] = paragraphs(notion.createPagePayload(fixtureCapture({ text, continuations: [] }), "data-source"));
  assert.equal(richText.length, 1);
  assert.equal(richText[0].text.link, undefined);
});

test("串文序號結尾是連結時，序號另起一段且不會被包進連結", () => {
  const payload = notion.createPagePayload(fixtureCapture({
    text: "看這篇 https://example.test/a",
    threadPosition: "1/2",
    continuations: []
  }), "data-source");
  const [richText] = paragraphs(payload);
  assert.equal(richText.at(-2).text.link.url, "https://example.test/a");
  assert.deepEqual(richText.at(-1), { type: "text", text: { content: "\n1/2" } });
});

test("可從既有頁面讀回已保存的串文序號，追加段落以分隔線開頭", () => {
  const blocks = [
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "第一段\n1/3" }] } },
    { type: "divider", divider: {} },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "我的筆記 2/3 不算" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "第二段" }, { plain_text: "\n2/3" }] } }
  ];
  assert.deepEqual([...notion.savedThreadPositions(blocks)].sort(), [1, 2]);
  const appended = notion.buildContinuationBlocks([{ text: "第三段", threadPosition: "3/3" }]);
  assert.deepEqual(appended.slice(0, 3).map(block => block.type), ["paragraph", "divider", "paragraph"]);
  assert.equal(appended.at(-1).paragraph.rich_text[0].text.content, "第三段\n3/3");
});

test("選取文字存成新頁面時直接放內文，不加「擷取內容」標題", () => {
  const children = notion.buildPageChildren(fixtureCapture({
    captureType: "selection",
    text: "選取的第一段\n\n選取的第二段",
    continuations: []
  }));
  const headings = children.filter(block => /^heading_/.test(block.type));
  assert.equal(headings.some(block => block[block.type].rich_text[0]?.text.content === "擷取內容"), false);
  assert.equal(children[0].type, "paragraph");
  assert.equal(children[0].paragraph.rich_text[0].text.content, "選取的第一段");
});

test("工具寫進 Notion 的固定文字跟著介面語言", () => {
  const I = require("../i18n/index.js");
  const empty = fixtureCapture({
    text: "",
    continuations: [],
    mediaDiagnostics: { warnings: ["圖片 1 未能保存"] }
  });
  const texts = () => notion.buildPageChildren(empty).map(block => block[block.type]?.rich_text?.[0]?.text?.content).filter(Boolean);
  try {
    assert.ok(texts().includes("此貼文沒有可擷取的內容。"));
    assert.ok(texts().includes("擷取提醒"));
    assert.equal(schema.createArchivePayload("", "parent").description[0].text.content, "保存你感興趣、想收藏，等之後慢慢消化的文字。");
    I.setLanguage("en");
    assert.ok(texts().includes("This post has no content that could be captured."));
    assert.ok(texts().includes("Capture notes"));
    assert.equal(schema.createArchivePayload("", "parent").description[0].text.content, "Things you find interesting and want to keep, saved to digest slowly later.");
    assert.equal(shared.buildTitle("", ""), "Post without text");
  } finally {
    I.setLanguage("zh");
  }
});
