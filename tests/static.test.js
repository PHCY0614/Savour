"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tabsModule = () => require("../background/tabs.js").createTabs({ I: {}, S: require("../lib/shared.js") });
const readOne = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n?/g, "\n");
// The background worker is split across background.js and background/*.js; checks about "the background
// service" look at all of them together.
const readFile = file => file === "background.js"
  ? [file, ...fs.readdirSync(path.join(root, "background")).sort().map(name => `background/${name}`)].map(readOne).join("\n")
  : readOne(file);
const read = file => {
  const source = readFile(file);
  if (file !== "content/threads-content.js") return source;
  const modules = [
    "content/toast.js",
    "content/dom-scope.js",
    "content/dom-extract.js",
    "content/legacy-discussion-dom.js",
    "content/legacy-discussion-data.js",
    "content/page-capture.js"
  ]
    .filter(modulePath => fs.existsSync(path.join(root, modulePath)))
    .map(readFile);
  return [source, ...modules].join("\n");
};

test("Manifest 引用的本機檔案都存在", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...manifest.content_scripts.flatMap(entry => [...entry.js, ...(entry.css ?? [])])
  ];
  for (const file of referenced) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} 不存在`);
  }
});

test("背景服務載入的 capture model 模組都存在", () => {
  const background = read("background.js");
  for (const file of ["model/dedupe-key.js", "model/source-flags.js", "model/capture-model.js"]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} 不存在`);
    assert.match(background, new RegExp(file.replace(/[./-]/g, "\\$&")));
  }
});

test("Notion schema、page builder、HTTP 與 repository 模組載入及 wiring 明確", () => {
  const background = readFile("background.js");
  const notion = readFile("notion/index.js");
  const schema = readFile("notion/schema.js");
  const pageBuilder = readFile("notion/page-builder.js");
  const http = readFile("notion/http.js");
  const repository = readFile("notion/repository.js");
  assert.match(background, /importScripts\("i18n\/en\.js", "i18n\/index\.js", "lib\/shared\.js", "notion\/schema\.js", "notion\/page-builder\.js", "notion\/http\.js", "notion\/repository\.js", "notion\/index\.js"/);
  assert.match(notion, /const schema = typeof module/);
  assert.match(notion, /require\("\.\/schema\.js"\)/);
  assert.match(notion, /root\.SavourNotionSchema/);
  assert.match(notion, /require\("\.\/page-builder\.js"\)/);
  assert.match(notion, /root\.SavourNotionPageBuilder/);
  assert.match(notion, /pageBuilder\.createNotionPageBuilder/);
  assert.match(notion, /createArchivePayload,/);
  assert.match(schema, /root\.SavourNotionSchema = api/);
  assert.match(schema, /return \{[\s\S]*archivePropertySchema,[\s\S]*createArchivePayload/);
  assert.match(pageBuilder, /root\.SavourNotionPageBuilder = api/);
  assert.match(pageBuilder, /return \{ createNotionPageBuilder \}/);
  assert.match(http, /root\.SavourNotionHttp = api/);
  assert.match(http, /return \{ createNotionHttp \}/);
  assert.match(background, /require\("\.\/notion\/http\.js"\)/);
  assert.match(background, /SavourNotionHttp/);
  assert.match(background, /NH\.createNotionHttp/);
  assert.match(repository, /root\.SavourNotionRepository = api/);
  assert.match(repository, /return \{ createNotionRepository \}/);
  assert.match(background, /require\("\.\/notion\/repository\.js"\)/);
  assert.match(background, /SavourNotionRepository/);
  assert.match(background, /NR\.createNotionRepository/);
  assert.doesNotMatch(notion, /const PROPERTY_NAMES = Object\.freeze/);
  assert.doesNotMatch(notion, /function archivePropertySchema/);
  assert.doesNotMatch(notion, /function buildPageChildren/);
  assert.doesNotMatch(notion, /function createPagePayload/);
  assert.doesNotMatch(background, /async function notionRequest/);
  assert.doesNotMatch(background, /async function findExistingCapture/);
  assert.doesNotMatch(background, /async function saveCaptureToNotion/);
});

test("設定與 Token 儲存邊界由 storage config 模組負責", () => {
  const background = readFile("background.js");
  const config = readFile("storage/config.js");
  assert.match(background, /importScripts\([\s\S]*"storage\/config\.js"/);
  assert.match(background, /require\("\.\/storage\/config\.js"\)/);
  assert.match(background, /SavourStorageConfig/);
  assert.match(background, /SC\.createConfigStorage/);
  assert.match(config, /root\.SavourStorageConfig = api/);
  assert.match(config, /return \{ CONFIG_KEY, TOKEN_KEY, DEFAULT_CONFIG, createConfigStorage \}/);
  assert.match(config, /async function saveSettings/);
  assert.match(config, /async function requireToken/);
  assert.doesNotMatch(background, /async function readConfig/);
  assert.doesNotMatch(background, /async function readToken/);
  assert.doesNotMatch(background, /async function saveSettings/);
  assert.doesNotMatch(background, /async function requireToken/);
});

test("本機狀態讀寫與序列化鎖由 storage state 模組負責", () => {
  const background = readFile("background.js");
  const state = readFile("storage/state.js");
  assert.match(background, /importScripts\([\s\S]*"storage\/config\.js", "model\/dedupe-key\.js", "storage\/state\.js"/);
  assert.match(background, /SavourDedupeKey|model\/dedupe-key\.js/);
  assert.match(background, /require\("\.\/storage\/state\.js"\)/);
  assert.match(background, /SavourStorageState/);
  assert.match(background, /SS\.createStateStorage/);
  assert.match(state, /root\.SavourStorageState = api/);
  assert.match(state, /return \{ STATE_KEY, DEFAULT_STATE, createStateStorage \}/);
  assert.match(state, /function withStateLock/);
  assert.equal(fs.existsSync(path.join(root, "storage/alias-index.js")), false);
  assert.match(state, /async function clearRecentItems/);
  assert.doesNotMatch(background, /let stateMutex/);
  assert.doesNotMatch(background, /function withStateLock/);
  assert.doesNotMatch(background, /async function readState/);
  assert.doesNotMatch(background, /async function writeState/);
  assert.doesNotMatch(background, /async function clearRecentItems/);
});

test("保存佇列處理、重試與啟動復原由 queue retry 模組負責", () => {
  const background = readFile("background.js");
  const queue = readFile("queue/retry.js");
  assert.match(background, /importScripts\([\s\S]*"model\/capture-model\.js", "queue\/retry\.js"/);
  assert.match(background, /require\("\.\/queue\/retry\.js"\)/);
  assert.match(background, /SavourQueueRetry/);
  assert.match(background, /Q\.createQueueRetry/);
  assert.match(queue, /root\.SavourQueueRetry = api/);
  assert.match(
    queue,
    /return \{[\s\S]*LARGE_CREATE_CONFIRMATION_CODE,[\s\S]*LARGE_CREATE_LIMIT,[\s\S]*PROCESS_ALARM,[\s\S]*createQueueRetry[\s\S]*\};/
  );
  assert.match(queue, /async function enqueueCaptures/);
  assert.match(queue, /async function processQueue/);
  assert.match(queue, /async function retryFailedItems/);
  assert.match(queue, /async function recoverInterruptedItems/);
  assert.doesNotMatch(background, /let processing/);
  assert.doesNotMatch(background, /async function enqueueCaptures/);
  assert.doesNotMatch(background, /async function processQueue/);
  assert.doesNotMatch(background, /async function retryFailedItems/);
  assert.doesNotMatch(background, /async function recoverInterruptedItems/);
  assert.match(background, /isProcessing\(\)/);
});

test("已有本機紀錄時大量建立會先停止並要求使用者確認", () => {
  const background = readFile("background.js");
  const retry = readFile("queue/retry.js");
  assert.match(retry, /const LARGE_CREATE_LIMIT = 20/);
  assert.match(retry, /Object\.keys\(state\.saved \?\? \{\}\)\.length > 0/);
  assert.match(retry, /requestedCreates > LARGE_CREATE_LIMIT/);
  assert.match(background, /confirmedLargeCreate: Boolean\(message\.confirmedLargeCreate\)/);
  assert.match(background, /error\.createCount/);
});

test("content 模組載入順序與 DOM 模組 wiring 明確一致", () => {
  const scripts = tabsModule().scriptsFor("https://www.threads.com/@a/post/b").js;
  assert.deepEqual(scripts, [
    "i18n/en.js",
    "i18n/index.js",
    "lib/shared.js",
    "content/toast.js",
    "content/dom-scope.js",
    "content/dom-extract.js",
    "content/legacy-discussion-dom.js",
    "content/legacy-discussion-data.js",
    "content/page-capture.js",
    "content/threads-content.js"
  ]);

  const content = readFile("content/threads-content.js");
  const domScope = readFile("content/dom-scope.js");
  const domExtract = readFile("content/dom-extract.js");
  const legacyDiscussionDom = readFile("content/legacy-discussion-dom.js");
  const legacyDiscussionData = readFile("content/legacy-discussion-data.js");
  const pageCapture = readFile("content/page-capture.js");
  assert.match(content, /const DS = globalThis\.SavourDomScope/);
  assert.match(content, /const DE = globalThis\.SavourDomExtract/);
  assert.match(content, /DE\.createDomExtract/);
  assert.match(content, /const LDOM = globalThis\.SavourLegacyDiscussionDom/);
  assert.match(content, /LDOM\.createLegacyDiscussionDom/);
  assert.match(content, /const LDD = globalThis\.SavourLegacyDiscussionData/);
  assert.match(content, /LDD\.createLegacyDiscussionData/);
  assert.match(content, /const PC = globalThis\.SavourPageCapture/);
  assert.match(content, /PC\.createPageCapture/);
  assert.doesNotMatch(content, /SavourLegacyDiscussion(?:\s|$)/);
  assert.equal(scripts.includes("content/legacy-discussion.js"), false);
  assert.match(domScope, /postAnchorSuffixDepth,/);
  assert.match(domExtract, /postAnchorSuffixDepth/);
  assert.match(domExtract, /return \{ createDomExtract \}/);
  assert.match(legacyDiscussionDom, /return \{ createLegacyDiscussionDom \}/);
  assert.match(legacyDiscussionData, /return \{ createLegacyDiscussionData \}/);
  assert.match(pageCapture, /return \{ createPageCapture \}/);
  assert.equal(fs.existsSync(path.join(root, "content/legacy-discussion.js")), false);
  assert.doesNotMatch(content, /ensureDiscussionQuickButton|DISCUSSION_CAPTURE_MARKER|保存目前討論/);
  assert.doesNotMatch(readFile("background.js"), /isLegacyDiscussionCapture/);
  assert.doesNotMatch(content, /discussionQuickButton/);
  assert.doesNotMatch(content, /let captureMode/);
  assert.doesNotMatch(content, /captureModeRelationshipCache/);
  assert.match(content, /DomScope\.resetCache\(\)/);
  assert.doesNotMatch(content, /postScopeCache\s*=/);
});

test("介面程式使用的 ID 都存在於對應 HTML", () => {
  const pairs = [
    ["pages/popup/popup.js", "pages/popup/popup.html"],
    ["pages/options/options.js", "pages/options/options.html"]
  ];
  for (const [scriptFile, htmlFile] of pairs) {
    const script = read(scriptFile);
    const html = read(htmlFile);
    const ids = new Set(
      [...script.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1])
    );

    if (scriptFile === "pages/popup/popup.js") {
      const listMatch = script.match(/for \(const id of \[([\s\S]*?)\]\)/);
      for (const match of listMatch?.[1]?.matchAll(/["']([^"']+)["']/g) ?? []) ids.add(match[1]);
    }

    for (const id of ids) {
      if (!/^[a-z][a-z0-9-]+$/.test(id)) continue;
      assert.match(html, new RegExp(`id=["']${id}["']`), `${scriptFile} 使用的 #${id} 不在 ${htmlFile}`);
    }
  }
});

test("HTML 不載入遠端程式碼", () => {
  for (const file of ["pages/popup/popup.html", "pages/options/options.html"]) {
    const html = read(file);
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
    assert.doesNotMatch(html, /on(?:click|load|error)\s*=/i);
  }
});

test("設定頁分開 Notion 連線與整理庫，且沒有捲動收集設定", () => {
  const options = read("pages/options/options.html");
  const background = read("background.js");
  assert.match(options, /id="test-notion-auth"/);
  assert.match(options, /id="connect-archive"/);
  assert.match(options, /id="create-archive"/);
  assert.match(options, /Notion 資料庫網址/);
  assert.match(options, /已授權的空白頁面網址/);
  assert.doesNotMatch(options, /Threads 收集設定|target-handle|捲動收集/);
  assert.match(background, /case "TEST_NOTION_AUTH"/);
  assert.match(background, /resolveArchiveTarget/);
  assert.match(background, /extractNotionDatabaseId/);
  assert.match(background, /\/v1\/databases\/\$\{databaseIdFromUrl\}/);
});

test("Manifest 只要求 Notion 與 Plurk Paste 的連線，圖片網站不需要權限", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(manifest.version, "0.5.0");
  assert.equal(manifest.version, packageJson.version);
  assert.ok(manifest.host_permissions.includes("https://api.notion.com/*"));
  assert.equal(manifest.host_permissions.some(host => /cdninstagram|fbcdn|fbsbx|twimg|images\.plurk/.test(host)), false);
});

test("最近紀錄提供同步與清除功能", () => {
  const popup = read("pages/popup/popup.html");
  const background = read("background.js");
  assert.match(popup, /id="sync-notion"/);
  assert.match(popup, /id="clear-recent"/);
  assert.match(background, /case "SYNC_NOTION_STATE"/);
  assert.match(background, /case "CLEAR_RECENT"/);
});

test("單篇擷取與入列由背景服務完成，不依賴彈出視窗持續開啟", () => {
  const popup = read("pages/popup/popup.js");
  const background = read("background.js");
  assert.match(popup, /type:\s*"CAPTURE_ACTIVE_THREAD"/);
  assert.match(background, /case "CAPTURE_ACTIVE_THREAD"/);
  assert.match(background, /async function captureActiveThread/);
  assert.match(background, /enqueueCaptures\(\[capture\]/);
});

test("已存在的單篇文章會在完整擷取前由本機索引快速略過", () => {
  const popup = read("pages/popup/popup.js");
  const background = read("background.js");
  const dedupe = read("model/dedupe-key.js");
  const captureFunction = background.slice(
    background.indexOf("async function captureActiveThread"),
    background.indexOf("async function preflightActiveThreadFromLocalState")
  );
  assert.match(dedupe, /function localPostCaptureStatus/);
  assert.match(captureFunction, /preflightActiveThreadFromLocalState\(tab\.url\)/);
  assert.ok(
    captureFunction.indexOf("preflightActiveThreadFromLocalState")
      < captureFunction.indexOf('type: "CAPTURE_CURRENT_THREAD"')
  );
  assert.match(popup, /這篇已經保存過了；內容有變動時可以按「更新 Notion 頁面」/);
  assert.match(popup, /這篇正在等待同步/);
  assert.match(popup, /這篇在失敗項目中/);
});

test("擷取只使用驗證過的貼文容器且不退回整頁第一個候選", () => {
  const content = read("content/threads-content.js");
  const background = read("background.js");
  assert.match(content, /choosePostCandidate/);
  assert.match(content, /captureValidation/);
  assert.doesNotMatch(content, /rootContainer\s*\|\|=\s*containers\[0\]/);
  assert.match(background, /assertCaptureIntegrity/);
});

test("讀者留言與作者回覆讀者都不標記，只保留作者自己的補充", () => {
  const content = read("content/threads-content.js");
  const shared = read("lib/shared.js");
  const pageBuilder = readFile("notion/page-builder.js");
  assert.doesNotMatch(content, /expandConversationReplies/);
  assert.doesNotMatch(content, /REPLY_EXPANSION_PATTERN/);
  assert.doesNotMatch(content, /readerContext/);
  assert.doesNotMatch(content, /hasReplyCount/);
  assert.doesNotMatch(content, /REPLY_COUNT_PATTERN/);
  assert.doesNotMatch(content, /hasAuthorReplyToReader/);
  assert.doesNotMatch(shared, /hasAuthorReplyToReader|"作者回覆"/);
  assert.match(content, /isDirectAuthorSupplement/);
  assert.match(shared, /function isDirectAuthorSupplement/);
  assert.match(content, /authorReplies/);
  assert.doesNotMatch(pageBuilder, /reviewItems/);
  assert.doesNotMatch(content, /\^\(\?:熱門\|推薦/);
});

test("作者續文只接受明確串文序號並保留位置", () => {
  const content = read("content/threads-content.js");
  assert.match(content, /rootPosition/);
  assert.match(content, /threadPosition/);
  assert.match(content, /orderThreadEntries/);
  assert.match(content, /findLongTextControls\(container\)\.length/);
  assert.doesNotMatch(content, /collectAdjacentContinuations/);
});

test("長文型續文可由目前頁面的結構化資料補回", () => {
  const content = read("content/threads-content.js");
  const shared = read("lib/shared.js");
  const captureModel = read("model/capture-model.js");
  assert.match(content, /buildStructuredContinuationRecords/);
  assert.match(content, /structuredThreadEntries/);
  assert.match(content, /extractStructuredPostText/);
  assert.match(content, /extractStructuredThreadPosition/);
  assert.match(shared, /snippet_attachment_info/);
  assert.match(shared, /self_thread_info/);
  assert.match(content, /mergeStructuredRootEntry/);
  assert.match(content, /source:\s*"page-json"/);
  assert.match(captureModel, /validStructuredSource/);
});

test("結構化 2/N 不會同時被當成無編號作者補充", () => {
  const content = read("content/threads-content.js");
  assert.match(content, /const relationship = options\.relationshipByPostId\?\.get\(parsed\.postId\)/);
  assert.match(content, /S\.parseThreadPosition\(relationship\?\.threadPosition\)/);
  assert.match(content, /const continuationPostIds = new Set/);
  assert.match(content, /continuationPostIds\.has\(postId\)/);
});

test("主題可用貼文時間連結作為作者資訊列參照", () => {
  const content = read("content/threads-content.js");
  assert.match(content, /function findPostHeaderAnchor/);
  assert.match(content, /function topicTagBeforeReference/);
  assert.match(content, /function topicTagFromLink/);
});

test("發布時間只讀取同一貼文編號的標準 datetime", () => {
  const domExtract = readFile("content/dom-extract.js");
  const ownTime = domExtract.match(/function ownTimeElement\([^)]*\) \{([\s\S]*?)\n    \}\n\n(?:    \/\*\*[\s\S]*?\*\/\n)?    function stripTopicTagFromText/)?.[1] ?? "";
  assert.match(ownTime, /const postId = scope\?\.postId/);
  assert.match(ownTime, /\[container, timeline, document\]/);
  assert.match(ownTime, /findPostHeaderAnchor\(root, postId\)/);
  assert.match(ownTime, /querySelector\("time\[datetime\]"\)/);
  assert.doesNotMatch(ownTime, /time\[datetime\], time/);
  assert.doesNotMatch(ownTime, /textContent/);
});

test("使用者無法觸發覆寫既有 Notion 頁面的更新", () => {
  const background = read("background.js");
  const popup = read("pages/popup/popup.js");
  const popupHtml = read("pages/popup/popup.html");
  const queue = readFile("queue/retry.js");
  const repository = readFile("notion/repository.js");
  assert.doesNotMatch(popupHtml, /id="refresh-thread"|更新目前文章/);
  assert.doesNotMatch(popup, /replaceExisting|refreshCurrentThread|updateCompleted/);
  assert.doesNotMatch(background, /Boolean\(message\.replaceExisting\)|replaceExisting:/);
  assert.doesNotMatch(background, /waitForCaptureCompletion|updateCompleted/);
  assert.doesNotMatch(queue, /replaceExisting/);
  assert.match(queue, /current\.repairPartialPage = true/);
  assert.match(repository, /if \(existing && saveOptions\.repairPartialPage\)/);
  assert.doesNotMatch(repository, /saveOptions\.replaceExisting/);
});

test("成功提示不顯示未確認的長文警告或零個附件", () => {
  const popup = read("pages/popup/popup.js");
  const background = read("background.js");
  assert.doesNotMatch(popup.match(/function captureLongTextSummary[\s\S]*?\n\}/)?.[0] ?? "", /longTextDiagnostics/);
  assert.doesNotMatch(background.match(/function captureDiagnosticsSummary[\s\S]*?\n\}/)?.[0] ?? "", /longTextDiagnostics/);
  assert.doesNotMatch(popup, /取得 \$\{details\.count\} 個長文附件/);
});

test("頁面 Icon 取自來源網站，更新文章不會覆蓋既有 Icon", () => {
  const pageBuilder = readFile("notion/page-builder.js");
  const createBody = pageBuilder.match(/function createPagePayload[\s\S]*?\n    \}/)?.[0] ?? "";
  const updateBody = pageBuilder.match(/function updatePagePayload[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(createBody, /payload\.icon/);
  assert.doesNotMatch(updateBody, /icon:/);
});

test("設定頁不再提供主題 Icon 規則", () => {
  const options = read("pages/options/options.html");
  const background = read("background.js");
  assert.doesNotMatch(options, /icon-rules|emoji-picker|emoji-data/);
  assert.equal(fs.existsSync(path.join(root, "pages/options/emoji-data.js")), false);
  assert.doesNotMatch(background, /ICON_TOPICS|APPLY_ICON_RULES/);
  assert.match(options, /<h1>Savour<\/h1>\s*<p class="intro">先存再說、之後要讀卻找不到？按一下存進自己的 Notion，有空再慢慢消化資訊。<\/p>/);
  assert.doesNotMatch(options, /連接或建立 Notion 整理庫<\/h1>/);
});

test("本機索引仍記錄已保存的作者回覆編號", () => {
  const queue = readFile("queue/retry.js");
  assert.match(queue, /authorReplyPostIds/);
});

test("連接整理庫時以欄位對照表認欄位，類型不符時停止", () => {
  const archive = read("background/archive.js");
  assert.match(archive, /N\.resolveColumnMap\(/);
  assert.match(archive, /請先修正欄位類型後再測試連線/);
});

test("已移除沒有呼叫來源的訊息分支", () => {
  const background = read("background.js");
  const content = read("content/threads-content.js");
  for (const type of ["PROCESS_QUEUE", "OPEN_OPTIONS", "CONTENT_CAPTURED"]) {
    assert.doesNotMatch(background, new RegExp(`case ["']${type}["']`));
  }
  assert.doesNotMatch(content, /case ["']CAPTURE_VISIBLE["']/);
});

test("來源網址會排除長文附件路徑", () => {
  const shared = read("lib/shared.js");
  assert.match(shared, /const postPath = parsed\.pathname\.match/);
});

test("長文只能附加且不得刪除主貼文正文", () => {
  const content = read("content/threads-content.js");
  const enrich = content.match(
    /async function enrichWithLongText\([^)]*entry[^)]*,[\s\S]*?\n  \}\n\n  function findContainerByPostUrl/
  )?.[0] ?? "";
  assert.doesNotMatch(content, /stripAttachmentPreviews/);
  assert.doesNotMatch(enrich, /entry\.text\s*=/);
  assert.match(enrich, /refreshedContainer/);
});

test("貼文範圍會排除引用貼文子樹並只保留引用連結", () => {
  const content = read("content/threads-content.js");
  const shared = read("lib/shared.js");
  const pageBuilder = readFile("notion/page-builder.js");
  assert.match(content, /findEmbeddedPostRoots/);
  assert.match(content, /isNestedEmbeddedPostContainer/);
  assert.match(content, /excludedPostIds/);
  assert.match(content, /excludedRoots/);
  assert.match(content, /extractQuotedPosts/);
  assert.match(shared, /extractStructuredQuotedPosts/);
  assert.match(content, /quotedPosts/);
  assert.match(pageBuilder, /addQuotedPostLinks/);
  assert.match(pageBuilder, /link:\s*\{ url:/);
});

test("手動長文容許附件視窗暫時改變網址並重新取得貼文容器", () => {
  const content = read("content/threads-content.js");
  assert.match(content, /createManualCaptureGuard/);
  assert.match(content, /missingSince/);
  assert.match(content, /findContainerByPostUrl\(sourceUrl\)/);
  assert.doesNotMatch(content, /captureSessionActive/);
});

test("最近紀錄使用細圓角捲軸", () => {
  const popupCss = read("pages/popup/popup.css");
  assert.match(popupCss, /\.recent-list::-webkit-scrollbar-thumb/);
  assert.match(popupCss, /scrollbar-width:\s*thin/);
  assert.match(popupCss, /overflow-x:\s*hidden/);
});

test("批次捲動收集已移除且不可重現", () => {
  assert.equal(fs.existsSync(path.join(root, "content/legacy-scroll.js")), false);
  const manifest = JSON.parse(readFile("manifest.json"));
  assert.equal(manifest.content_scripts.some(entry => entry.js.includes("content/legacy-scroll.js")), false);
  const files = ["content/threads-content.js", "content/page-capture.js", "background.js", "pages/popup/popup.js", "pages/popup/popup.html", "pages/options/options.html", "pages/options/options.js", "content/content.css", "pages/popup/popup.css", "lib/shared.js"];
  for (const file of files) {
    assert.doesNotMatch(
      readFile(file),
      /START_CAPTURE_MODE|STOP_CAPTURE_MODE|GET_CAPTURE_MODE|runAutoCaptureLoop|AUTO_SCROLL_STEP_RATIO|threadkeeper-toolbar|ThreadKeeperLegacyScroll|SavourLegacyScroll|toggle-auto-capture-mode|toggle-capture-mode|capture-progress|window\.scrollTo/,
      `${file} 不可包含批次捲動收集程式`
    );
  }
});

test("頁面監看只在使用者觸發擷取期間啟用", () => {
  const content = readFile("content/threads-content.js");
  assert.match(content, /startCaptureObserver\(\);\s*try \{\s*return await runMessage\(message\);\s*\} finally \{\s*stopCaptureObserver\(\);/);
  assert.doesNotMatch(content, /if \(!NODE_TEST_RUNTIME\) \{\s*observer\.observe/);
});

test("保存時不會在背景重新下載 Threads 頁面", () => {
  const files = ["content/threads-content.js", "content/page-capture.js", "content/legacy-discussion-data.js", "content/legacy-discussion-dom.js", "content/dom-scope.js", "content/dom-extract.js"];
  for (const file of files) {
    const source = readFile(file);
    assert.doesNotMatch(source, /collectDiscussionEntriesFromFreshHtml|FETCH-JSON|DOMParser/, `${file} 不可重新下載 Threads 頁面`);
    assert.doesNotMatch(source, /\bfetch\(/, `${file} 不可在頁面內發出網路請求`);
  }
  const pageCapture = readFile("content/page-capture.js");
  assert.match(pageCapture, /collectCurrentThreadRelationshipEntries\(\)/);
  assert.match(pageCapture, /這頁沒有讀到串文結構資料/);
});

test("網站權限只列出有用途的網域", () => {
  const manifest = JSON.parse(readFile("manifest.json"));
  assert.deepEqual(manifest.host_permissions, [
    "https://paste.plurk.com/*",
    "https://api.notion.com/*"
  ]);
  // Other sites are read only when the user saves from them (activeTab + scripting). Their images are
  // imported by Notion itself, so no all-sites permission is requested, not even an optional one.
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(JSON.stringify(manifest).includes("*://*/*"), false);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.equal(JSON.stringify(manifest.content_scripts).includes("<all_urls>"), false);
});

test("右鍵選單與快捷鍵說明不寫平台名稱，且在所有網頁都可使用", () => {
  const manifest = JSON.parse(readFile("manifest.json"));
  const background = readFile("background.js");
  const menuTitles = [...background.matchAll(/title: S\.t\("([^"]+)"\)|title: "([^"]+)"/g)].map(match => match[1] ?? match[2]);
  assert.ok(menuTitles.includes("將選取文字保存到 Notion"));
  assert.ok(menuTitles.includes("保存目前頁面到 Notion"));
  assert.equal(manifest.commands["capture-post"].suggested_key.default, "Alt+S");
  assert.equal(manifest.commands["save-selection"].suggested_key, undefined);
  for (const title of menuTitles) assert.doesNotMatch(title, /Threads|噗浪|Plurk|\bX\b/);
  assert.match(background, /const PAGE_PATTERNS = \["http:\/\/\*\/\*", "https:\/\/\*\/\*"\]/);
  assert.doesNotMatch(background, /THREADS_PATTERNS/);
  for (const command of Object.values(manifest.commands)) {
    assert.doesNotMatch(command.description, /Threads|噗浪/);
  }
});

test("彈出視窗的選取文字有「存成新頁面」與「加入現有頁面」兩個按鈕", () => {
  const html = readFile("pages/popup/popup.html");
  const script = readFile("pages/popup/popup.js");
  assert.match(html, /<span class="selection-label">保存目前選取文字<\/span>[\s\S]*id="save-selection">存成新頁面<\/button>[\s\S]*id="append-selection">加入現有頁面<\/button>/);
  assert.match(script, /type: "PREPARE_APPEND_PICKER"/);
  assert.match(script, /location\.replace\(`\.\.\/picker\/picker\.html#\$\{token\}`\)/);
});

test("一般網頁的擷取程式只在使用者保存時注入，且注入的檔案都存在", () => {
  const background = readFile("background.js");
  const files = [...background.match(/const INJECTED_SCRIPTS = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(files, [
    "i18n/en.js",
    "i18n/index.js",
    "lib/shared.js",
    "content/toast.js",
    "vendor/readability/Readability.js",
    "content/web-article.js",
    "content/x-capture.js",
    "content/youtube-capture.js",
    "content/linkedin-capture.js",
    "content/facebook-capture.js",
    "content/web-content.js"
  ]);
  for (const file of files) assert.equal(fs.existsSync(path.join(root, file)), true, `${file} 不存在`);
  assert.match(background, /js: site\?\.js \?\? INJECTED_SCRIPTS, css: \["content\/content\.css"\]/);
  assert.match(background, /chrome\.scripting\.executeScript\(\{ target: \{ tabId: tab\.id \}, files: files\.js \}\)/);
  assert.match(readFile("content/web-content.js"), /if \(globalThis\.__savourWebContentAlive\?\.\(\)\) return;/);
  assert.equal(fs.existsSync(path.join(root, "vendor/readability/LICENSE.md")), true);
});

test("選擇加入頁面的選單是擴充功能自己的視窗，網站讀不到 Notion 頁面標題", () => {
  const manifest = JSON.parse(readFile("manifest.json"));
  const background = readFile("background.js");
  // No content script draws archive titles into a website any more.
  assert.equal(fs.existsSync(path.join(root, "content/append-picker.js")), false);
  for (const entry of manifest.content_scripts) {
    assert.equal(entry.js.some(file => /picker/.test(file)), false);
  }
  for (const file of ["content/threads-content.js", "content/plurk-content.js", "content/instagram-content.js", "content/web-content.js"]) {
    assert.doesNotMatch(readFile(file), /OPEN_APPEND_PICKER|attachShadow|SAVE_SELECTION_TO_TARGET|SEARCH_APPEND_TARGETS/, file);
  }
  // The picker page is not reachable from websites.
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.match(background, /chrome\.windows\.create\(\{\s*url: chrome\.runtime\.getURL\(`\$\{PICKER_PAGE\}#\$\{token\}`\)/);
  assert.match(background, /case "PICKER_CHOOSE":\s*assertPickerPage\(sender\);/);
  assert.match(readFile("pages/picker/picker.html"), /<script src="picker\.js"><\/script>/);
});

test("擴充功能圖示四種尺寸都存在且尺寸正確", () => {
  const manifest = JSON.parse(readFile("manifest.json"));
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(path.join(root, file));
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", `${file} 不是 PNG`);
    assert.equal(png.readUInt32BE(16), Number(size), `${file} 寬度不符`);
    assert.equal(png.readUInt32BE(20), Number(size), `${file} 高度不符`);
  }
  assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
  for (const file of Object.values(manifest.action.default_icon)) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} 不存在`);
  }
});

test("名稱與說明有英文與正體中文兩種語系，manifest 引用的訊息都存在，說明不超過 132 字", () => {
  const manifest = JSON.parse(readFile("manifest.json"));
  assert.equal(manifest.default_locale, "en");
  const used = JSON.stringify(manifest).match(/__MSG_(\w+)__/g).map(item => item.slice(6, -2));
  assert.ok(used.includes("extName") && used.includes("extDescription"));
  for (const locale of ["en", "zh_TW"]) {
    const messages = JSON.parse(readFile(`_locales/${locale}/messages.json`));
    for (const key of used) assert.ok(messages[key]?.message, `${locale} 缺少 ${key}`);
    assert.ok(messages.extDescription.message.length <= 132, `${locale} 說明超過 132 字`);
    assert.equal(messages.extName.message, "Savour");
  }
  assert.match(JSON.parse(readFile("_locales/zh_TW/messages.json")).extDescription.message, /^先存再說、之後要讀卻找不到？/);
  const listing = readFile("store/listing.md");
  for (const locale of ["en", "zh_TW"]) {
    assert.ok(listing.includes(JSON.parse(readFile(`_locales/${locale}/messages.json`)).extDescription.message), `${locale} 簡短說明與 store/listing.md 不一致`);
  }
  assert.match(JSON.parse(readFile("_locales/en/messages.json")).extDescription.message, /^Save now\. Savour later\./);
});
