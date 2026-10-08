"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../lib/shared.js");
const notion = require("../notion/index.js");
const { createChromeMock } = require("./helpers/chrome-mock");
const {
  CONFIG_KEY,
  TOKEN_KEY,
  DEFAULT_CONFIG,
  createConfigStorage
} = require("../storage/config.js");

function createFixture(initial = {}) {
  const chromeApi = createChromeMock(initial);
  const resolved = [];
  let dataSourceChanges = 0;
  const storage = createConfigStorage({
    chromeApi,
    shared,
    notion,
    async resolveArchiveTarget(target, token) {
      resolved.push({ target, token });
      return {
        dataSourceId: "source-resolved",
        databaseId: "database-resolved",
        databaseUrl: "https://www.notion.so/database-resolved"
      };
    },
    onDataSourceChanged() {
      dataSourceChanges += 1;
    }
  });
  return {
    chromeApi,
    resolved,
    storage,
    dataSourceChanges: () => dataSourceChanges
  };
}

test("讀取設定會補上預設值而不更改儲存內容", async () => {
  const fixture = createFixture({ local: { [CONFIG_KEY]: { targetHandle: "sample" } } });
  const config = await fixture.storage.readConfig();
  assert.equal(config.archiveName, DEFAULT_CONFIG.archiveName);
  assert.equal(config.targetHandle, "sample");
  assert.deepEqual(fixture.chromeApi.storage.local.snapshot()[CONFIG_KEY], { targetHandle: "sample" });
});

test("session Token 優先於 local，公開設定不會外洩 Token", async () => {
  const fixture = createFixture({
    local: { [TOKEN_KEY]: "local-token" },
    session: { [TOKEN_KEY]: "session-token" }
  });
  assert.equal(await fixture.storage.readToken(), "session-token");
  const config = await fixture.storage.getPublicConfig();
  assert.equal(config.hasToken, true);
  assert.equal(Object.hasOwn(config, "token"), false);
});

test("儲存設定會正規化值、解析新目標並將短期 Token 留在 session", async () => {
  const fixture = createFixture({ local: { [CONFIG_KEY]: { ...DEFAULT_CONFIG } } });
  const config = await fixture.storage.saveSettings({
    archiveName: "  測試整理庫  ",
    targetHandle: "@Sample",
    archiveTarget: " target-source ",
    token: " supplied-token ",
    rememberToken: false
  });
  assert.equal(config.archiveName, "測試整理庫");
  assert.equal(config.targetHandle, "sample");
  assert.equal(config.dataSourceId, "source-resolved");
  assert.deepEqual(fixture.resolved, [{ target: "target-source", token: "supplied-token" }]);
  assert.equal(fixture.dataSourceChanges(), 1);
  assert.equal(fixture.chromeApi.storage.session.snapshot()[TOKEN_KEY], "supplied-token");
  assert.equal(fixture.chromeApi.storage.local.snapshot()[TOKEN_KEY], undefined);
});

test("記住 Token 會從 session 移到 local，不會重新解析未變更的目標", async () => {
  const fixture = createFixture({
    local: {
      [CONFIG_KEY]: {
        ...DEFAULT_CONFIG,
        archiveTarget: "target-source",
        dataSourceId: "existing-source"
      }
    },
    session: { [TOKEN_KEY]: "remember-me" }
  });
  await fixture.storage.saveSettings({ rememberToken: true });
  assert.deepEqual(fixture.resolved, []);
  assert.equal(fixture.dataSourceChanges(), 0);
  assert.equal(fixture.chromeApi.storage.local.snapshot()[TOKEN_KEY], "remember-me");
  assert.equal(fixture.chromeApi.storage.session.snapshot()[TOKEN_KEY], undefined);
});

test("清除目標時一併清除 Notion ID，缺少 Token 時拒絕受保護操作", async () => {
  const fixture = createFixture({
    local: {
      [CONFIG_KEY]: {
        ...DEFAULT_CONFIG,
        archiveTarget: "target-source",
        dataSourceId: "source",
        databaseId: "database",
        databaseUrl: "https://www.notion.so/database"
      }
    }
  });
  const config = await fixture.storage.saveSettings({ archiveTarget: "", rememberToken: false });
  assert.equal(config.dataSourceId, "");
  assert.equal(config.databaseId, "");
  assert.equal(config.databaseUrl, "");
  assert.equal(fixture.dataSourceChanges(), 1);
  await assert.rejects(() => fixture.storage.requireToken(), /尚未設定 Notion Token/);
});

test("瀏覽器模式會暴露全域 storage config API", () => {
  const source = require("node:fs").readFileSync(require.resolve("../storage/config.js"), "utf8");
  assert.match(source, /root\.SavourStorageConfig = api/);
});

test("更換資料來源前的檢查失敗時不會寫入新設定", async () => {
  const chromeApi = createChromeMock({ local: { [CONFIG_KEY]: { ...DEFAULT_CONFIG, archiveTarget: "old", dataSourceId: "source-old" }, [TOKEN_KEY]: "token" } });
  const changes = [];
  const storage = createConfigStorage({
    chromeApi,
    shared,
    notion,
    resolveArchiveTarget: async () => ({ dataSourceId: "source-new", databaseId: "db", databaseUrl: "" }),
    async assertDataSourceChangeAllowed(previous, next) {
      changes.push(["assert", previous, next]);
      throw new Error("blocked");
    },
    async onDataSourceChanged(previous, next) {
      changes.push(["changed", previous, next]);
    }
  });
  await assert.rejects(storage.saveSettings({ archiveTarget: "new" }), /blocked/);
  assert.equal(chromeApi.storage.local.snapshot()[CONFIG_KEY].dataSourceId, "source-old");
  assert.deepEqual(changes, [["assert", "source-old", "source-new"]]);
});

