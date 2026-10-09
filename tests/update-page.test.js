"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/shared.js");
const N = require("../notion/index.js");
const M = require("../model/capture-model.js");
const { createNotionRepository } = require("../notion/repository.js");

const DATA_SOURCE = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const PAGE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RANGE = N.PROPERTY_NAMES.contentRange;

let nextId = 0;
function blockId() {
  nextId += 1;
  return `00000000-0000-0000-0000-${String(nextId).padStart(12, "0")}`;
}

function textBlock(text, id = blockId()) {
  return { id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text, text: { content: text } }] } };
}

function blockText(block) {
  return (block[block.type]?.rich_text ?? []).map(item => item.plain_text ?? item.text?.content ?? "").join("");
}

// A Notion page held in memory, answering the requests notion/repository.js makes.
// echoFollowing: answer an insert like Notion does, with the new blocks and then every block after them.
function fakeNotion({ blocks, range = null, captureKey = "web:https://blog.example.com/post", echoFollowing = false }) {
  const page = {
    id: PAGE_ID,
    url: "https://www.notion.so/page",
    parent: { data_source_id: DATA_SOURCE },
    properties: {
      [N.PROPERTY_NAMES.captureKey]: { rich_text: [{ plain_text: captureKey }] },
      [N.PROPERTY_NAMES.title]: { title: [{ plain_text: "舊標題" }] },
      [RANGE]: { rich_text: range ? [{ plain_text: `${range[0]}..${range[1]}` }] : [] }
    }
  };
  const state = { page, blocks: [...blocks], requests: [], deleted: [] };
  state.notionRequest = async (requestPath, options) => {
    state.requests.push({ path: requestPath, method: options.method, body: options.body });
    if (requestPath.endsWith("/query")) return { results: [page], has_more: false };
    if (requestPath.startsWith(`/v1/blocks/${PAGE_ID}/children`) && options.method === "GET") {
      return { results: state.blocks, has_more: false };
    }
    if (requestPath === `/v1/blocks/${PAGE_ID}/children` && options.method === "PATCH") {
      const written = options.body.children.map(block => ({ ...block, id: blockId() }));
      const position = options.body.position;
      let at = state.blocks.length;
      if (position?.type === "start") at = 0;
      if (position?.type === "after_block") at = state.blocks.findIndex(block => block.id === position.after_block.id) + 1;
      assert.ok(at >= 0, "position must point at an existing block");
      state.blocks.splice(at, 0, ...written);
      return { results: echoFollowing ? state.blocks.slice(at) : written };
    }
    if (requestPath === `/v1/pages/${PAGE_ID}` && options.method === "PATCH") {
      for (const [name, value] of Object.entries(options.body.properties ?? {})) {
        page.properties[name] = value.rich_text
          ? { ...value, rich_text: value.rich_text.map(item => ({ ...item, plain_text: item.text?.content ?? "" })) }
          : value;
      }
      return page;
    }
    if (requestPath.startsWith("/v1/blocks/") && options.method === "DELETE") {
      const id = requestPath.split("/").at(-1);
      state.deleted.push(id);
      state.blocks = state.blocks.filter(block => block.id !== id);
      return {};
    }
    throw new Error(`未預期的 request：${options.method} ${requestPath}`);
  };
  state.repository = createNotionRepository({
    shared: S,
    notion: N,
    notionRequest: (...args) => state.notionRequest(...args),
    captureEntries: value => [value, ...(value.continuations ?? []), ...(value.authorReplies ?? [])],
    fetchImpl: async () => { throw new Error("不應下載圖片"); },
    cloneCapture: value => structuredClone(value),
    createFormData: () => ({ append() {} })
  });
  state.range = () => N.contentRangeFromPage(page);
  return state;
}

function webCapture(paragraphs) {
  return M.normalizeCapture({
    platform: "web",
    captureType: "post",
    sourceUrl: "https://blog.example.com/post",
    title: "新標題",
    captureValidation: { version: 2, source: "web-page", validated: true },
    articleBlocks: paragraphs.map(text => ({ type: "paragraph", spans: [{ text }] }))
  }, { sourceType: "page" });
}

test("更新已保存的頁面：只換掉記錄的原文，原文上下的筆記都留在原位", async () => {
  const noteAbove = textBlock("我在最上面寫的筆記");
  const original = [textBlock("舊的第一段"), textBlock("舊的第二段")];
  const noteBelow = textBlock("我在下面寫的筆記");
  const notion = fakeNotion({
    blocks: [noteAbove, ...original, noteBelow],
    range: [original[0].id, original[1].id]
  });

  const result = await notion.repository.saveCaptureToNotion(webCapture(["新的第一段", "新的第二段", "新的第三段"]), DATA_SOURCE, "token", { updateExisting: true });

  assert.equal(result.updatedExisting, true);
  assert.deepEqual(notion.blocks.map(blockText), ["我在最上面寫的筆記", "新的第一段", "新的第二段", "新的第三段", "我在下面寫的筆記"]);
  assert.deepEqual(notion.deleted.sort(), original.map(block => block.id).sort());
  assert.deepEqual(notion.range(), { first: notion.blocks[1].id, last: notion.blocks[3].id });
  const propertyPatch = notion.requests.find(request => request.path === `/v1/pages/${PAGE_ID}` && request.body.properties?.[N.PROPERTY_NAMES.title]);
  assert.equal(propertyPatch.body.properties[N.PROPERTY_NAMES.title].title[0].text.content, "新標題");
  assert.equal(propertyPatch.body.properties[N.PROPERTY_NAMES.processingStatus], undefined);
  assert.equal(propertyPatch.body.properties[N.PROPERTY_NAMES.savedAt], undefined);
  // The new version is recorded before anything is deleted.
  const rangeWrite = notion.requests.indexOf(propertyPatch);
  const firstDelete = notion.requests.findIndex(request => request.method === "DELETE");
  assert.ok(rangeWrite < firstDelete);
});

test("連續更新兩次：Notion 回傳新區塊加上後面的舊區塊時，仍只記錄新版本，第二次也只換掉原文", async () => {
  const noteAbove = textBlock("上面的筆記");
  const original = [textBlock("第一版")];
  const noteBelow = textBlock("下面的筆記");
  const notion = fakeNotion({
    blocks: [noteAbove, ...original, noteBelow],
    range: [original[0].id, original[0].id],
    echoFollowing: true
  });

  await notion.repository.saveCaptureToNotion(webCapture(["第二版"]), DATA_SOURCE, "token", { updateExisting: true });
  assert.deepEqual(notion.range(), { first: notion.blocks[1].id, last: notion.blocks[1].id });

  const result = await notion.repository.saveCaptureToNotion(webCapture(["第三版 A", "第三版 B"]), DATA_SOURCE, "token", { updateExisting: true });
  assert.equal(result.keptPreviousVersion, false);
  assert.deepEqual(notion.blocks.map(blockText), ["上面的筆記", "第三版 A", "第三版 B", "下面的筆記"]);
});

test("找不到原文範圍時，提醒放在新版本正下方、舊內容上方", async () => {
  const notion = fakeNotion({ blocks: [textBlock("舊的原文"), textBlock("我的筆記")], echoFollowing: true });
  await notion.repository.saveCaptureToNotion(webCapture(["新的原文"]), DATA_SOURCE, "token", { updateExisting: true });
  assert.deepEqual(notion.blocks.map(block => block.type === "callout" ? "提醒" : blockText(block)).filter(Boolean), ["新的原文", "提醒", "舊的原文", "我的筆記"]);
  assert.deepEqual(notion.range(), { first: notion.blocks[0].id, last: notion.blocks[0].id });
});

test("原文在頁面最上方時，新版本從頁面開頭寫入", async () => {
  const original = [textBlock("舊內容")];
  const note = textBlock("筆記");
  const notion = fakeNotion({ blocks: [...original, note], range: [original[0].id, original[0].id] });
  await notion.repository.saveCaptureToNotion(webCapture(["新內容"]), DATA_SOURCE, "token", { updateExisting: true });
  assert.deepEqual(notion.blocks.map(blockText), ["新內容", "筆記"]);
  const insert = notion.requests.find(request => request.method === "PATCH" && request.path.endsWith("/children"));
  assert.deepEqual(insert.body.position, { type: "start" });
});

test("找不到原文範圍的頁面：新版本放在最上面，舊內容與筆記全部保留", async () => {
  const old = [textBlock("舊的原文"), textBlock("我的筆記")];
  const notion = fakeNotion({ blocks: old });
  const result = await notion.repository.saveCaptureToNotion(webCapture(["新的原文"]), DATA_SOURCE, "token", { updateExisting: true });
  assert.equal(result.keptPreviousVersion, true);
  assert.deepEqual(notion.deleted, []);
  assert.equal(blockText(notion.blocks[0]), "新的原文");
  assert.equal(notion.blocks.find(block => block.type === "callout") !== undefined, true);
  assert.deepEqual(notion.blocks.slice(-2).map(blockText), ["舊的原文", "我的筆記"]);
  assert.deepEqual(notion.range(), { first: notion.blocks[0].id, last: notion.blocks[0].id });
});

test("記錄的原文區塊已被使用者刪掉時，不刪任何東西", async () => {
  const blocks = [textBlock("剩下的內容")];
  const notion = fakeNotion({ blocks, range: [blockId(), blockId()] });
  await notion.repository.saveCaptureToNotion(webCapture(["新的原文"]), DATA_SOURCE, "token", { updateExisting: true });
  assert.deepEqual(notion.deleted, []);
  assert.equal(notion.blocks.at(-1).id, blocks[0].id);
});

test("沒有要求更新時，已保存的頁面完全不被修改", async () => {
  const blocks = [textBlock("原文")];
  const notion = fakeNotion({ blocks, range: [blocks[0].id, blocks[0].id] });
  const result = await notion.repository.saveCaptureToNotion(webCapture(["新的原文"]), DATA_SOURCE, "token");
  assert.equal(result.duplicateFoundInNotion, true);
  assert.equal(result.updatedExisting, undefined);
  assert.deepEqual(notion.requests.map(request => request.method), ["POST"]);
});

test("新建立的頁面會記錄原文範圍，之後可以安全更新", async () => {
  const notion = fakeNotion({ blocks: [] });
  notion.page.properties[N.PROPERTY_NAMES.captureKey] = { rich_text: [{ plain_text: "web:other" }] };
  const original = notion.notionRequest;
  notion.notionRequest = async (requestPath, options) => {
    if (requestPath.endsWith("/query")) return { results: [], has_more: false };
    if (requestPath === "/v1/pages" && options.method === "POST") {
      notion.blocks.push(...options.body.children.map(block => ({ ...block, id: blockId() })));
      return { id: PAGE_ID, url: "https://www.notion.so/new" };
    }
    return original(requestPath, options);
  };
  await notion.repository.saveCaptureToNotion(webCapture(["第一段", "第二段"]), DATA_SOURCE, "token");
  assert.deepEqual(notion.range(), { first: notion.blocks[0].id, last: notion.blocks[1].id });
});

test("補完串文時，缺少的段落接在原文後面、使用者筆記前面", async () => {
  const first = textBlock("第一段\n1/3");
  const note = textBlock("我的筆記");
  const notion = fakeNotion({ blocks: [first, note], range: [first.id, first.id], captureKey: "tsc:ABC123" });
  const capture = {
    captureType: "post",
    sourceUrl: "https://www.threads.com/@example/post/ABC123",
    dedupeKey: "tsc:ABC123",
    text: "第一段",
    threadPosition: "1/3",
    media: [],
    reviewFlags: [],
    authorReplies: [],
    continuations: [
      { text: "第二段", threadPosition: "2/3", media: [], sourceUrl: "https://www.threads.com/@example/post/DEF" },
      { text: "第三段", threadPosition: "3/3", media: [], sourceUrl: "https://www.threads.com/@example/post/GHI" }
    ]
  };
  const result = await notion.repository.saveCaptureToNotion(capture, DATA_SOURCE, "token", { appendMissing: true });
  assert.equal(result.appendedContinuations, 2);
  const texts = notion.blocks.map(blockText).filter(Boolean);
  assert.deepEqual(texts, ["第一段\n1/3", "第二段\n2/3", "第三段\n3/3", "我的筆記"]);
  assert.equal(notion.range().last, notion.blocks.at(-2).id);
});
