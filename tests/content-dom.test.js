"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installDom } = require("./helpers/dom-env");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "dom", `${name}.html`), "utf8");
const golden = name => JSON.parse(fs.readFileSync(path.join(__dirname, "golden", `${name}.json`), "utf8"));
const env = installDom("<!doctype html><html><head><title>test</title></head><body></body></html>");
globalThis.SavourShared = require("../lib/shared.js");
const content = require("../content/threads-content.js");

test.after(() => {
  content.disposeForTests();
  env.restore();
  delete globalThis.SavourShared;
});

function load(name, url = "https://www.threads.com/@sample/post/root001") {
  env.dom.reconfigure({ url });
  document.open();
  document.write(fixture(name));
  document.close();
  return content.collectPostContainers();
}

function summary(capture) {
  return {
    text: capture.text,
    sourceUrl: capture.sourceUrl,
    threadPosition: capture.threadPosition
  };
}

test("四種 DOM fixture 均為可讀的 HTML", () => {
  for (const name of ["single-post", "complete-thread", "incomplete-thread", "quoted-post"]) {
    assert.match(fixture(name), /<!doctype html>/i);
  }
});

test("單篇 fixture 只辨識一個貼文容器", () => {
  assert.equal(load("single-post").length, 1);
});

test("單篇擷取結果符合 golden snapshot", () => {
  const [container] = load("single-post");
  assert.deepEqual(content.extractPost(container), golden("single-post"));
});

test("單篇網址會正規化為 threads.com", () => {
  const capture = content.extractPost(load("single-post")[0]);
  assert.equal(capture.sourceUrl, "https://www.threads.com/@sample/post/root001");
});

test("單篇圖片保留尺寸並清除替代文字", () => {
  const [media] = content.extractPost(load("single-post")[0]).media;
  assert.deepEqual(media, {
    type: "image",
    url: "https://cdn.example.test/media/photo-640.jpg?token=redacted",
    alt: "",
    width: 640,
    height: 480
  });
});

test("可由正文節點找到所屬貼文容器", () => {
  load("single-post");
  assert.equal(content.findPostContainer(document.querySelector("[dir='auto']"))?.id, "single-post");
});

test("預期貼文編號不符時會安全中止", () => {
  const [container] = load("single-post");
  assert.throws(() => content.extractPost(container, { expectedPostId: "other" }), /不一致/);
});

test("完整串文辨識三個容器", () => {
  assert.equal(load("complete-thread").length, 3);
});

test("完整串文摘要符合 golden snapshot", () => {
  const captures = load("complete-thread").map(container => summary(content.extractPost(container)));
  assert.deepEqual(captures, golden("complete-thread"));
});

test("完整串文保留 1/3 到 3/3 序號", () => {
  const positions = load("complete-thread").map(container => content.extractPost(container).threadPosition);
  assert.deepEqual(positions, ["1/3", "2/3", "3/3"]);
});

test("完整串文主貼文取得兩則續文", () => {
  const containers = load("complete-thread");
  const rootCapture = content.extractPost(containers[0]);
  const records = content.collectContinuationRecords(containers, containers[0], rootCapture);
  assert.equal(records.continuations.length, 2);
  assert.equal(records.authorReplies.length, 0);
});

test("完整續文依 2/3、3/3 排列", () => {
  const containers = load("complete-thread");
  const records = content.collectContinuationRecords(containers, containers[0], content.extractPost(containers[0]));
  assert.deepEqual(records.continuations.map(record => record.entry.threadPosition), ["2/3", "3/3"]);
});

test("缺漏串文摘要符合 golden snapshot", () => {
  const captures = load("incomplete-thread").map(container => summary(content.extractPost(container)));
  assert.deepEqual(captures, golden("incomplete-thread"));
});

test("缺漏串文不會虛構 2/3", () => {
  const containers = load("incomplete-thread");
  const records = content.collectContinuationRecords(containers, containers[0], content.extractPost(containers[0]));
  assert.deepEqual(records.continuations.map(record => record.entry.threadPosition), ["3/3"]);
});

test("引用貼文卡不會成為第二個頂層容器", () => {
  assert.equal(load("quoted-post").length, 1);
});

test("引用貼文結果符合 golden snapshot", () => {
  const capture = content.extractPost(load("quoted-post")[0]);
  assert.deepEqual({
    text: capture.text,
    sourceUrl: capture.sourceUrl,
    media: capture.media,
    quotedPosts: capture.quotedPosts,
    containerPostIds: capture.captureValidation.containerPostIds,
    excludedPostIds: capture.captureValidation.excludedPostIds
  }, golden("quoted-post"));
});

test("引用卡片文字不會混入主貼文", () => {
  const capture = content.extractPost(load("quoted-post")[0]);
  assert.equal(capture.text, "主貼文只應保留這段文字。");
  assert.doesNotMatch(capture.text, /引用卡片/);
});

test("引用卡片圖片不會混入主貼文媒體", () => {
  assert.deepEqual(content.extractPost(load("quoted-post")[0]).media, []);
});

test("引用卡片保留引用貼文編號與網址", () => {
  assert.deepEqual(content.extractQuotedPosts(load("quoted-post")[0]), [{
    postId: "embedded001",
    sourceUrl: "https://www.threads.com/@other/post/embedded001"
  }]);
});

test("明確傳入的選取文字可建立 selection capture", () => {
  load("single-post");
  const capture = content.captureSelection("  ALPHA  ");
  assert.equal(capture.captureType, "selection");
  assert.equal(capture.text, "ALPHA");
  assert.deepEqual(capture.continuations, []);
});

test("空白選取文字會拒絕保存", () => {
  load("single-post");
  assert.throws(() => content.captureSelection("   "), /請先選取/);
});

test("合併 DOM 與結構化續文時採用較長正文", () => {
  const domRecord = { entry: { sourceUrl: "https://www.threads.com/@sample/post/thread002", text: "短", quotedPosts: [] } };
  const structured = { entry: { sourceUrl: domRecord.entry.sourceUrl, text: "較完整的正文", quotedPosts: [] } };
  const [merged] = content.mergeContinuationRecords([domRecord], [structured]);
  assert.equal(merged.entry.text, "較完整的正文");
  assert.equal(merged.structuredTextUsed, true);
});

test("合併續文時引用貼文依 postId 去重", () => {
  const sourceUrl = "https://www.threads.com/@sample/post/thread002";
  const quote = { postId: "q1", sourceUrl: "https://www.threads.com/@other/post/q1" };
  const domRecord = { entry: { sourceUrl, text: "相同長度", quotedPosts: [quote] } };
  const structured = { entry: { sourceUrl, text: "較長的相同正文", quotedPosts: [quote] } };
  const [merged] = content.mergeContinuationRecords([domRecord], [structured]);
  assert.deepEqual(merged.entry.quotedPosts, [quote]);
});

test("目前單篇貼文的一次性擷取可完成且不加入續文", async () => {
  load("single-post", "https://www.threads.com/@sample/post/root001");
  const capture = await content.captureCurrentThread(false);
  assert.equal(capture.text, "這是一篇沒有續文的測試貼文。");
  assert.deepEqual(capture.continuations, []);
  assert.deepEqual(capture.authorReplies, []);
});

test("目前完整串文的一次性擷取會依序加入同作者續文", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => "" });
  try {
    load("complete-thread", "https://www.threads.com/@sample/post/thread001");
    const capture = await content.captureCurrentThread(true);
    assert.deepEqual(capture.continuations.map(item => item.threadPosition), ["2/3", "3/3"]);
    assert.doesNotMatch(capture.reviewFlags.join(" "), /串文未完整/);
    // A thread read completely from the page carries no "no thread data" warning, whatever data the page has.
    assert.deepEqual(capture.captureNotes ?? [], []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("目前缺漏串文的一次性擷取會標記不完整", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => "" });
  try {
    load("incomplete-thread", "https://www.threads.com/@sample/post/gap001");
    const capture = await content.captureCurrentThread(true);
    assert.deepEqual(capture.continuations, []);
    assert.match(capture.reviewFlags.join(" "), /串文未完整/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("內文連結會還原 Threads 轉址並保留顯示文字，預覽卡片另存且不重複", () => {
  const [container] = load("link-post", "https://www.threads.com/@sample/post/link001");
  const capture = content.extractPost(container);
  assert.equal(capture.text, "推薦這篇 blog.example.test/posts/long-a…，感謝 @friend 分享");
  assert.deepEqual(capture.links, [{
    text: "blog.example.test/posts/long-a…",
    url: "https://blog.example.test/posts/long-article?ref=threads"
  }]);
  assert.deepEqual(capture.linkCards.map(card => card.url), ["https://news.example.test/story"]);
});

test("真實頁面：引用自己舊貼文時，主貼文正文不會被誤判給引用卡片", async () => {
  const containers = load("quote-with-link", "https://www.threads.com/@sample/post/quote002");
  const capture = await content.captureCurrentThread(true);
  assert.match(capture.text, /^主貼文第一段/);
  assert.match(capture.text, /結尾在這裡。$/);
  assert.doesNotMatch(capture.text, /引用貼文|tool\.example/);
  assert.deepEqual(capture.quotedPosts.map(item => item.postId), ["quoted002"]);
  assert.deepEqual(capture.links, []);
  assert.deepEqual(capture.media, []);

  const quoted = content.extractPost(containers.find(container => /quoted002/.test(content.extractPost(container).sourceUrl)));
  assert.match(quoted.text, /^引用貼文開頭/);
  assert.doesNotMatch(quoted.text, /主貼文/);
  assert.deepEqual(quoted.links, [{ text: "tool.example.test", url: "https://tool.example.test/" }]);
  assert.equal(quoted.media.length, 2);
});

test("真實頁面：連結預覽卡片的縮圖與標題不會被當成貼文圖片或正文", async () => {
  load("link-preview-card", "https://www.threads.com/@sample/post/card001");
  const capture = await content.captureCurrentThread(true);
  assert.equal(capture.text, [
    "預覽卡片測試貼文第一行",
    "第二行測試文字",
    "第三行測試文字",
    "第四行附上連結😆",
    "tools.example.test/share/A…"
  ].join("\n"));
  assert.deepEqual(capture.media, []);
  assert.deepEqual(capture.links, [{
    text: "tools.example.test/share/A…",
    url: "https://tools.example.test/share/AbC123dEf456?usp=sharing"
  }]);
  assert.deepEqual(capture.linkCards, []);
});

test("無法得知頁面最初載入的網址時，不會判定資料過期而重新整理", () => {
  load("single-post");
  assert.deepEqual(content.pageDataStatus(), { stale: false });
});

test("貼文外層包著導覽列與頁尾時，擷取的只有貼文本身，不含選單與頁尾文字", () => {
  env.dom.reconfigure({ url: "https://www.threads.com/@sample/post/root001" });
  document.open();
  document.write(`<!doctype html><html><body>
    <div id="page">
      <nav><a href="/">首頁</a><a href="/new">新串文</a><a href="/inbox">訊息</a></nav>
      <div id="card" data-pressable-container="true">
        <a href="/@sample/post/root001"><time datetime="2026-01-01T00:00:00.000Z">1 天</time></a>
        <div dir="auto">貼文本身的文字</div>
      </div>
      <footer><div dir="auto">© 2026</div><div dir="auto">《Threads 使用條款》</div></footer>
    </div></body></html>`);
  document.close();
  const containers = content.collectPostContainers();
  assert.equal(containers.length, 1);
  assert.equal(containers[0].id, "card");
  const capture = content.extractPost(containers[0]);
  assert.match(capture.text, /貼文本身的文字/);
  assert.doesNotMatch(capture.text, /首頁|使用條款|2026/);
});

test("按「更多」後貼文被重新繪製、空了一下子，仍等它有內容才擷取，不把整頁的選單與頁尾當成貼文", async () => {
  env.dom.reconfigure({ url: "https://www.threads.com/@sample/post/root001" });
  document.open();
  document.write(`<!doctype html><html><body>
    <div id="page">
      <nav><a href="/">首頁</a><a href="/new">新串文</a></nav>
      <div id="slot"></div>
      <footer><div dir="auto">© 2026</div><div dir="auto">《Threads 使用條款》</div></footer>
    </div></body></html>`);
  document.close();
  const card = (/** @type {string} */ inner) => `<div data-pressable-container="true">
    <a href="/@sample/post/root001"><time datetime="2026-01-01T00:00:00.000Z">1 天</time></a>${inner}</div>`;
  const slot = /** @type {HTMLElement} */ (document.getElementById("slot"));
  slot.innerHTML = card(`<div dir="auto">貼文開頭…</div><div role="button">顯示更多</div>`);
  slot.querySelector("[role='button']")?.addEventListener("click", () => {
    // Threads draws the post again: an empty card first, the full text a moment later.
    slot.innerHTML = card("");
    setTimeout(() => { slot.innerHTML = card(`<div dir="auto">貼文開頭，以及展開後的全文</div>`); }, 600);
  });
  const capture = await content.captureCurrentThread(false);
  assert.match(capture.text, /展開後的全文/);
  assert.doesNotMatch(capture.text, /首頁|使用條款|2026/);
});
