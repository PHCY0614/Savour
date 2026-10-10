/**
 * A fake `chrome` API with demo data, so popup.html and options.html render outside the extension.
 *
 * Injected by index.js ahead of the page's own scripts. Answers only the messages those two pages send
 * while a screenshot is taken; `?lang=zh|en` picks the language and `?scene=` the state to show.
 */
"use strict";

(() => {
  const q = new URLSearchParams(location.search);
  const lang = q.get("lang") === "en" ? "en" : "zh";
  const scene = q.get("scene") || "save";
  const page = n => `https://www.notion.so/demo-${n}`;
  const titles = lang === "en"
    ? ["How sourdough starters really work", "A quiet week in the Alps: trip notes", "Notes on typography for small screens", "Why we still read long articles", "Weeknight noodles, three ways"]
    : ["酸種麵包的酵母到底怎麼養", "阿爾卑斯山的安靜一週：旅行筆記", "給小螢幕的排版筆記", "為什麼我們還是愛讀長文", "平日晚餐的三種拌麵"];
  const DB = "https://www.notion.so/0123456789abcdef0123456789abcdef";
  const status = {
    configured: true, hasToken: true, hasArchive: true, databaseUrl: DB, archiveName: "留己看",
    pending: 0, failed: 0, saved: 24, incompleteThreads: [],
    recent: titles.map((title, i) => ({ key: `k${i}`, title, notionUrl: page(i), result: i === 2 ? "updated" : "saved", at: "" })),
    lastSyncedAt: new Date(2026, 9, 9, 9, 30, 0).toISOString()
  };
  const handlers = {
    TAKE_PENDING_PICKER: () => ({}),
    GET_STATUS: () => status,
    GET_ACTIVE_PAGE_STATUS: () => scene === "update"
      ? { supported: true, status: "saved", title: titles[2], notionUrl: page(2) }
      : { supported: true, status: "new", title: "", notionUrl: "" },
    CAPTURE_ACTIVE_SELECTION: () => ({ ...status, added: 1, duplicates: 0, captureSummary: { longTextCount: 0, imageCount: 0, warnings: [] } }),
    GET_CONFIG: () => ({ hasToken: true, rememberToken: true, uiLanguage: lang, parentPageUrl: "", archiveName: "留己看", databaseUrl: DB, dataSourceId: "0123456789abcdef0123456789abcdef", archiveTarget: "" }),
    LIST_NOTION_DATA_SOURCES: () => ({
      dataSources: [
        { id: "0123456789abcdef0123456789abcdef", title: lang === "en" ? "For Later Me" : "留己看", emoji: "📚" },
        { id: "fedcba9876543210fedcba9876543210", title: lang === "en" ? "Reading notes" : "閱讀筆記", emoji: "📝" }
      ],
      limitReached: false
    })
  };
  window.chrome = {
    i18n: { getUILanguage: () => (lang === "en" ? "en-US" : "zh-TW") },
    storage: { local: { get: async () => ({ savourConfig: { uiLanguage: lang } }) } },
    tabs: { create: async () => ({}) },
    runtime: {
      openOptionsPage: async () => {},
      sendMessage: async message => {
        const handler = handlers[message?.type];
        return handler ? { ok: true, result: handler(message) } : { ok: false, error: `no mock for ${message?.type}` };
      }
    }
  };
  // The selection scene shows the message a real save leaves behind.
  if (scene === "selection") {
    window.addEventListener("load", () => setTimeout(() => document.getElementById("save-selection")?.click(), 300));
  }
})();
