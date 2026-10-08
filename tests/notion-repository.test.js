"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createNotionRepository } = require("../notion/repository.js");

function capture(overrides = {}) {
  return {
    captureType: "post",
    sourceUrl: "https://www.threads.com/@example/post/ABC123",
    dedupeKey: "tsc:ABC123",
    shortcode: "ABC123",
    threadsMediaId: "",
    text: "測試內容",
    media: [],
    continuations: [],
    authorReplies: [],
    reviewFlags: [],
    ...overrides
  };
}

function createHarness(overrides = {}) {
  const calls = [];
  const sleeps = [];
  const forms = [];
  const shared = {
    parseThreadsUrl: value => ({ postId: String(value).match(/\/post\/([^/?#]+)/)?.[1] ?? "" }),
    hashString: () => "hash",
    isPrivateNetworkHost: require("../lib/shared.js").isPrivateNetworkHost,
    normalizeReviewFlags: values => [...new Set(values.filter(Boolean))],
    sleep: async value => sleeps.push(value),
    ...overrides.shared
  };
  const notion = {
    queryByCaptureKeyPayload: key => ({ captureKey: key }),
    buildPageChildren: () => [{ type: "paragraph" }],
    createPagePayload: (_capture, dataSourceId, options) => ({ dataSourceId, options }),
    savedRecordFromPage: page => ({ key: page.captureKey ?? "", value: page.record ?? {} }),
    updatePagePayload: () => ({ update: true }),
    chunkBlocks: blocks => {
      const chunks = [];
      for (let index = 0; index < blocks.length; index += 100) chunks.push(blocks.slice(index, index + 100));
      return chunks;
    },
    contentRangeFromPage: () => null,
    contentRangePayload: (first, last) => ({ properties: { range: `${first}..${last}` } }),
    refreshPagePropertiesPayload: () => ({ properties: { refreshed: true } }),
    previousVersionNoticeBlocks: () => [{ type: "callout" }],
    ...overrides.notion
  };
  const notionRequest = overrides.notionRequest ?? (async (requestPath, requestOptions) => {
    calls.push({ path: requestPath, options: requestOptions });
    if (requestPath.endsWith("/query")) return { results: [] };
    if (requestPath === "/v1/pages") return { id: "created-page" };
    return {};
  });
  const repository = createNotionRepository({
    shared,
    notion,
    notionRequest,
    captureEntries: value => [value, ...(value.continuations ?? []), ...(value.authorReplies ?? [])],
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error("不應下載圖片"); }),
    mediaStage: overrides.mediaStage,
    imageTimeoutMs: overrides.imageTimeoutMs,
    importPollDelaysMs: overrides.importPollDelaysMs,
    cloneCapture: value => structuredClone(value),
    createFormData: () => {
      const form = { values: [], append(...args) { this.values.push(args); } };
      forms.push(form);
      return form;
    }
  });
  return { repository, calls, sleeps, forms };
}

test("完全相符的既有頁面會直接去重且不準備媒體", async () => {
  const calls = [];
  const existing = { id: "existing-page" };
  const { repository } = createHarness({
    notionRequest: async (requestPath, options) => {
      calls.push({ path: requestPath, options });
      return { results: [existing] };
    }
  });

  assert.deepEqual(
    await repository.saveCaptureToNotion(capture(), "source", "token"),
    { ...existing, duplicateFoundInNotion: true }
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.body, { captureKey: "tsc:ABC123" });
});

test("既有頁面即使傳入 replaceExisting 也只會略過，不清空內容也不追加區塊", async () => {
  const requests = [];
  const existing = { id: "existing-page", captureKey: "tsc:ABC123" };
  const { repository } = createHarness({
    notionRequest: async (requestPath, options) => {
      requests.push({ path: requestPath, options });
      if (requestPath.endsWith("/query")) return { results: [existing] };
      throw new Error(`不應寫入 Notion：${requestPath}`);
    }
  });

  const result = await repository.saveCaptureToNotion(capture(), "source", "token", { replaceExisting: true });

  assert.equal(result.duplicateFoundInNotion, true);
  assert.equal(result.updatedExisting, undefined);
  assert.equal(requests.some(item => item.options?.method === "PATCH"), false);
  assert.equal(requests.some(item => item.path.includes("/children")), false);
});

test("媒體上傳會保留成功檔案並將失敗項目標成需複核", async () => {
  let downloadCount = 0;
  const requests = [];
  const { repository, sleeps, forms } = createHarness({
    fetchImpl: async () => {
      downloadCount += 1;
      if (downloadCount === 2) return { ok: false, status: 403 };
      const blob = new Blob(["image"], { type: "image/png" });
      return { ok: true, blob: async () => blob, headers: { get: () => "image/png" } };
    },
    notionRequest: async (requestPath, options) => {
      requests.push({ path: requestPath, options });
      if (requestPath === "/v1/file_uploads") return { id: "upload-id" };
      if (requestPath.endsWith("/send")) return { status: "uploaded" };
      throw new Error(`未預期的 request：${requestPath}`);
    }
  });
  const original = capture({ media: [
    { url: "https://cdn.example/one.png" },
    { url: "https://cdn.example/two.png" }
  ] });

  const prepared = await repository.prepareCaptureMedia(original, "token");
  assert.equal(original.media[0].notionFileId, undefined);
  assert.equal(prepared.media[0].notionFileId, "upload-id");
  assert.equal(prepared.media[1].notionFileId, undefined);
  assert.deepEqual(prepared.mediaUploadSummary, { detected: 2, uploaded: 1, failed: 1 });
  assert.equal(prepared.mediaDiagnostics.detected, 2);
  assert.equal(prepared.mediaDiagnostics.captured, 1);
  assert.match(prepared.mediaDiagnostics.warnings[0], /圖片 2 未能保存：圖片下載失敗 403/);
  assert.ok(prepared.reviewFlags.includes("圖片未完整"));
  assert.equal(requests.length, 2);
  assert.equal(forms[0].values[0][2], "threads-ABC123-01.png");
  assert.deepEqual(sleeps, [250, 250]);
});

test("超過一百個區塊時建立頁面後會分批附加剩餘內容", async () => {
  const children = Array.from({ length: 101 }, (_, index) => ({ index }));
  const { repository, calls } = createHarness({
    notion: { buildPageChildren: () => children }
  });

  const saved = await repository.saveCaptureToNotion(capture(), "source", "token");
  assert.equal(saved.id, "created-page");
  assert.deepEqual(saved.mediaUploadSummary, { detected: 0, uploaded: 0, failed: 0 });
  assert.deepEqual(calls.map(item => item.path), [
    "/v1/data_sources/source/query",
    "/v1/pages",
    "/v1/blocks/created-page/children",
    "/v1/blocks/created-page/children?page_size=100"
  ]);
  assert.equal(calls[1].options.body.options.children.length, 100);
  assert.deepEqual(calls[2].options.body.children, [{ index: 100 }]);
});

test("瀏覽器環境會建立 Notion repository factory global", () => {
  const context = {};
  const source = fs.readFileSync(path.join(__dirname, "..", "notion/repository.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "notion/repository.js" });
  assert.equal(typeof context.SavourNotionRepository?.createNotionRepository, "function");
});

function pageWithFlags(flags) {
  return {
    id: "thread-page",
    captureKey: "tsc:ABC123",
    record: { reviewItems: flags }
  };
}

function appendHarness(existingPage, pageBlocks) {
  const requests = [];
  const { repository } = createHarness({
    shared: { parseThreadPosition: require("../lib/shared.js").parseThreadPosition },
    notion: {
      savedThreadPositions: blocks => new Set(blocks.map(block => block.position)),
      buildContinuationBlocks: entries => entries.map(entry => ({ appended: entry.threadPosition }))
    },
    notionRequest: async (requestPath, options) => {
      requests.push({ path: requestPath, options });
      if (requestPath.endsWith("/query")) return { results: [existingPage] };
      if (requestPath.startsWith("/v1/blocks/thread-page/children?")) return { results: pageBlocks, has_more: false };
      if (requestPath === "/v1/blocks/thread-page/children") return {};
      throw new Error(`未預期的 request：${requestPath}`);
    }
  });
  return { repository, requests };
}

test("補完串文只在頁面最後追加缺少的段落，不改動頁面欄位", async () => {
  const { repository, requests } = appendHarness(pageWithFlags(["串文未完整", "作者回覆"]), [{ position: 1 }, { position: 2 }]);
  const result = await repository.saveCaptureToNotion(capture({
    threadPosition: "1/3",
    continuations: [
      { text: "第二段", threadPosition: "2/3", media: [] },
      { text: "第三段", threadPosition: "3/3", media: [] }
    ]
  }), "source", "token", { appendMissing: true });

  const appends = requests.filter(item => item.path === "/v1/blocks/thread-page/children");
  assert.equal(appends.length, 1);
  assert.equal(appends[0].options.method, "PATCH");
  assert.deepEqual(appends[0].options.body.children, [{ appended: "3/3" }]);
  assert.equal(requests.some(item => item.options?.body?.erase_content || item.path === "/v1/pages" ), false);
  assert.equal(requests.some(item => item.path === "/v1/pages/thread-page"), false);
  assert.equal(result.appendedContinuations, 1);
  assert.equal(result.duplicateFoundInNotion, true);
});

test("頁面已有全部段落時不追加任何內容", async () => {
  const { repository, requests } = appendHarness(pageWithFlags(["串文未完整"]), [{ position: 1 }, { position: 2 }]);
  const result = await repository.saveCaptureToNotion(capture({
    threadPosition: "1/3",
    reviewFlags: ["串文未完整"],
    continuations: [{ text: "第二段", threadPosition: "2/3", media: [] }]
  }), "source", "token", { appendMissing: true });

  assert.equal(requests.some(item => item.path === "/v1/blocks/thread-page/children"), false);
  assert.equal(requests.some(item => item.path === "/v1/pages/thread-page"), false);
  assert.equal(result.appendedContinuations, 0);
});

function imageHarness(fetchImpl, extra = {}) {
  const requests = [];
  const harness = createHarness({
    fetchImpl,
    ...extra,
    notionRequest: async (requestPath, options) => {
      requests.push({ path: requestPath, options });
      if (requestPath === "/v1/file_uploads") return { id: "upload-id" };
      if (requestPath.endsWith("/send")) return { status: "uploaded" };
      throw new Error(`未預期的 request：${requestPath}`);
    }
  });
  return { ...harness, requests };
}

function streamResponse(chunks, headers = {}) {
  let index = 0;
  let cancelled = false;
  return {
    ok: true,
    status: 200,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        async read() {
          return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
        },
        async cancel() {
          cancelled = true;
        }
      })
    },
    wasCancelled: () => cancelled,
    readCount: () => index
  };
}

test("圖片超過 20 MB 時邊下載邊中止，不會先讀完整個檔案", async () => {
  const chunk = new Uint8Array(4 * 1024 * 1024);
  const response = streamResponse(Array.from({ length: 50 }, () => chunk), { "content-type": "image/jpeg" });
  const { repository } = imageHarness(async () => response);
  const prepared = await repository.prepareCaptureMedia(capture({ media: [{ url: "https://cdn.example/huge.jpg" }] }), "token");
  assert.match(prepared.mediaDiagnostics.warnings[0], /超過 20 MB/);
  assert.equal(response.wasCancelled(), true);
  assert.ok(response.readCount() <= 6);
});

test("伺服器宣告的大小超過上限時不讀取內容", async () => {
  const response = streamResponse([new Uint8Array(10)], { "content-type": "image/png", "content-length": String(30 * 1024 * 1024) });
  const { repository } = imageHarness(async () => response);
  const prepared = await repository.prepareCaptureMedia(capture({ media: [{ url: "https://cdn.example/big.png" }] }), "token");
  assert.match(prepared.mediaDiagnostics.warnings[0], /超過 20 MB/);
  assert.equal(response.readCount(), 0);
});

test("圖片下載逾時會中止並記為未完整，不會卡住保存佇列", async () => {
  const { repository } = imageHarness((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }), { imageTimeoutMs: 20 });
  const prepared = await repository.prepareCaptureMedia(capture({ media: [{ url: "https://cdn.example/slow.jpg" }] }), "token");
  assert.match(prepared.mediaDiagnostics.warnings[0], /圖片下載逾時/);
  assert.ok(prepared.reviewFlags.includes("圖片未完整"));
});

test("串流讀完的圖片照常上傳", async () => {
  const response = streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])], { "content-type": "image/png; charset=binary" });
  const { repository, forms } = imageHarness(async () => response);
  const prepared = await repository.prepareCaptureMedia(capture({ media: [{ url: "https://cdn.example/ok.png" }] }), "token");
  assert.equal(prepared.media[0].notionFileId, "upload-id");
  assert.equal(forms[0].values[0][1].size, 3);
  assert.equal(forms[0].values[0][1].type, "image/png");
});

test("保存當下從頁面讀到的圖片直接上傳，不再自己下載；寫入 Notion 後才從暫存刪除", async () => {
  const removed = [];
  const stage = {
    async get(key) { return key === "stagedkey1" ? new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" }) : null; },
    async removeMany(keys) { removed.push(...keys); }
  };
  const { repository, forms } = imageHarness(async () => { throw new Error("已暫存的圖片不應再下載"); }, {
    mediaStage: stage
  });
  const staged = capture({ media: [{ url: "https://cdn.example/a.jpg" }], stagedImages: { "https://cdn.example/a.jpg": "stagedkey1" } });
  const prepared = await repository.prepareCaptureMedia(staged, "token");
  assert.equal(prepared.media[0].notionFileId, "upload-id");
  assert.equal(forms[0].values[0][1].size, 4);
  assert.equal(forms[0].values[0][1].type, "image/webp");
  assert.deepEqual(removed, []);
});

test("保存成功後，這則貼文的暫存圖片才會被刪除", async () => {
  const removed = [];
  const { repository } = createHarness({ mediaStage: { async get() { return null; }, async removeMany(keys) { removed.push(...keys); } } });
  await repository.saveCaptureToNotion(capture({ stagedImages: { "https://cdn.example/a.jpg": "stagedkey1", "https://cdn.example/b.jpg": "stagedkey2" } }), "source", "token");
  assert.deepEqual(removed, ["stagedkey1", "stagedkey2"]);
});

test("暫存裡找不到的圖片會退回自己下載，不會讓保存中斷", async () => {
  const stage = { async get() { return null; }, async removeMany() {} };
  const response = streamResponse([new Uint8Array([9])], { "content-type": "image/png" });
  const { repository } = imageHarness(async () => response, { mediaStage: stage });
  const prepared = await repository.prepareCaptureMedia(
    capture({ media: [{ url: "https://cdn.example/gone.png" }], stagedImages: { "https://cdn.example/gone.png": "missingkey1" } }),
    "token"
  );
  assert.equal(prepared.media[0].notionFileId, "upload-id");
});

function webCapture(url, sourceUrl = "https://news.example.com/story") {
  return capture({ platform: "web", sourceUrl, dedupeKey: `web:${sourceUrl}`, media: [{ url }] });
}

function importHarness({ statuses = {}, rejectCreate = false } = {}) {
  const requests = [];
  const harness = createHarness({
    importPollDelaysMs: [1, 1],
    fetchImpl: async () => { throw new Error("網頁圖片由 Notion 匯入，擴充功能不應自己下載"); },
    notionRequest: async (requestPath, options) => {
      requests.push({ path: requestPath, options });
      if (requestPath === "/v1/file_uploads") {
        if (rejectCreate) throw new Error("validation_error");
        return { id: `import-${requests.filter(item => item.path === "/v1/file_uploads").length}` };
      }
      const id = requestPath.split("/").at(-1);
      return { id, status: statuses[id] ?? "uploaded" };
    }
  });
  return { ...harness, requests };
}

test("網頁圖片交給 Notion 從公開網址匯入：不需要擴充功能下載，匯入完成後附上檔案", async () => {
  const { repository, requests } = importHarness();
  const prepared = await repository.prepareCaptureMedia(webCapture("https://img.example.com/photos/a.png?size=large"), "token");
  assert.deepEqual(requests[0].options.body, {
    mode: "external_url",
    external_url: "https://img.example.com/photos/a.png?size=large",
    filename: "web-01.png"
  });
  assert.equal(prepared.media[0].notionFileId, "import-1");
  assert.equal(prepared.media[0].external, undefined);
  assert.deepEqual(prepared.mediaUploadSummary, { detected: 1, uploaded: 1, failed: 0 });
  assert.deepEqual(prepared.reviewFlags, []);
});

test("Notion 匯入失敗、逾時或拒絕時，圖片改為連結原網址，不算圖片未完整", async () => {
  for (const options of [{ statuses: { "import-1": "failed" } }, { statuses: { "import-1": "pending" } }, { rejectCreate: true }]) {
    const { repository } = importHarness(options);
    const prepared = await repository.prepareCaptureMedia(webCapture("https://img.example.com/b.jpg"), "token");
    assert.equal(prepared.media[0].notionFileId, undefined);
    assert.equal(prepared.media[0].external, true);
    assert.deepEqual(prepared.reviewFlags, []);
    assert.deepEqual(prepared.mediaUploadSummary, { detected: 1, uploaded: 0, failed: 0 });
  }
});

test("http 圖片只連結；本機或區域網路的圖片不匯入也不連結；內網文章自己網站的圖片只連結", async () => {
  const { repository, requests } = importHarness();
  const insecure = await repository.prepareCaptureMedia(webCapture("http://img.example.com/c.jpg"), "token");
  assert.equal(insecure.media[0].external, true);
  for (const url of ["http://192.168.1.1/admin.png", "https://localhost:8080/x.png", "https://[::1]/x.png", "https://nas/photo.jpg"]) {
    const prepared = await repository.prepareCaptureMedia(webCapture(url), "token");
    assert.equal(prepared.media[0].blocked, true, url);
    assert.equal(prepared.media[0].external, undefined, url);
  }
  const intranet = await repository.prepareCaptureMedia(webCapture("https://wiki.internal/logo.png", "https://wiki.internal/page"), "token");
  assert.equal(intranet.media[0].external, true);
  assert.deepEqual(requests, []);
});

test("Threads、噗浪、X、Instagram 的圖片仍由擴充功能下載後上傳", async () => {
  const fetched = [];
  const { repository } = imageHarness(async url => {
    fetched.push(url);
    const blob = new Blob(["image"], { type: "image/png" });
    return { ok: true, url, blob: async () => blob, headers: { get: () => "image/png" } };
  });
  const prepared = await repository.prepareCaptureMedia(capture({ media: [{ url: "https://cdn.example/one.png" }] }), "token");
  assert.equal(prepared.media[0].notionFileId, "upload-id");
  assert.deepEqual(fetched, ["https://cdn.example/one.png"]);
});
