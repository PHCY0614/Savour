"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/shared.js");
const D = require("../model/dedupe-key.js");

test("清理文字並保留段落", () => {
  assert.equal(S.cleanText("  第一段  \r\n\r\n\r\n 第二段\t "), "第一段\n\n第二段");
});

test("正規化 Threads 網址並移除追蹤參數", () => {
  assert.equal(
    S.normalizeThreadsUrl("https://threads.net/@Example/post/ABC123/?xmt=anything#reply"),
    "https://www.threads.com/@Example/post/ABC123"
  );
});

test("長文附件網址會還原為真正貼文網址", () => {
  assert.equal(
    S.normalizeThreadsUrl("https://www.threads.com/@Example/post/ABC123/media?xmt=anything"),
    "https://www.threads.com/@Example/post/ABC123"
  );
  assert.equal(
    D.captureKey({ captureType: "post", sourceUrl: "https://www.threads.com/@Example/post/ABC123/media" }),
    "tsc:ABC123"
  );
});

test("解析 Threads 作者與貼文編號", () => {
  assert.deepEqual(S.parseThreadsUrl("https://www.threads.com/@Example/post/ABC123"), {
    normalized: "https://www.threads.com/@Example/post/ABC123",
    handle: "example",
    postId: "ABC123",
    platform: "threads"
  });
});

test("X 與 Twitter 貼文網址統一成 x.com，並可從編號推算發布時間", () => {
  assert.equal(S.normalizeThreadsUrl("https://twitter.com/Sample/status/20?s=20#m"), "https://x.com/sample/status/20");
  assert.equal(S.normalizeThreadsUrl("https://mobile.x.com/Some_One/status/1790000000000000034/photo/1"), "https://x.com/some_one/status/1790000000000000034");
  assert.deepEqual(S.parseThreadsUrl("https://x.com/i/web/status/1790000000000000034"), {
    normalized: "https://x.com/i/web/status/1790000000000000034",
    handle: "",
    postId: "1790000000000000034",
    platform: "x"
  });
  assert.equal(D.captureKey({ sourceUrl: "https://twitter.com/sample/status/20" }), "x:20");
  assert.equal(S.xStatusTime("1790000000000000034"), "2024-05-13T12:43:51.248Z");
  assert.equal(S.xStatusTime("20"), "");
  assert.equal(S.parseThreadsUrl("https://x.com/home").postId, "");
});

test("一般網頁保留決定內容的參數，只移除追蹤參數與 #", () => {
  assert.equal(
    S.normalizeThreadsUrl("https://news.example.com/a/b.php?id=3&utm_source=line&fbclid=x#comments"),
    "https://news.example.com/a/b.php?id=3"
  );
  assert.equal(S.normalizeThreadsUrl("https://blog.example.com/post/1?utm_medium=a"), "https://blog.example.com/post/1");
  assert.equal(D.captureKey({ sourceUrl: "https://blog.example.com/post/1#x" }), "web:https://blog.example.com/post/1");
  // Another site's /@name/post/... path is not a Threads post.
  assert.deepEqual(S.parseThreadsUrl("https://medium.com/@writer/post/abc"), {
    normalized: "https://medium.com/@writer/post/abc",
    handle: "",
    postId: "",
    platform: "web"
  });
  assert.equal(S.postIdentity("https://medium.com/@writer/post/abc"), "");
  assert.equal(S.isSupportedSourceUrl("https://news.example.com/"), true);
  assert.equal(S.isSupportedSourceUrl("chrome://extensions"), false);
  assert.match(S.webPageKey(`https://example.com/?q=${"a".repeat(2000)}`), /^web:#[0-9a-f]{8}-\d+$/);
  // Gmail's message id lives in the fragment, so two mails must not share one key; other sites drop it.
  assert.notEqual(
    S.webPageKey("https://mail.google.com/mail/u/0/#inbox/AAA"),
    S.webPageKey("https://mail.google.com/mail/u/0/#inbox/BBB")
  );
  assert.equal(S.webPageKey("https://example.com/a#x"), S.webPageKey("https://example.com/a#y"));
});

test("網頁的本機保存狀態只比對同一個網址，不會被其他網站的同名路徑誤判", () => {
  const state = {
    queue: [],
    saved: {
      "web:https://a.example.com/post/1": { sourceUrl: "https://a.example.com/post/1", title: "A" }
    }
  };
  assert.equal(D.localPostCaptureStatus(state, "https://a.example.com/post/1?utm_source=x").status, "saved");
  assert.equal(D.localPostCaptureStatus(state, "https://b.example.com/post/1").status, "new");
});

test("從 Notion 網址擷取 UUID", () => {
  assert.equal(
    S.extractNotionId("https://www.notion.so/demo-1234567890abcdef1234567890abcdef?pvs=4"),
    "12345678-90ab-cdef-1234-567890abcdef"
  );
});

test("Notion Database 網址只擷取 path 中的 Database ID，不誤取 view ID", () => {
  assert.equal(
    S.extractNotionDatabaseId("https://www.notion.so/workspace/248104cd477e80fdb757e945d38000bd?v=148104cd477e80bb928f000ce197ddf2"),
    "248104cd-477e-80fd-b757-e945d38000bd"
  );
});

test("支援 app.notion.com 的 /p/ Database 網址", () => {
  assert.equal(
    S.extractNotionDatabaseId("https://app.notion.com/p/3c6fbfaeca5b80379998cfb4aaf1df34?v=3c6fbfaeca5b80e5a5ba000ca2b8d952"),
    "3c6fbfae-ca5b-8037-9998-cfb4aaf1df34"
  );
});

test("非 Notion 網址不會被當成 Database 網址", () => {
  assert.equal(
    S.extractNotionDatabaseId("https://example.com/248104cd477e80fdb757e945d38000bd"),
    ""
  );
});

test("完整貼文與選取文字使用不同去重鍵", () => {
  const base = { sourceUrl: "https://threads.net/@a/post/1", text: "一段文字" };
  assert.equal(D.captureKey({ ...base, captureType: "post" }), "tsc:1");
  assert.match(D.captureKey({ ...base, captureType: "selection" }), /^selection:https:\/\/www\.threads\.com\/@a\/post\/1:[0-9a-f]{8}$/);
});

test("長文字會分段且不遺失內容", () => {
  const source = `${"甲".repeat(90)} ${"乙".repeat(90)} ${"丙".repeat(90)}`;
  const chunks = S.chunkText(source, 100);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(" "), source);
  assert.ok(chunks.every(chunk => chunk.length <= 100));
});

test("Notion 標題不含日期且最多三十字", () => {
  const title = S.buildTitle(
    "這是一篇用來測試資料庫標題長度的 Threads 長文章，後面還有很多內容",
    "2026-08-20T10:00:00.000Z"
  );
  assert.ok(title.length >= 20);
  assert.ok(title.length <= 30);
  assert.doesNotMatch(title, /^2026-08-20/);
  assert.doesNotMatch(title, /…/);
});

test("辨識並驗證串文位置序號", () => {
  assert.deepEqual(S.parseThreadPosition("1 / 3"), { index: 1, total: 3 });
  assert.deepEqual(S.parseThreadPosition("2/3"), { index: 2, total: 3 });
  assert.equal(S.parseThreadPosition("1/1"), null);
  assert.equal(S.parseThreadPosition("正文寫了 1/3 杯水"), null);
});

test("排除 Threads 介面文字但保留真正正文", () => {
  for (const value of [
    "串文\n121次瀏覽",
    "121次瀏覽",
    "閱讀全文",
    "熱門",
    "已釘選",
    "·",
    "作者",
    "· 作者",
    "回覆cty_hrd330……",
    "無地點資料",
    "2026-7-9",
    "/",
    "還剩21小時",
    "還剩 5 分鐘",
    "21 hours left",
    "全部",
    "All",
    "尚無回覆",
    "No replies yet",
    "Threads 主題：高敏人"
  ]) {
    assert.equal(S.isThreadsUiText(value, "example"), true, `${value} 應視為介面文字`);
  }
  assert.equal(
    S.isThreadsUiText("（註：內文涉及政治與階級的敏感內容，這是限時貼文。）", "example"),
    false
  );
  assert.equal(S.isThreadsUiText("作者在這裡補充正文", "example"), false);
  assert.equal(S.isThreadsUiText("這篇文章已釘選在首頁", "example"), false);
  // Only a line that is exactly the label counts; the words inside a post stay.
  assert.equal(S.isThreadsUiText("全部都是我的錯", "example"), false);
  assert.equal(S.isThreadsUiText("尚無回覆的貼文很孤單", "example"), false);
});

test("清除串文殘留符號與重複的 Threads 主題", () => {
  assert.equal(
    S.stripThreadsMetadataLines("正文第一段\n\n/\nThreads 主題：高敏人\n高敏人\n\n正文第二段", "高敏人"),
    "正文第一段\n\n正文第二段"
  );
});

test("辨識貼文卡片中已載入但折疊的長文", () => {
  const preview = "預覽內容".repeat(20);
  const full = `${preview}${"完整後段".repeat(80)}`;
  assert.equal(S.hiddenLongTextCandidate(preview, full, preview), full);
  assert.equal(S.hiddenLongTextCandidate(full, full, full), "");
  const veryLong = `${preview}${"超長後段".repeat(6000)}`;
  assert.equal(S.hiddenLongTextCandidate(preview, veryLong, preview), veryLong);
});

test("貼文候選只接受單一來源並優先選語意貼文容器", () => {
  const candidates = [
    {
      key: "page-wrapper",
      directPostId: "TARGET",
      postIds: ["TARGET"],
      semantic: false,
      nestedPostCount: 3,
      connected: true,
      visible: true,
      hasTextEvidence: true,
      textEvidenceLength: 500,
      mediaEvidenceCount: 0,
      nodeCount: 900
    },
    {
      key: "other-posts-mixed",
      directPostId: "TARGET",
      postIds: ["TARGET", "OTHER"],
      semantic: false,
      nestedPostCount: 0,
      connected: true,
      visible: true,
      hasTextEvidence: true,
      textEvidenceLength: 300,
      mediaEvidenceCount: 0,
      nodeCount: 300
    },
    {
      key: "target-article",
      directPostId: "TARGET",
      postIds: ["TARGET"],
      semantic: true,
      nestedPostCount: 0,
      connected: true,
      visible: true,
      hasTextEvidence: true,
      textEvidenceLength: 120,
      mediaEvidenceCount: 0,
      nodeCount: 120
    }
  ];
  assert.equal(S.choosePostCandidate(candidates, "TARGET")?.key, "target-article");
});

test("同一貼文的完整文字卡片優先於較小的圖片容器", () => {
  const candidates = [
    {
      key: "complete-card",
      directPostId: "IMAGEPOST",
      postIds: ["IMAGEPOST", "QUOTED"],
      semantic: true,
      nestedPostCount: 0,
      connected: true,
      visible: true,
      hasTextEvidence: true,
      textEvidenceLength: 180,
      mediaEvidenceCount: 2,
      nodeCount: 180
    },
    {
      key: "media-only-child",
      directPostId: "IMAGEPOST",
      postIds: ["IMAGEPOST"],
      semantic: true,
      nestedPostCount: 0,
      connected: true,
      visible: true,
      hasTextEvidence: false,
      textEvidenceLength: 0,
      mediaEvidenceCount: 2,
      nodeCount: 40
    }
  ];
  assert.equal(S.choosePostCandidate(candidates, "IMAGEPOST")?.key, "complete-card");
});

test("正規化串文位置與待檢查項目", () => {
  assert.equal(S.normalizeThreadPosition(" 2 / 6 "), "2/6");
  assert.equal(S.normalizeThreadPosition({ index: 3, total: 6 }), "3/6");
  assert.equal(S.normalizeThreadPosition("1/1"), "");
  assert.deepEqual(
    S.normalizeReviewFlags(["留言", "作者回覆讀者", "作者回覆", "未知項目", "長文未完整", "串文未完整"]),
    ["串文未完整"]
  );
});

test("釘選造成畫面亂序時仍依 1/N 編號重建連續串文", () => {
  const three = { id: "three", threadPosition: "3/3" };
  const two = { id: "two", threadPosition: "2/3" };
  const result = S.orderThreadEntries([three, two], { index: 1, total: 3 });
  assert.deepEqual(result.ordered.map(item => item.id), ["two", "three"]);
  assert.equal(result.complete, true);
  assert.equal(result.missingIndex, 0);
});

test("缺少中間編號時只保留連續前綴且不以其他回覆補洞", () => {
  const result = S.orderThreadEntries([
    { id: "three", threadPosition: "3/4" },
    { id: "four", threadPosition: "4/4" }
  ], "1/4");
  assert.deepEqual(result.ordered, []);
  assert.equal(result.complete, false);
  assert.equal(result.missingIndex, 2);
});

test("更新保護能找出上次保存、這次未載入的作者回覆", () => {
  assert.deepEqual(S.missingPostIds(["A", "B", "B"], ["B", "C"]), ["A"]);
});

test("結構化資料可從正文尾端拆出串文序號", () => {
  assert.deepEqual(S.splitTrailingThreadPosition("長文附件完整內容\n\n2 / 2"), {
    text: "長文附件完整內容",
    threadPosition: "2/2"
  });
  assert.deepEqual(S.splitTrailingThreadPosition("正文提到 1/2 杯水"), {
    text: "正文提到 1/2 杯水",
    threadPosition: ""
  });
});

test("DOM 缺少續文時可從同作者結構化資料建立 2/N 備援", () => {
  const entries = S.structuredThreadEntries([
    { postId: "R3", author: "example", text: "第三段\n3/3" },
    { postId: "OTHER", author: "reader", text: "不是作者\n2/3" },
    { postId: "R2", author: "example", text: "只有長文附件的第二段\n2/3" }
  ], "example", "1/3");
  assert.deepEqual(entries.map(entry => [entry.postId, entry.threadPosition, entry.text]), [
    ["R3", "3/3", "第三段"],
    ["R2", "2/3", "只有長文附件的第二段"]
  ]);
  assert.deepEqual(
    S.orderThreadEntries(entries, "1/3").ordered.map(entry => entry.postId),
    ["R2", "R3"]
  );
});

test("長文附件可從所有文字片段組成正文並讀取明確串文位置", () => {
  const post = {
    caption: { text: "" },
    text_post_app_info: {
      snippet_attachment_info: {
        text_fragments: {
          fragments: [
            { plaintext: "長文第一段" },
            { plaintext: "長文第二段" }
          ]
        }
      },
      self_thread_info: {
        post_position_in_self_thread: 2,
        self_thread_length: 2
      }
    }
  };
  assert.equal(S.extractStructuredPostText(post), "長文第一段\n\n長文第二段");
  assert.equal(S.extractStructuredThreadPosition(post), "2/2");

  post.caption.text = "長文預覽";
  post.text_post_app_info.self_thread_info.post_position_in_self_thread = 1;
  assert.equal(S.extractStructuredPostText(post), "長文第一段\n\n長文第二段");
  assert.equal(S.extractStructuredThreadPosition(post), "1/2");
});

test("結構化明確位置優先於正文尾端推測且不要求長文附帶 N/N", () => {
  const entries = S.structuredThreadEntries([{
    postId: "R2",
    author: "example",
    text: "只有長文附件的第二段",
    threadPosition: "2/2"
  }], "example", "1/2");
  assert.deepEqual(entries.map(entry => [entry.postId, entry.threadPosition, entry.text]), [
    ["R2", "2/2", "只有長文附件的第二段"]
  ]);
});

test("結構化引用只保留 quote 或 share 路徑中的貼文連結", () => {
  const quoted = { code: "QUOTED1", user: { username: "Quoted_User" } };
  const post = {
    code: "OWNER1",
    user: { username: "owner" },
    unrelated_root_post: { code: "ROOT1", user: { username: "owner" } },
    text_post_app_info: {
      share_info: {
        quoted_post: quoted,
        duplicate_quoted_post: quoted
      }
    }
  };
  assert.deepEqual(S.extractStructuredQuotedPosts(post), [{
    postId: "QUOTED1",
    sourceUrl: "https://www.threads.com/@quoted_user/post/QUOTED1"
  }]);
});

test("只有作者直接回覆自己的主文才視為可保存的作者補充", () => {
  assert.equal(S.isDirectAuthorSupplement({
    author: "example",
    isReply: true,
    replyToAuthor: "example",
    rootAuthor: "example"
  }, "example"), true);
  assert.equal(S.isDirectAuthorSupplement({
    author: "example",
    isReply: true,
    replyToAuthor: "reader",
    rootAuthor: "example"
  }, "example"), false);
  assert.equal(S.isDirectAuthorSupplement({
    author: "reader",
    isReply: true,
    replyToAuthor: "example",
    rootAuthor: "example"
  }, "example"), false);
});

test("保存目前文章可先由本機索引判斷已存在或正在等待", () => {
  const sourceUrl = "https://www.threads.com/@example/post/POST123";
  const key = `post:${sourceUrl}`;
  const savedRecord = { sourceUrl, title: "已保存文章", notionUrl: "https://notion.so/page" };

  assert.deepEqual(D.localPostCaptureStatus({ queue: [], saved: { [key]: savedRecord } }, sourceUrl), {
    status: "saved",
    key,
    record: savedRecord
  });
  assert.deepEqual(D.localPostCaptureStatus({
    queue: [{
      id: "QUEUE1",
      status: "pending",
      capture: { captureType: "post", dedupeKey: key, sourceUrl }
    }],
    saved: { [key]: savedRecord }
  }, sourceUrl), {
    status: "pending",
    key,
    queueId: "QUEUE1"
  });
  assert.equal(D.localPostCaptureStatus({
    queue: [{
      id: "QUEUE2",
      status: "failed",
      capture: { captureType: "post", dedupeKey: key, sourceUrl }
    }],
    saved: {}
  }, sourceUrl).status, "failed");
  assert.equal(D.localPostCaptureStatus({
    queue: [],
    saved: {
      "selection:test": { sourceUrl, captureType: "selection" }
    }
  }, sourceUrl).status, "new");
});

test("外部連結會還原 Threads 轉址，並排除站內與不安全網址", () => {
  assert.equal(
    S.externalLinkUrl("https://l.threads.com/?u=https%3A%2F%2Fexample.test%2Fa%3Fb%3D1&e=token"),
    "https://example.test/a?b=1"
  );
  assert.equal(S.externalLinkUrl("https://www.threads.com/@example"), "");
  assert.equal(S.externalLinkUrl("javascript:alert(1)"), "");
  assert.equal(S.externalLinkUrl("https://l.threads.com/?u=javascript%3Aalert(1)"), "");
  assert.equal(S.webLinkUrl("https://www.threads.com/@example/post/ABC"), "https://www.threads.com/@example/post/ABC");
  assert.deepEqual(S.normalizeLinks([
    { text: " a.test/x… ", url: "https://a.test/x" },
    { text: "a.test/x…", url: "https://a.test/x" },
    { text: "壞", url: "ftp://a.test" }
  ]), [{ text: "a.test/x…", url: "https://a.test/x" }]);
});

test("結構化資料可取得連結片段與預覽卡片，未知格式則略過", () => {
  const result = S.extractStructuredLinks({
    text_post_app_info: {
      text_fragments: {
        fragments: [
          { fragment_type: "plaintext", plaintext: "看這篇 " },
          { fragment_type: "link", plaintext: "a.test/x…", link_fragment: { uri: "https://l.threads.com/?u=https%3A%2F%2Fa.test%2Fx", display_text: "a.test/x…" } }
        ]
      },
      link_preview_attachment: { url: "https://b.test/story", title: "B 新聞" }
    }
  });
  assert.deepEqual(result.links, [{ text: "a.test/x…", url: "https://a.test/x" }]);
  assert.deepEqual(result.linkCards, [{ text: "B 新聞", url: "https://b.test/story" }]);
  assert.deepEqual(S.extractStructuredLinks({ text_post_app_info: { unknown: { url: "https://c.test" } } }), { links: [], linkCards: [] });
});

test("含其他貼文的容器只有在其他貼文都位於引用卡片內時才可採用，且優先選貼文自己的卡片", () => {
  const base = { connected: true, visible: true, directPostId: "MAIN", semantic: false, nestedPostCount: 0 };
  const headerOnly = { ...base, postIds: ["MAIN"], hasTextEvidence: false, textEvidenceLength: 0, nodeCount: 5 };
  const withQuote = { ...base, postIds: ["MAIN", "QUOTE"], hasTextEvidence: true, textEvidenceLength: 120, nodeCount: 80 };
  assert.equal(S.choosePostCandidate([headerOnly, withQuote], "MAIN"), headerOnly);
  const contained = { ...withQuote, embeddedPostsContained: true };
  assert.equal(S.choosePostCandidate([headerOnly, contained], "MAIN"), contained);

  const ownCard = { ...base, postIds: ["MAIN"], hasTextEvidence: true, textEvidenceLength: 50, nodeCount: 20, ownCard: true };
  const bigger = { ...base, postIds: ["MAIN"], hasTextEvidence: true, textEvidenceLength: 200, nodeCount: 90 };
  assert.equal(S.choosePostCandidate([bigger, ownCard], "MAIN"), ownCard);
});

test("段落以空白行分開，單一換行留在段落裡", () => {
  const paragraphs = S.splitParagraphs([{ text: "a\nb\n\nc" }, { text: " d", href: "https://x.test/" }]);
  assert.deepEqual(paragraphs.map(spans => spans.map(span => span.text).join("")), ["a\nb", "c d"]);
});

test("頁面上的相對網址以頁面網址補全，不是網址的 href 回傳 null", () => {
  assert.equal(S.resolveUrl("/in/someone/", "https://www.linkedin.com/feed/")?.href, "https://www.linkedin.com/in/someone/");
  assert.equal(S.resolveUrl("http://[bad", "https://example.com/"), null);
});

test("含網站導覽列或頁尾的容器是整個頁面，不會被當成貼文，即使它的文字比貼文自己的卡片多", () => {
  const base = { connected: true, visible: true, directPostId: "MAIN", semantic: false, nestedPostCount: 0, postIds: ["MAIN"] };
  const card = { ...base, hasTextEvidence: false, textEvidenceLength: 0, nodeCount: 20, ownCard: true };
  const page = { ...base, hasTextEvidence: true, textEvidenceLength: 400, nodeCount: 900, containsPageChrome: true };
  assert.equal(S.choosePostCandidate([page, card], "MAIN"), card);
  assert.equal(S.choosePostCandidate([page], "MAIN"), null);
});

test("貼文裡貼的 Threads 短連結（/share/…）是連結，個人頁、主題與貼文網址仍不算外部連結", () => {
  assert.equal(S.externalLinkUrl("https://www.threads.com/share/BAuVQ0a79-"), "https://www.threads.com/share/BAuVQ0a79-");
  assert.equal(S.externalLinkUrl("https://www.threads.com/@someone"), "");
  assert.equal(S.externalLinkUrl("https://www.threads.com/@someone/post/ABC123"), "");
  assert.equal(S.externalLinkUrl("https://www.threads.com/search?q=x"), "");
  assert.deepEqual(S.normalizeLinks([{ text: "threads.com/share…", url: "https://www.threads.com/share/BAuVQ0a79-" }]), [{ text: "threads.com/share…", url: "https://www.threads.com/share/BAuVQ0a79-" }]);
});
