"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installDom } = require("./helpers/dom-env");
const S = require("../lib/shared.js");
const M = require("../model/capture-model.js");
const AB = require("../model/article-blocks.js");
const N = require("../notion/index.js");
const Readability = require("../vendor/readability/Readability.js");
const { createWebArticleCapture } = require("../content/web-article.js");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "dom", `${name}.html`), "utf8");
const NEWS_URL = "https://www.example-news.tw/news/20261005/typhoon?utm_source=line&fbclid=abc#top";

function captureArticle(html = fixture("news-article"), url = NEWS_URL) {
  const env = installDom(html, { url });
  try {
    return createWebArticleCapture({ shared: S, Readability }).captureArticle();
  } finally {
    env.restore();
  }
}

const spansText = block => (block.spans ?? []).map(span => span.text).join("");

test("新聞文章：讀取標題、網站、作者、發布時間，網址去掉追蹤參數", () => {
  const result = captureArticle();
  assert.equal(result.platform, "web");
  assert.equal(result.sourceUrl, "https://www.example-news.tw/news/20261005/typhoon");
  assert.equal(result.title, "颱風路徑北修 週三起雨勢增強");
  assert.equal(result.siteName, "範例新聞網");
  assert.equal(result.author, "林記者");
  assert.equal(result.publishedAt, "2026-10-05T08:30:00+08:00");
  assert.match(result.excerpt, /路徑較昨日預報北修/);
  assert.deepEqual(result.captureValidation, { version: 2, source: "web-page", postId: "", validated: true });
});

test("新聞文章：只保留正文，保留段落、粗體、連結、標題、清單、引言、表格、程式碼與圖片", () => {
  const { articleBlocks: blocks } = captureArticle();
  const types = blocks.map(block => block.type);
  const all = JSON.stringify(blocks);
  // Navigation, related news and the footer are not part of the article.
  for (const outside of ["首頁", "熱門新聞", "別的新聞一", "版權所有"]) assert.equal(all.includes(outside), false, outside);
  // The headline is the page title, so it is not repeated as the first heading.
  assert.equal(blocks.some(block => block.type === "heading" && spansText(block) === "颱風路徑北修 週三起雨勢增強"), false);
  assert.ok(types.includes("heading"));
  assert.equal(spansText(blocks.find(block => block.type === "heading")), "各地停班停課");

  const image = blocks.find(block => block.type === "image");
  assert.equal(image.url, "https://www.example-news.tw/2026/10/typhoon-map.jpg");
  assert.equal(image.caption.map(span => span.text).join(""), "氣象署最新的颱風路徑預測圖。");
  assert.ok(image.caption.some(span => span.bold && span.text === "颱風路徑"));
  assert.equal(all.includes("pixel.gif"), false);

  const lead = blocks.find(block => spansText(block).startsWith("氣象署今（5）日"));
  assert.ok(lead.spans.some(span => span.bold && span.text === "明顯北修"));
  assert.ok(lead.spans.some(span => span.href?.startsWith("https://www.cwa.gov.tw/") && span.text === "氣象署颱風消息"));

  assert.deepEqual(blocks.filter(block => block.type === "bulleted").map(spansText).map(text => text.trim()), [
    "台北市：今晚八點宣布",
    "新北市：今晚八點宣布",
    "山區學校另行公告"
  ]);
  assert.equal(spansText(blocks.find(block => block.type === "quote")), "「這次的雨量可能是今年最大的一次。」\n預報中心主任表示。");
  const table = blocks.find(block => block.type === "table");
  assert.equal(table.header, true);
  assert.deepEqual(table.rows.map(row => row.map(cell => cell.map(span => span.text).join(""))), [
    ["地區", "預估雨量"],
    ["宜蘭山區", "500 毫米"],
    ["台北山區", "350 毫米"]
  ]);
  assert.equal(blocks.find(block => block.type === "code").text, "curl https://opendata.example.tw/rain?area=taipei\n# 每小時更新");
});

test("讀不到文章的頁面只保存標題、簡介與代表圖，並標記正文疑似遺漏", () => {
  const html = `<!doctype html><html><head><title>工具首頁</title>
    <meta property="og:description" content="一個線上工具的介紹。">
    <meta property="og:image" content="/cover.png"></head>
    <body><nav><a href="/">首頁</a></nav><button>開始使用</button></body></html>`;
  const result = captureArticle(html, "https://tool.example.com/app");
  assert.equal(result.articleBlocks, undefined);
  assert.equal(result.text, "一個線上工具的介紹。");
  assert.deepEqual(result.media, [{ type: "image", url: "https://tool.example.com/cover.png" }]);
  assert.deepEqual(result.reviewFlags, ["正文疑似遺漏"]);
  const capture = M.normalizeCapture(result, { sourceType: "page" });
  const payload = N.createPagePayload(capture, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.properties[N.PROPERTY_NAMES.title].title[0].text.content, "工具首頁");
  assert.ok(payload.children.some(block => block.type === "bookmark" && block.bookmark.url === "https://tool.example.com/app"));
  assert.equal(payload.properties["待檢查項目"], undefined);
});

test("完全沒有內容的頁面會取消保存並建議改用反白文字", () => {
  assert.throws(
    () => captureArticle("<!doctype html><html><head><title></title></head><body><div></div></body></html>", "https://empty.example.com/"),
    /反白文字/
  );
});

test("網頁擷取通過驗證，以網頁來源、完整標題、作者與 web: 去重鍵寫入 Notion", () => {
  const capture = M.normalizeCapture(captureArticle(), { sourceType: "page" });
  assert.equal(capture.dedupeKey, "web:https://www.example-news.tw/news/20261005/typhoon");
  assert.equal(capture.media.length, 1);
  const payload = N.createPagePayload(capture, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  const properties = payload.properties;
  assert.equal(properties[N.PROPERTY_NAMES.platform].select.name, "網頁");
  assert.equal(properties[N.PROPERTY_NAMES.title].title[0].text.content, "颱風路徑北修 週三起雨勢增強");
  assert.equal(properties[N.PROPERTY_NAMES.author].rich_text[0].text.content, "林記者");
  assert.equal(properties[N.PROPERTY_NAMES.postId], undefined);
  assert.equal(properties[N.PROPERTY_NAMES.publishedAt].date.start, "2026-10-05T00:30:00.000Z");

  const types = payload.children.map(block => block.type);
  for (const type of ["paragraph", "heading_2", "bulleted_list_item", "quote", "table", "code"]) assert.ok(types.includes(type), type);
  // Images appear once prepareCaptureMedia has uploaded them or marked them external (next test).
  assert.equal(types.includes("image"), false);
  const lead = payload.children.find(block => block.type === "paragraph" && block.paragraph.rich_text[0].text.content.startsWith("氣象署今"));
  assert.ok(lead.paragraph.rich_text.some(item => item.annotations?.bold && item.text.content === "明顯北修"));
  assert.ok(lead.paragraph.rich_text.some(item => item.text.link?.url.startsWith("https://www.cwa.gov.tw/")));
  const table = payload.children.find(block => block.type === "table");
  assert.equal(table.table.table_width, 2);
  assert.equal(table.table.has_column_header, true);
  assert.equal(table.table.children.length, 3);
  assert.equal(payload.children.find(block => block.type === "code").code.language, "plain text");
});

test("圖片：上傳成功用 Notion 檔案，無法複製時改連到原圖並保留說明文字", () => {
  const capture = M.normalizeCapture(captureArticle(), { sourceType: "page" });
  const uploaded = structuredClone(capture);
  uploaded.media[0].notionFileId = "file-1";
  const uploadedImage = N.buildPageChildren(uploaded).find(block => block.type === "image");
  assert.deepEqual(uploadedImage.image.file_upload, { id: "file-1" });
  assert.equal(uploadedImage.image.caption.map(item => item.text.content).join(""), "氣象署最新的颱風路徑預測圖。");

  const linked = structuredClone(capture);
  linked.media[0].external = true;
  const linkedImage = N.buildPageChildren(linked).find(block => block.type === "image");
  assert.deepEqual(linkedImage.image.external, { url: "https://www.example-news.tw/2026/10/typhoon-map.jpg" });
});

test("文章區塊清理：移除不安全連結、未知類型與多餘分隔線，並限制圖片數量", () => {
  const { blocks, media } = AB.sanitizeArticleBlocks([
    { type: "divider" },
    { type: "paragraph", spans: [{ text: "  前面空白 " }, { text: "點我", href: "javascript:alert(1)" }, { text: " 正常", href: "https://ok.example/" }] },
    { type: "script", text: "alert(1)" },
    { type: "heading", level: 9, spans: [{ text: "標題" }] },
    { type: "image", url: "data:image/png;base64,AAAA" },
    { type: "image", url: "https://img.example/a.jpg", caption: [{ text: "A" }] },
    { type: "image", url: "https://img.example/a.jpg" },
    { type: "table", rows: [[[{ text: "只有一欄" }]]] },
    { type: "video", url: "https://www.youtube.com/embed/Sample67890" },
    { type: "divider" },
    { type: "divider" }
  ]);
  assert.deepEqual(blocks.map(block => block.type), ["paragraph", "heading", "image", "image", "paragraph", "video"]);
  assert.deepEqual(blocks[0].spans, [{ text: "前面空白 點我" }, { text: " 正常", href: "https://ok.example/" }]);
  assert.equal(blocks[1].level, 3);
  assert.equal(blocks[2].media, 0);
  assert.equal(blocks[3].media, 0);
  assert.deepEqual(media.map(item => item.url), ["https://img.example/a.jpg"]);

  const many = AB.sanitizeArticleBlocks(Array.from({ length: AB.MAX_IMAGES + 5 }, (_, index) => ({ type: "image", url: `https://img.example/${index}.jpg` })));
  assert.equal(many.media.length, AB.MAX_IMAGES);
  assert.equal(many.blocks.length, AB.MAX_IMAGES + 5);
  assert.equal(many.blocks.at(-1).media, undefined);
});

test("影片轉成 Notion 可播放的網址，其他嵌入改成書籤；長段落拆成多個區塊", () => {
  const capture = M.normalizeCapture({
    platform: "web",
    captureType: "post",
    sourceUrl: "https://blog.example.com/post",
    title: "影片文章",
    captureValidation: { version: 2, source: "web-page", validated: true },
    articleBlocks: [
      { type: "video", url: "https://www.youtube-nocookie.com/embed/Sample67890?rel=0" },
      { type: "video", url: "https://player.vimeo.com/video/123456789" },
      { type: "video", url: "https://media.example.com/clip" },
      { type: "paragraph", spans: Array.from({ length: 150 }, (_, index) => ({ text: `第${index}段`, bold: index % 2 === 0 })) }
    ]
  }, { sourceType: "page" });
  const children = N.buildPageChildren(capture);
  assert.deepEqual(children.slice(0, 3).map(block => block.video?.external.url ?? block.bookmark?.url), [
    "https://www.youtube.com/watch?v=Sample67890",
    "https://vimeo.com/123456789",
    "https://media.example.com/clip"
  ]);
  const paragraphs = children.filter(block => block.type === "paragraph");
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].paragraph.rich_text.length, 100);
  assert.equal(paragraphs[1].paragraph.rich_text.length, 50);
});

test("網頁擷取驗證拒絕沒有來源驗證、或夾帶串文的資料", () => {
  const raw = captureArticle();
  assert.throws(() => M.normalizeCapture({ ...raw, captureValidation: {} }), /網頁內容沒有通過來源驗證/);
  assert.throws(() => M.normalizeCapture({
    ...raw,
    authorReplies: [{ text: "x", sourceUrl: "https://www.example-news.tw/other" }]
  }), /網頁不應包含串文或回覆/);
});

test("注入的頁面程式會回應 PING、保存文章與選取文字，重複注入不會多一個監聽器", async () => {
  const { createChromeStub } = require("./helpers/dom-env");
  const chrome = createChromeStub();
  chrome.runtime.id = "extension-id";
  const env = installDom(fixture("news-article"), { url: NEWS_URL, chrome });
  const globals = {
    SavourShared: S,
    SavourToast: require("../content/toast.js"),
    SavourWebArticle: require("../content/web-article.js"),
    SavourXCapture: require("../content/x-capture.js"),
    SavourYouTubeCapture: require("../content/youtube-capture.js"),
    SavourLinkedInCapture: require("../content/linkedin-capture.js"),
    SavourFacebookCapture: require("../content/facebook-capture.js"),
    Readability
  };
  Object.assign(globalThis, globals);
  const source = fs.readFileSync(path.join(__dirname, "..", "content", "web-content.js"), "utf8");
  try {
    vm.runInThisContext(source, { filename: "content/web-content.js" });
    vm.runInThisContext(source, { filename: "content/web-content.js" });
    assert.equal(chrome.__listeners.length, 1);
    // A copy left over from before an extension reload no longer reaches the extension; it is replaced.
    delete chrome.runtime.id;
    vm.runInThisContext(source, { filename: "content/web-content.js" });
    assert.equal(chrome.__listeners.length, 2);
    chrome.runtime.id = "extension-id";
    const send = message => new Promise(resolve => chrome.__listeners[0](message, {}, resolve));
    assert.deepEqual(await send({ type: "PING" }), { ok: true, result: { ready: true } });
    const page = await send({ type: "CAPTURE_CURRENT_THREAD" });
    assert.equal(page.ok, true);
    assert.equal(page.result.title, "颱風路徑北修 週三起雨勢增強");
    document.getSelection().selectAllChildren(document.querySelector("article p"));
    const selection = await send({ type: "CAPTURE_SELECTION" });
    assert.equal(selection.result.platform, "web");
    assert.equal(selection.result.captureType, "selection");
    assert.match(selection.result.text, /^氣象署今/);
  } finally {
    for (const name of [...Object.keys(globals), "__savourWebContentAlive"]) delete globalThis[name];
    env.restore();
  }
});

test("分批寫入：每批最多 100 個區塊，且表格的列數計入批次大小", () => {
  const table = { type: "table", table: { children: Array.from({ length: 100 }, () => ({ type: "table_row" })) } };
  const paragraph = { type: "paragraph", paragraph: { rich_text: [] } };
  assert.deepEqual(N.chunkBlocks(Array.from({ length: 250 }, () => paragraph)).map(chunk => chunk.length), [100, 100, 50]);
  assert.deepEqual(N.chunkBlocks(Array.from({ length: 10 }, () => table)).map(chunk => chunk.length), [7, 3]);
});

test("超過上傳數量、只連結原圖的圖片，也不會連到本機或區域網路", () => {
  const blocks = Array.from({ length: AB.MAX_IMAGES }, (_, index) => ({ type: "image", url: `https://img.example/${index}.jpg` }));
  blocks.push({ type: "image", url: "http://192.168.0.10/camera.jpg" }, { type: "image", url: "https://img.example/extra.jpg" });
  const capture = M.normalizeCapture({
    platform: "web",
    captureType: "post",
    sourceUrl: "https://blog.example.com/many-images",
    title: "很多圖片",
    captureValidation: { version: 2, source: "web-page", validated: true },
    articleBlocks: blocks
  }, { sourceType: "page" });
  const external = N.buildPageChildren(capture)
    .filter(block => block.type === "image" && block.image.type === "external")
    .map(block => block.image.external.url);
  assert.deepEqual(external, ["https://img.example/extra.jpg"]);
});
