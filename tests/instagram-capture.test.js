"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installDom } = require("./helpers/dom-env");
const S = require("../lib/shared.js");
const M = require("../model/capture-model.js");
const N = require("../notion/index.js");
const D = require("../model/dedupe-key.js");
const { createInstagramCapture } = require("../content/instagram-capture.js");

const POST_URL = "https://www.instagram.com/sample_account/p/Abc123Post1/?img_index=1";
const fixture = () => fs.readFileSync(path.join(__dirname, "fixtures", "dom", "instagram-post.html"), "utf8");

function withPage(html, url, run) {
  const env = installDom(html, { url });
  try {
    return run(createInstagramCapture({ shared: S }));
  } finally {
    env.restore();
  }
}

// The logged-in page keeps the same post fields under a different wrapper.
function loggedInPage(item) {
  const data = { data: { xdt_api__v1__media__shortcode__web_info: { items: [item] } } };
  return `<!doctype html><html><head><title>Instagram</title></head><body>
    <script type="application/json">${JSON.stringify({ require: [["ScheduledServerJS", "handle", null, [{ __bbox: { result: data } }]]] })}</script>
  </body></html>`;
}

test("Instagram 網址：貼文與 Reels 統一成 /p/<代碼>/，以 ig: 去重", () => {
  assert.equal(S.normalizeThreadsUrl(POST_URL), "https://www.instagram.com/p/Abc123Post1/");
  assert.equal(S.normalizeThreadsUrl("https://instagram.com/reel/Abc123Reel1"), "https://www.instagram.com/p/Abc123Reel1/");
  assert.equal(D.captureKey({ sourceUrl: POST_URL }), "ig:Abc123Post1");
  assert.equal(S.postIdentity(POST_URL), "instagram:Abc123Post1");
  assert.equal(S.instagramPostCode("https://www.instagram.com/sample_account/"), "");
});

test("Instagram 輪播貼文：從頁面資料讀完整說明文字、作者、時間與每張最大尺寸的圖片", () => {
  const result = withPage(fixture(), POST_URL, capture => capture.captureCurrentPost());
  assert.equal(result.platform, "instagram");
  assert.equal(result.sourceUrl, "https://www.instagram.com/p/Abc123Post1/");
  assert.equal(result.author, "sample_account");
  assert.equal(result.publishedAt, new Date(1791223651 * 1000).toISOString());
  assert.match(result.text, /^Sample carousel post 🔎\n\nThis is the second paragraph/);
  assert.match(result.text, /#Sample #Test #Caption$/);
  assert.deepEqual(result.media.map(item => item.url), [
    "https://scontent-syd2-1.cdninstagram.com/v/t51.82787-15/first-1440.jpg",
    "https://scontent-syd2-1.cdninstagram.com/v/t51.82787-15/second-1440.jpg"
  ]);
  assert.equal(JSON.stringify(result).includes("別的貼文"), false);
  assert.equal(JSON.stringify(result).includes("other-post"), false);
  assert.deepEqual(result.reviewFlags, []);
  assert.equal(result.captureNotes, undefined);
});

test("Instagram 擷取通過驗證，並以 Instagram 來源與貼文代碼寫入 Notion", () => {
  const capture = M.normalizeCapture(withPage(fixture(), POST_URL, page => page.captureCurrentPost()), { sourceType: "page" });
  assert.equal(capture.dedupeKey, "ig:Abc123Post1");
  const payload = N.createPagePayload(capture, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(payload.properties[N.PROPERTY_NAMES.platform].select.name, "Instagram");
  assert.equal(payload.properties[N.PROPERTY_NAMES.postId].rich_text[0].text.content, "Abc123Post1");
  assert.equal(payload.properties[N.PROPERTY_NAMES.author].rich_text[0].text.content, "sample_account");
  // Titles keep the existing 30-unit limit for posts.
  assert.equal(payload.properties[N.PROPERTY_NAMES.title].title[0].text.content, "Sample carousel post 🔎 This i");
  assert.throws(() => M.normalizeCapture({ ...capture, captureValidation: { ...capture.captureValidation, postId: "other" } }), /來源驗證/);
});

test("Instagram Reels：保存說明文字與封面圖，並提醒影片不會保存（登入後的頁面資料格式）", () => {
  const html = loggedInPage({
    code: "Abc123Reel1",
    media_type: 2,
    taken_at: 1791242278,
    user: { username: "sample_account" },
    caption: { text: "A sample reel caption." },
    image_versions2: { candidates: [
      { url: "https://scontent.cdninstagram.com/cover-480.jpg", width: 480 },
      { url: "https://scontent.cdninstagram.com/cover-720.jpg", width: 720 }
    ] },
    video_versions: [{ url: "https://scontent.cdninstagram.com/video.mp4" }]
  });
  const result = withPage(html, "https://www.instagram.com/sample_account/reel/Abc123Reel1/", capture => capture.captureCurrentPost());
  assert.equal(result.text, "A sample reel caption.");
  assert.deepEqual(result.media, [{ type: "image", url: "https://scontent.cdninstagram.com/cover-720.jpg" }]);
  assert.match(result.captureNotes[0], /影片不會保存/);
});

test("在 Instagram 站內換到另一則貼文時，頁面資料視為過期，需要重新整理一次", () => {
  // The page also lists other posts; one of them is never taken for the post being saved.
  withPage(fixture(), "https://www.instagram.com/sample_account/p/Abc123Post2/", capture => {
    assert.equal(capture.findPost("Abc123Post2"), null);
    assert.deepEqual(capture.pageDataStatus(), { stale: true });
  });
  withPage(fixture(), "https://www.instagram.com/p/Zz9Unrelated1/", capture => {
    assert.deepEqual(capture.pageDataStatus(), { stale: true });
  });
  withPage(fixture(), POST_URL, capture => {
    assert.deepEqual(capture.pageDataStatus(), { stale: false });
  });
});

test("站內換頁後只有不完整的貼文資料（沒有圖片與時間）時不採用，改為重新整理", () => {
  const partial = { code: "Abc123Post2", user: { username: "sample_account" }, caption: { text: "只有說明文字" } };
  const data = { require: [[null, null, null, [{ __bbox: { result: { data: { xig_polaris_media: { if_not_gated_logged_out: partial } } } } }]]] };
  const html = fixture().replace("</body>", `<script type="application/json">${JSON.stringify(data)}</script></body>`);
  withPage(html, "https://www.instagram.com/sample_account/p/Abc123Post2/", capture => {
    assert.equal(capture.findPost("Abc123Post2"), null);
    assert.deepEqual(capture.pageDataStatus(), { stale: true });
  });
});

test("頁面資料讀不到時，改用頁面摘要保存說明文字與第一張圖，並標記正文疑似遺漏", () => {
  const html = fixture().replace(/<script type="application\/json"[\s\S]*?<\/script>/g, "");
  withPage(html, POST_URL, capture => {
    assert.deepEqual(capture.pageDataStatus(), { stale: false });
    const result = capture.captureCurrentPost();
    assert.equal(result.text, "Sample carousel post 🔎\n\nThis is the second paragraph of a sample caption.");
    assert.deepEqual(result.media, [{ type: "image", url: "https://scontent-syd2-1.cdninstagram.com/v/t51.82787-15/og-cover.jpg" }]);
    assert.deepEqual(result.reviewFlags, ["正文疑似遺漏"]);
  });
});

test("不在 Instagram 貼文頁時會明確取消", () => {
  withPage(fixture(), "https://www.instagram.com/sample_account/", capture => {
    assert.throws(() => capture.captureCurrentPost(), /請先點開這則 Instagram 貼文/);
    assert.deepEqual(capture.pageDataStatus(), { stale: false });
  });
});
