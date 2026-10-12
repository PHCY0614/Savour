"use strict";

// Pins what saving a text selection produces on each kind of page, through the same entry points the
// extension uses: the content scripts' message listeners, and the Plurk capture factory.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installDom } = require("./helpers/dom-env");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "dom", `${name}.html`), "utf8");
const env = installDom("<!doctype html><html><head><title>test</title></head><body></body></html>");
const S = require("../lib/shared.js");

// ---- Loading the content scripts ----

const GLOBALS = {
  SavourShared: S,
  SavourToast: { showToast() {} },
  SavourSelectionCapture: require("../content/selection-capture.js"),
  SavourWebArticle: require("../content/web-article.js"),
  SavourXCapture: require("../content/x-capture.js"),
  SavourYouTubeCapture: require("../content/youtube-capture.js"),
  SavourLinkedInCapture: require("../content/linkedin-capture.js"),
  SavourFacebookCapture: require("../content/facebook-capture.js"),
  SavourInstagramCapture: require("../content/instagram-capture.js"),
  Readability: require("../vendor/readability/Readability.js")
};
Object.assign(globalThis, GLOBALS);

// Each content script registers one message listener when it loads.
function loadListener(file) {
  require(file);
  return globalThis.chrome.__listeners.at(-1);
}
const webListener = loadListener("../content/web-content.js");
const instagramListener = loadListener("../content/instagram-content.js");
const threads = require("../content/threads-content.js");
const { createPlurkCapture } = require("../content/plurk-capture.js");

test.after(() => {
  threads.disposeForTests();
  env.restore();
  for (const name of Object.keys(GLOBALS)) delete globalThis[name];
  delete globalThis.__savourWebContentAlive;
});

// ---- Helpers ----

function ask(listener, selectionText = "") {
  return new Promise(resolve => listener({ type: "CAPTURE_SELECTION", selectionText }, {}, resolve));
}

function openPage(html, url) {
  env.dom.reconfigure({ url });
  document.open();
  document.write(html);
  document.close();
  window.getSelection().removeAllRanges();
}

// Selects everything inside the element. `textOnly` selects just its first text node, which leaves the
// element itself (a link, say) outside the selected range; `before` ends the selection ahead of a child.
function select(selector, { textOnly = false, before = "" } = {}) {
  const element = document.querySelector(selector);
  const range = document.createRange();
  range.selectNodeContents(textOnly ? element.firstChild : element);
  if (before) range.setEndBefore(element.querySelector(before));
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

const ARTICLE = `<!doctype html><html><head><title>文章標題</title></head><body>
  <p id="para">第一行 <a id="link" href="https://example.test/a?utm_source=feed">連結文字</a> 結尾</p>
</body></html>`;
const ARTICLE_LINK = { text: "連結文字", url: "https://example.test/a?utm_source=feed" };

// ---- Ordinary web pages and X (content/web-content.js) ----

test("一般網頁：選取範圍內的文字與連結，來源是去掉追蹤參數的網址", async () => {
  openPage(ARTICLE, "https://news.example.com/story?utm_source=x#top");
  select("#para");
  assert.deepEqual(await ask(webListener), {
    ok: true,
    result: {
      platform: "web",
      captureType: "selection",
      text: "第一行 連結文字 結尾",
      sourceUrl: "https://news.example.com/story",
      author: "",
      publishedAt: "",
      links: [ARTICLE_LINK],
      continuations: [],
      titleHint: "文章標題"
    }
  });
});

test("一般網頁：只選到連結裡的字時不帶連結；頁面沒有選取時改用右鍵選單的文字", async () => {
  openPage(ARTICLE, "https://news.example.com/story");
  select("#link", { textOnly: true });
  const inLink = (await ask(webListener)).result;
  assert.equal(inLink.text, "連結文字");
  assert.deepEqual(inLink.links, []);

  window.getSelection().removeAllRanges();
  const fromMenu = (await ask(webListener, "  右鍵  文字 ")).result;
  assert.equal(fromMenu.text, "右鍵  文字");
  assert.deepEqual(fromMenu.links, []);
  assert.deepEqual(await ask(webListener, "   "), { ok: false, error: "請先選取想保存的文字" });
});

test("X：平台記為 x，作者取自網址", async () => {
  openPage(ARTICLE, "https://twitter.com/Sample/status/20?s=20");
  select("#para");
  assert.deepEqual((await ask(webListener)).result, {
    platform: "x",
    captureType: "selection",
    text: "第一行 連結文字 結尾",
    sourceUrl: "https://x.com/sample/status/20",
    author: "sample",
    publishedAt: "",
    links: [ARTICLE_LINK],
    continuations: [],
    titleHint: "文章標題"
  });
});

// ---- Instagram (content/instagram-content.js) ----

test("Instagram：平台記為 instagram，不填作者；只選到連結裡的字時不帶連結", async () => {
  openPage(ARTICLE, "https://www.instagram.com/p/Abc123Post1/?igsh=x");
  select("#para");
  assert.deepEqual((await ask(instagramListener)).result, {
    platform: "instagram",
    captureType: "selection",
    text: "第一行 連結文字 結尾",
    sourceUrl: "https://www.instagram.com/p/Abc123Post1/",
    author: "",
    publishedAt: "",
    links: [ARTICLE_LINK],
    continuations: [],
    titleHint: "文章標題"
  });

  select("#link", { textOnly: true });
  assert.deepEqual((await ask(instagramListener)).result.links, []);
  window.getSelection().removeAllRanges();
  assert.deepEqual(await ask(instagramListener, ""), { ok: false, error: "請先選取想保存的文字" });
});

// ---- Plurk (content/plurk-capture.js) ----

test("噗浪：單篇頁面帶噗主帳號；河道等其他頁面不填作者", () => {
  const plurk = createPlurkCapture({ shared: S, readPaste: async () => null });
  openPage(fixture("plurk-post"), "https://www.plurk.com/p/3abc0test1");
  select("#permanent-plurk .text_holder", { before: "span.hashtag" });
  assert.deepEqual(plurk.captureSelection(""), {
    platform: "plurk",
    captureType: "selection",
    text: "一萬字，預估閱讀時間三十分鐘第二段，粗體重點長文的第一句話 (Plurk Paste)參考：https://example.test/...新聞標題",
    sourceUrl: "https://www.plurk.com/p/3abc0test1",
    author: "tester",
    publishedAt: "",
    links: [
      { text: "長文的第一句話 (Plurk Paste)", url: "https://paste.plurk.com/show/AbCdEf123456/" },
      { text: "", url: "https://images.plurk.com/SamplePhotoAaaaaaaaaa1.jpg" },
      { text: "https://example.test/...", url: "https://example.test/articles/very-long-path?ref=plurk" },
      { text: "新聞標題", url: "https://news.example.test/story" }
    ],
    continuations: [],
    titleHint: "測試噗主 - 測試噗文 - Plurk"
  });

  select("#permanent-plurk .text_holder a.plurkpaste", { textOnly: true });
  assert.deepEqual(plurk.captureSelection("").links, []);

  openPage(ARTICLE, "https://www.plurk.com/tester");
  select("#para");
  const timeline = plurk.captureSelection("");
  assert.equal(timeline.author, "");
  assert.equal(timeline.sourceUrl, "https://www.plurk.com/tester");
  assert.throws(() => (window.getSelection().removeAllRanges(), plurk.captureSelection(" ")), /請先選取想保存的文字/);
});

// ---- Threads (content/page-capture.js) ----

test("Threads：作者、網址與時間取自選取所在的貼文，而且不寫 platform 欄位", () => {
  openPage(fixture("link-post"), "https://www.threads.com/@sample/post/link001");
  select("#link-post div[dir=auto]");
  assert.deepEqual(threads.captureSelection(""), {
    captureType: "selection",
    text: "推薦這篇 blog.example.test/posts/long-a…，感謝 @friend 分享",
    links: [{ text: "blog.example.test/posts/long-a…", url: "https://blog.example.test/posts/long-article?ref=threads" }],
    sourceUrl: "https://www.threads.com/@sample/post/link001",
    author: "sample",
    publishedAt: "2026-09-02T01:02:03.000Z",
    continuations: [],
    titleHint: "含連結貼文 fixture"
  });
});

test("Threads：只選到連結裡的字時，帶上包住它的連結；沒有頁面選取時作者與網址取自目前網址", () => {
  openPage(fixture("link-post"), "https://www.threads.com/@sample/post/link001");
  select("#link-post div[dir=auto] a", { textOnly: true });
  const inLink = threads.captureSelection("");
  assert.equal(inLink.text, "blog.example.test/posts/long-a…");
  assert.deepEqual(inLink.links, [
    { text: "blog.example.test/posts/long-a…", url: "https://blog.example.test/posts/long-article?ref=threads" }
  ]);

  window.getSelection().removeAllRanges();
  assert.deepEqual(threads.captureSelection(" 右鍵 "), {
    captureType: "selection",
    text: "右鍵",
    links: [],
    sourceUrl: "https://www.threads.com/@sample/post/link001",
    author: "sample",
    publishedAt: "",
    continuations: [],
    titleHint: "含連結貼文 fixture"
  });
  assert.throws(() => threads.captureSelection("   "), /請先選取想保存的文字/);
});
