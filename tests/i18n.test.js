"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const I = require("../i18n/index.js");
const english = require("../i18n/en.js");

const root = path.resolve(__dirname, "..");
const CJK = /[一-鿿]/;
const NOT_TRANSLATED = new Set(["中"]);
const PAGES = ["pages/popup/popup.html", "pages/options/options.html", "pages/picker/picker.html"];

test.afterEach(() => I.setLanguage("zh"));

// Every script the extension runs, so a new file is covered without being listed here.
function sourceFiles() {
  const dirs = ["background", "content", "lib", "model", "notion", "pages", "queue", "storage"];
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(relative);
    return entry.name.endsWith(".js") && entry.name !== "emoji-data.js" ? [relative] : [];
  });
  return ["background.js", ...dirs.flatMap(walk)];
}

function calledKeys() {
  const keys = new Set();
  const call = /(?:\bS\.|\bshared\.|\.|\b)t\(\s*("(?:[^"\\\n]|\\.)*")/g;
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    let match;
    while ((match = call.exec(source))) keys.add(JSON.parse(match[1]));
  }
  return keys;
}

function pageTexts(html) {
  const doc = new JSDOM(html).window.document;
  const texts = [];
  const walker = doc.createTreeWalker(doc, 4);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!/^(?:SCRIPT|STYLE)$/.test(node.parentNode.nodeName)) texts.push(node.nodeValue.replace(/\s+/g, " ").trim());
  }
  for (const element of doc.querySelectorAll("*")) {
    for (const name of ["placeholder", "aria-label", "title", "alt"]) texts.push(String(element.getAttribute(name) ?? "").replace(/\s+/g, " ").trim());
  }
  return texts.filter(text => CJK.test(text));
}

test("程式裡每一句介面文字、每個頁面上的中文，都有英文翻譯", () => {
  const missing = [];
  for (const key of calledKeys()) if (english[key] === undefined) missing.push(key);
  for (const page of PAGES) {
    for (const text of pageTexts(fs.readFileSync(path.join(root, page), "utf8"))) {
      if (!NOT_TRANSLATED.has(text) && english[text] === undefined) missing.push(`${page}: ${text}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("英文翻譯保留所有 {參數}，也沒有留下中文", () => {
  const problems = [];
  for (const [key, value] of Object.entries(english)) {
    const params = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(",");
    if (params(key) !== params(value)) problems.push(`參數不一致：${key}`);
    if (CJK.test(value)) problems.push(`英文裡有中文：${key}`);
  }
  assert.deepEqual(problems, []);
});

test("t() 依語言回傳文字、填入參數，沒有翻譯時退回中文", () => {
  assert.equal(I.t("已加入保存佇列，共 {n} 篇", { n: 3 }), "已加入保存佇列，共 3 篇");
  I.setLanguage("en");
  assert.equal(I.t("已加入保存佇列，共 {n} 篇", { n: 3 }), "Added to the save queue: 3");
  assert.equal(I.t("這句沒有翻譯"), "這句沒有翻譯");
  assert.equal(I.t("沒填的 {x}", {}), "沒填的 {x}");
  I.setLanguage("fr");
  assert.equal(I.getLanguage(), "zh");
});

test("displayTitle 只翻譯工具自動填的標題，使用者的標題原樣顯示", () => {
  for (const title of I.PLACEHOLDER_TITLES) assert.notEqual(english[title], undefined, title);
  assert.equal(I.displayTitle("未命名貼文"), "未命名貼文");
  I.setLanguage("en");
  assert.equal(I.displayTitle("未命名貼文"), "Untitled post");
  assert.equal(I.displayTitle("無文字貼文"), "Post without text");
  assert.equal(I.displayTitle("未命名資料庫"), "Untitled database");
  // A real title that happens to be a dictionary key stays as the user wrote it.
  assert.equal(I.displayTitle("已保存"), "已保存");
  assert.equal(I.displayTitle(undefined), "");
});

test("顯示頁面或資料庫標題的地方都經過 displayTitle", () => {
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  assert.match(read("pages/popup/popup.js"), /\[\.\.\.new Set\(\[resultLabel, \.\.\.notes\]\), I\.displayTitle\(item\.title\)\]\.join\(" · "\)/);
  assert.match(read("pages/popup/popup.js"), /link\.textContent = I\.displayTitle\(item\.title\);/);
  assert.match(read("pages/picker/picker.js"), /element\("button", "option", i18n\.displayTitle\(item\.title\)\)/);
  assert.match(read("pages/options/options.js"), /I\.displayTitle\(source\.title\)/);
  assert.match(read("background/append-picker.js"), /「\$\{I\.displayTitle\(result\.target\.title\)\}」/);
});

test("語言選擇：自訂的語言優先，自動時 zh 開頭用中文，其他用英文，查不到瀏覽器語言用中文", () => {
  assert.equal(I.resolveLanguage("en", "zh-TW"), "en");
  assert.equal(I.resolveLanguage("zh", "en-US"), "zh");
  assert.equal(I.resolveLanguage("auto", "zh-TW"), "zh");
  assert.equal(I.resolveLanguage("auto", "zh-CN"), "zh");
  assert.equal(I.resolveLanguage("auto", "en-US"), "en");
  assert.equal(I.resolveLanguage("auto", "ja"), "en");
  assert.equal(I.resolveLanguage("auto", ""), "zh");
  assert.equal(I.resolveLanguage("bogus", "ja"), "en");
});

test("loadFromStorage 讀取設定頁的語言選擇，沒有設定時跟隨瀏覽器", async () => {
  const chromeApi = (uiLanguage, browser) => ({
    storage: { local: { get: async key => ({ [key]: uiLanguage ? { uiLanguage } : {} }) } },
    i18n: { getUILanguage: () => browser }
  });
  assert.equal(await I.loadFromStorage(chromeApi(undefined, "en-GB")), "en");
  assert.equal(await I.loadFromStorage(chromeApi("zh", "en-GB")), "zh");
  assert.equal(await I.loadFromStorage(chromeApi("en", "zh-TW")), "en");
  assert.equal(await I.loadFromStorage({ storage: { local: { get: async () => { throw new Error("denied"); } } } }), "zh");
});

for (const page of PAGES) {
  test(`${page} 切成英文後，頁面上沒有留下中文（語言名稱除外）`, () => {
    I.setLanguage("en");
    const dom = new JSDOM(fs.readFileSync(path.join(root, page), "utf8"));
    I.translateDocument(dom.window.document);
    assert.deepEqual(pageTexts(dom.window.document.documentElement.outerHTML).filter(text => !NOT_TRANSLATED.has(text)), []);
    assert.equal(dom.window.document.documentElement.getAttribute("lang"), "en");
  });
}

test("切成中文時頁面不被改動", () => {
  const html = fs.readFileSync(path.join(root, "pages/popup/popup.html"), "utf8");
  const dom = new JSDOM(html);
  const before = dom.window.document.body.textContent;
  I.translateDocument(dom.window.document);
  assert.equal(dom.window.document.body.textContent, before);
});

test("設定頁右上角有 中／EN 切換，設定值只接受 auto / zh / en", async () => {
  const options = fs.readFileSync(path.join(root, "pages/options/options.html"), "utf8");
  assert.match(options, /class="language-toggle"[\s\S]*data-language="zh"[\s\S]*data-language="en"/);
  assert.doesNotMatch(options, /id="ui-language"/);
  const { createConfigStorage, DEFAULT_CONFIG } = require("../storage/config.js");
  assert.equal(DEFAULT_CONFIG.uiLanguage, "auto");
  let stored = { ...DEFAULT_CONFIG };
  const storage = createConfigStorage({
    chromeApi: {
      storage: {
        local: { get: async () => ({ savourConfig: stored }), set: async value => { stored = value.savourConfig ?? stored; }, remove: async () => undefined },
        session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined }
      }
    },
    shared: require("../lib/shared.js"),
    notion: require("../notion/index.js"),
    resolveArchiveTarget: async () => ({})
  });
  await storage.saveSettings({ uiLanguage: "en" });
  assert.equal(stored.uiLanguage, "en");
  await storage.saveSettings({ uiLanguage: "klingon" });
  assert.equal(stored.uiLanguage, "en");
});

test("manifest 的內容程式都先載入英文字典與 i18n.js，頁面也載入它們", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  // The only declared content script is Plurk Paste's; every other page gets its files injected on save.
  assert.deepEqual(manifest.content_scripts.map(item => item.matches), [["https://paste.plurk.com/show/*"]]);
  const tabs = require("../background/tabs.js").createTabs({ I: {}, S: require("../lib/shared.js") });
  for (const url of ["https://www.threads.com/", "https://www.plurk.com/", "https://www.instagram.com/", "https://example.com/"]) {
    assert.deepEqual(tabs.scriptsFor(url).js.slice(0, 3), ["i18n/en.js", "i18n/index.js", "lib/shared.js"]);
  }
  for (const page of PAGES) {
    assert.match(fs.readFileSync(path.join(root, page), "utf8"), /<script src="\.\.\/\.\.\/i18n\/en\.js"><\/script>\s*<script src="\.\.\/\.\.\/i18n\/index\.js"><\/script>/);
  }
  assert.match(fs.readFileSync(path.join(root, "background.js"), "utf8"), /importScripts\("i18n\/en\.js", "i18n\/index\.js", "lib\/shared\.js"/);
});
