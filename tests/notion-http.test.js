"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createNotionHttp } = require("../notion/http.js");

function response({ ok, status, body, retryAfter = null }) {
  return {
    ok,
    status,
    headers: { get: name => name === "retry-after" ? retryAfter : null },
    text: async () => body
  };
}

test("Notion HTTP transport 會加入認證、版本與 JSON body", async () => {
  const calls = [];
  const http = createNotionHttp({
    shared: { sleep: async () => undefined },
    apiVersion: "2026-03-11",
    requireToken: async () => "stored-token",
    fetchImpl: async (...args) => {
      calls.push(args);
      return response({ ok: true, status: 200, body: '{"object":"user"}' });
    }
  });

  assert.deepEqual(await http.notionRequest("/v1/users/me", {
    method: "POST",
    body: { hello: "world" }
  }), { object: "user" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.notion.com/v1/users/me");
  assert.deepEqual(calls[0][1], {
    method: "POST",
    headers: {
      Authorization: "Bearer stored-token",
      "Notion-Version": "2026-03-11",
      "Content-Type": "application/json"
    },
    body: '{"hello":"world"}'
  });
});

test("429 會依 retry-after 重試並保留成功回應", async () => {
  const waits = [];
  let requestCount = 0;
  const http = createNotionHttp({
    shared: { sleep: async value => waits.push(value) },
    apiVersion: "2026-03-11",
    requireToken: async () => "unused",
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return response({ ok: false, status: 429, body: '{"code":"rate_limited"}', retryAfter: "0" });
      }
      return response({ ok: true, status: 200, body: '{"ok":true}' });
    }
  });

  assert.deepEqual(await http.notionRequest("/v1/data_sources/demo", { token: "direct-token" }), { ok: true });
  assert.equal(requestCount, 2);
  assert.equal(waits.length, 1);
});

test("非 retrySafe 的伺服器錯誤會保留 Notion 錯誤資訊且不重試", async () => {
  let requestCount = 0;
  const http = createNotionHttp({
    shared: { sleep: async () => undefined },
    apiVersion: "2026-03-11",
    requireToken: async () => "token",
    fetchImpl: async () => {
      requestCount += 1;
      return response({
        ok: false,
        status: 500,
        body: '{"code":"internal_server_error","message":"暫時失敗"}'
      });
    }
  });

  await assert.rejects(
    http.notionRequest("/v1/pages", { method: "POST", body: {}, retrySafe: false }),
    error => error.message === "暫時失敗"
      && error.code === "internal_server_error"
      && error.status === 500
  );
  assert.equal(requestCount, 1);
});

test("瀏覽器環境會建立 Notion HTTP factory global", () => {
  const context = {};
  const source = fs.readFileSync(path.join(__dirname, "..", "notion/http.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "notion/http.js" });
  assert.equal(typeof context.SavourNotionHttp?.createNotionHttp, "function");
});
