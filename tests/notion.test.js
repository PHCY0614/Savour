"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../notion/index.js");

const capture = {
  captureType: "post",
  text: "這是主貼文",
  sourceUrl: "https://www.threads.com/@example/post/POST123",
  author: "example",
  publishedAt: "2026-08-20T10:00:00.000Z",
  savedAt: "2026-08-23T10:00:00.000Z",
  dedupeKey: "post:https://www.threads.com/@example/post/POST123",
  topicTag: "生活筆記",
  threadPosition: "1/2",
  reviewFlags: ["串文未完整"],
  media: [{
    url: "https://example.com/main.jpg",
    alt: "主貼文圖片",
    notionFileId: "11111111-2222-3333-4444-555555555555"
  }],
  mediaUploadSummary: { detected: 1, uploaded: 1, failed: 0 },
  continuations: [{
    text: "這是作者後續",
    sourceUrl: "https://www.threads.com/@example/post/REPLY456",
    publishedAt: "2026-08-20T10:02:00.000Z",
    topicTag: "問答",
    threadPosition: "2/2",
    reviewFlags: [],
    longTextAttachments: [{ text: "後續長文附件內容".repeat(150) }],
  }],
  authorReplies: [{
    text: "沒有編號的延伸內容",
    sourceUrl: "https://www.threads.com/@example/post/REPLY789",
    publishedAt: "2026-08-20T10:03:00.000Z",
    threadPosition: "",
    reviewFlags: [],
    quotedPosts: [{
      postId: "QUOTED123",
      sourceUrl: "https://www.threads.com/@quoted/post/QUOTED123/media?xmt=test"
    }, {
      postId: "QUOTED123",
      sourceUrl: "https://www.threads.com/@quoted/post/QUOTED123"
    }],
    longTextAttachments: []
  }],
  longTextAttachments: [{ text: "主貼文長文附件內容".repeat(220) }]
};

test("建立新的獨立整理庫結構", () => {
  const payload = N.createArchivePayload("我的 Threads", "12345678-90ab-cdef-1234-567890abcdef");
  assert.equal(payload.parent.type, "page_id");
  assert.equal(payload.title[0].text.content, "我的 Threads");
  assert.ok(payload.initial_data_source.properties[N.PROPERTY_NAMES.captureKey]);
  assert.equal(payload.initial_data_source.properties["已核對"], undefined);
  assert.equal(payload.initial_data_source.properties["待檢查項目"], undefined);
  assert.ok(payload.initial_data_source.properties[N.PROPERTY_NAMES.topicTag]);
  // 整理狀態 handed pages to a separate AI analysis tool that is no longer used.
  assert.equal(payload.initial_data_source.properties[N.PROPERTY_NAMES.processingStatus], undefined);
  for (const name of ["AI 標題", "AI 主題", "AI 關鍵字", "AI 摘要", "AI 分析版本"]) {
    assert.equal(payload.initial_data_source.properties[name], undefined);
  }
});

test("貼文頁面包含來源、去重鍵與作者後續", () => {
  const payload = N.createPagePayload(capture, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.parent.type, "data_source_id");
  assert.equal(payload.properties[N.PROPERTY_NAMES.author].rich_text[0].text.content, "example");
  assert.equal(payload.properties[N.PROPERTY_NAMES.continuationCount], undefined);
  assert.equal(payload.properties[N.PROPERTY_NAMES.captureType], undefined);
  assert.equal(payload.properties[N.PROPERTY_NAMES.postId].rich_text[0].text.content, "POST123");
  assert.equal(payload.properties[N.PROPERTY_NAMES.topicTag].select.name, "生活筆記");
  assert.equal(payload.properties[N.PROPERTY_NAMES.processingStatus], undefined);
  assert.equal(payload.properties["待檢查項目"], undefined);
  assert.equal(new URL(payload.icon.external.url).searchParams.get("domain"), "www.threads.com");
  for (const name of ["AI 標題", "AI 主題", "AI 關鍵字", "AI 摘要", "AI 分析版本"]) {
    assert.equal(payload.properties[name], undefined);
  }
  assert.ok(payload.properties[N.PROPERTY_NAMES.title].title[0].text.content.length <= 30);
  assert.doesNotMatch(payload.properties[N.PROPERTY_NAMES.title].title[0].text.content, /^2026-08-20/);
  assert.equal(payload.children.some(block => block.type === "heading_2" && block.heading_2.rich_text[0].text.content === "作者後續 1"), false);
  assert.equal(payload.children.some(block => block.type === "heading_2" && block.heading_2.rich_text[0].text.content === "主貼文"), false);
  assert.equal(payload.children.filter(block => block.type === "divider").length, 2);
  assert.equal(payload.children.some(block => JSON.stringify(block).includes("讀者留言")), false);
  assert.equal(payload.children.some(block => JSON.stringify(block).includes("作者回覆")), false);
  // Long text goes straight into the page, with no heading of its own.
  assert.equal(payload.children.some(block => /^heading_/.test(block.type) && JSON.stringify(block).includes("長文附件")), false);
  assert.ok(payload.children.some(block => block.type === "paragraph" && JSON.stringify(block).includes("主貼文長文附件內容")));
  assert.ok(payload.children.some(block => block.type === "image" && block.image.type === "file_upload"));
  assert.deepEqual(payload.children.find(block => block.type === "image").image.caption, []);
  assert.equal(payload.children.some(block => /^heading_/.test(block.type) && JSON.stringify(block).includes("圖片")), false);
  assert.equal(JSON.stringify(payload.children).includes("Threads 主題："), false);
  const mainPositionBlock = payload.children.find(block => block.type === "paragraph" && block.paragraph.rich_text[0]?.text.content.endsWith("\n1/2"));
  const continuationPositionBlock = payload.children.find(block => block.type === "paragraph" && block.paragraph.rich_text[0]?.text.content.endsWith("\n2/2"));
  assert.ok(mainPositionBlock);
  assert.ok(continuationPositionBlock);
  assert.match(mainPositionBlock.paragraph.rich_text[0].text.content, /^主貼文長文附件內容/);
  assert.match(continuationPositionBlock.paragraph.rich_text[0].text.content, /^後續長文附件內容/);
  assert.equal(payload.children.some(block => block.type === "bookmark"), false);
  const quoteLinks = payload.children.flatMap(block => block.paragraph?.rich_text ?? [])
    .filter(item => item.text?.link?.url === "https://www.threads.com/@quoted/post/QUOTED123");
  assert.equal(quoteLinks.length, 1);
  assert.equal(quoteLinks[0].text.content, "https://www.threads.com/@quoted/post/QUOTED123");
  const quoteLinkIndex = payload.children.findIndex(block => block.paragraph?.rich_text?.some(item => item.text?.link?.url));
  assert.equal(payload.children[quoteLinkIndex - 1].paragraph.rich_text[0].text.content, "引用：");
  assert.equal(payload.children.some(block => /^heading_/.test(block.type) && JSON.stringify(block).includes("引用：")), false);
  assert.deepEqual(payload.children[quoteLinkIndex - 2], {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [] }
  });
  assert.equal(JSON.stringify(payload.children).includes("保存時間："), false);
  const serializedChildren = JSON.stringify(payload.children);
  assert.ok(serializedChildren.indexOf("2/2") < serializedChildren.indexOf("沒有編號的延伸內容"));
  const dividerIndex = payload.children.findIndex(block => block.type === "divider");
  assert.deepEqual(payload.children[dividerIndex - 1], {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [] }
  });
  assert.deepEqual(payload.children[dividerIndex + 1], {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [] }
  });
});

test("新文章的頁面 Icon 是來源網站的 favicon，本機位址沒有 Icon", () => {
  const icon = sourceUrl => N.createPagePayload({ ...capture, sourceUrl }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").icon;
  assert.deepEqual(icon("https://www.plurk.com/p/abc"), {
    type: "external",
    external: { url: "https://www.google.com/s2/favicons?domain=www.plurk.com&sz=128" }
  });
  assert.equal(new URL(icon("https://news.example.com/a").external.url).searchParams.get("domain"), "news.example.com");
  assert.equal(icon("http://localhost:3000/a"), undefined);
  assert.equal(icon("http://192.168.1.2/a"), undefined);
  assert.equal(icon(""), undefined);
});

test("原文空白行會形成獨立 Notion 段落", () => {
  const children = N.buildPageChildren({
    ...capture,
    text: "第一段\n\n第二段",
    threadPosition: "",
    continuations: [],
    authorReplies: [],
    longTextAttachments: [],
    media: []
  });
  const paragraphs = children.filter(block => block.type === "paragraph");
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].paragraph.rich_text[0].text.content, "第一段");
  assert.equal(paragraphs[1].paragraph.rich_text[0].text.content, "第二段");
});

test("圖片直接放入頁面且圖片貼文不顯示空內容提示", () => {
  const payload = N.createPagePayload({
    ...capture,
    text: "",
    longTextAttachments: [],
    continuations: [],
    authorReplies: [],
    media: [capture.media[0]],
    mediaUploadSummary: { detected: 1, uploaded: 1, failed: 0 }
  }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  const serialized = JSON.stringify(payload.children);
  assert.equal(payload.children.filter(block => block.type === "image").length, 1);
  assert.equal(serialized.includes("圖片"), false);
  assert.equal(serialized.includes("此貼文沒有可擷取"), false);
  assert.deepEqual(payload.children.find(block => block.type === "image").image.caption, []);
});

test("更新既有頁面時會清除舊內文並保留資料庫欄位", () => {
  const payload = N.updatePagePayload(capture);
  assert.equal(payload.erase_content, true);
  assert.equal(payload.properties[N.PROPERTY_NAMES.captureKey].rich_text[0].text.content, capture.dedupeKey);
  assert.equal(payload.properties[N.PROPERTY_NAMES.processingStatus], undefined);
  for (const name of ["AI 標題", "AI 主題", "AI 關鍵字", "AI 摘要", "AI 分析版本"]) {
    assert.equal(payload.properties[name], undefined);
  }
  assert.equal(payload.icon, undefined);
});

test("無主貼文文字時以長文附件產生短標題", () => {
  const payload = N.createPagePayload({
    ...capture,
    text: "",
    media: [],
    mediaUploadSummary: { detected: 0, uploaded: 0, failed: 0 },
    longTextAttachments: [{ text: "這是長文附件的第一段內容，用來建立資料庫中較短而且容易辨認的標題" }]
  }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  const title = payload.properties[N.PROPERTY_NAMES.title].title[0].text.content;
  assert.match(title, /^這是長文附件/);
  assert.ok(title.length <= 30);
});

test("圖片部分失敗時保留成功圖片與擷取提醒", () => {
  const payload = N.createPagePayload({
    ...capture,
    media: [
      capture.media[0],
      { url: "https://example.com/missing.jpg", alt: "失敗圖片" }
    ],
    mediaUploadSummary: { detected: 2, uploaded: 1, failed: 1 },
    mediaDiagnostics: { warnings: ["第二張圖片未能保存"] }
  }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.children.filter(block => block.type === "image").length, 1);
  assert.match(JSON.stringify(payload.children), /第二張圖片未能保存/);
});

test("超過一百個區塊時完整內容不會在建構階段被截斷", () => {
  const manyContinuations = Array.from({ length: 55 }, (_, index) => ({
    text: `作者後續 ${index}`,
    sourceUrl: `https://www.threads.com/@example/post/R${index}`,
    publishedAt: "2026-08-20T10:02:00.000Z",
    longTextAttachments: []
  }));
  const largeCapture = { ...capture, longTextAttachments: [], continuations: manyContinuations };
  const allChildren = N.buildPageChildren(largeCapture);
  const createPayload = N.createPagePayload(largeCapture, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.ok(allChildren.length > 100);
  assert.equal(createPayload.children.length, 100);
  assert.ok(allChildren.length > createPayload.children.length);
});

test("Notion 去重查詢使用完全相等", () => {
  assert.deepEqual(N.queryByCaptureKeyPayload("post:test"), {
    filter: {
      property: N.PROPERTY_NAMES.captureKey,
      rich_text: { equals: "post:test" }
    },
    page_size: 1
  });
});

test("不再提供只適用舊版欄位的查詢", () => {
  assert.equal(N.queryByThreadsMediaIdPayload, undefined);
  assert.equal(N.queryByShortcodePayload, undefined);
});

test("完整同步可從 Notion 頁面重建本機保存索引", () => {
  const record = N.savedRecordFromPage({
    id: "page-id",
    url: "https://notion.so/page-id",
    created_time: "2026-08-23T10:00:00.000Z",
    properties: {
      [N.PROPERTY_NAMES.title]: { title: [{ plain_text: "短標題" }] },
      [N.PROPERTY_NAMES.captureKey]: { rich_text: [{ plain_text: capture.dedupeKey }] },
      [N.PROPERTY_NAMES.sourceUrl]: { url: capture.sourceUrl },
      [N.PROPERTY_NAMES.author]: { rich_text: [{ plain_text: "example" }] },
      [N.PROPERTY_NAMES.captureType]: { select: { name: "主貼文" } },
      [N.PROPERTY_NAMES.savedAt]: { date: { start: capture.savedAt } },
      [N.PROPERTY_NAMES.topicTag]: { select: { name: "生活筆記" } }
    }
  });
  assert.equal(record.key, capture.dedupeKey);
  assert.equal(record.value.title, "短標題");
  assert.equal(record.value.topicTag, "生活筆記");
});

test("噗浪：內文、Paste 網址、Paste 完整內容、Paste 網址之後的剩餘內文，依這個順序排列", () => {
  const M = require("../model/capture-model.js");
  const plain = blocks => blocks.map(block => (block[block.type].rich_text ?? []).map(item => item.text.content).join(""));
  const raw = {
    platform: "plurk",
    captureType: "post",
    sourceUrl: "https://www.plurk.com/p/abc123",
    author: "writer",
    text: "前言\nhttps://paste.plurk.com/show/AbC9\n後面補充的話",
    longTextAttachments: [{ title: "Plurk Paste：長文", text: "Paste 完整內容", source: "plurk_paste" }],
    authorReplies: [{
      sourceUrl: "https://www.plurk.com/p/abc123",
      responseId: "9",
      text: "回覆開頭 https://paste.plurk.com/show/Zz1 回覆結尾",
      longTextAttachments: [{ title: "Plurk Paste：回覆", text: "回覆的 Paste", source: "plurk_paste" }]
    }],
    captureValidation: { version: 2, source: "plurk-page", postId: "abc123", validated: true }
  };
  const normalized = M.normalizeCapture(raw, { sourceType: "page" });
  assert.equal(normalized.longTextAttachments[0].source, "plurk_paste");
  const lines = plain(N.buildPageChildren(normalized)).filter(Boolean);
  assert.deepEqual(lines.slice(0, 3), ["前言\nhttps://paste.plurk.com/show/AbC9", "Paste 完整內容", "後面補充的話"]);
  assert.equal(lines.indexOf("回覆的 Paste") < lines.indexOf("回覆結尾"), true);
});

test("沒有 Paste 的內文和 Threads 的長文附件維持原本順序：全部內文在前，附件在後", () => {
  const plain = blocks => blocks.map(block => (block[block.type].rich_text ?? []).map(item => item.text.content).join("")).filter(Boolean);
  const lines = plain(N.buildPageChildren({
    captureType: "post",
    sourceUrl: "https://www.threads.com/@example/post/POST999",
    text: "正文 https://paste.plurk.com/show/AbC9 之後",
    longTextAttachments: [{ title: "長文附件", text: "附件內容" }],
    media: [],
    continuations: [],
    authorReplies: []
  }));
  assert.deepEqual(lines, ["正文 https://paste.plurk.com/show/AbC9 之後", "附件內容"]);
});

test("噗浪：Paste 連結顯示的是連結文字（不是網址）時，Paste 全文接在那個連結後面，#標籤在全文之後", () => {
  const M = require("../model/capture-model.js");
  const plain = blocks => blocks.map(block => (block[block.type].rich_text ?? []).map(item => item.text.content).join("")).filter(Boolean);
  const normalized = M.normalizeCapture({
    platform: "plurk",
    captureType: "post",
    sourceUrl: "https://www.plurk.com/p/abc123",
    author: "writer",
    text: "內文\n長文的第一句話 (Plurk Paste)\n#標籤",
    links: [{ text: "長文的第一句話 (Plurk Paste)", url: "https://paste.plurk.com/show/AbCdEf123456/" }],
    longTextAttachments: [{ title: "Plurk Paste：長文", text: "Paste 完整內容", source: "plurk_paste" }],
    captureValidation: { version: 2, source: "plurk-page", postId: "abc123", validated: true }
  }, { sourceType: "page" });
  assert.deepEqual(plain(N.buildPageChildren(normalized)).slice(0, 3), [
    "內文\n長文的第一句話 (Plurk Paste)",
    "Paste 完整內容",
    "#標籤"
  ]);
});
