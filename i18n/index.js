/**
 * Interface language: `t()` looks a Chinese string up in the English dictionary (i18n/en.js), and
 * `translateDocument()` does the same for the static text of extension pages.
 *
 * Chinese is the source language, so a string with no English entry shows in Chinese instead of blank.
 */
(function attachSavourI18n(root, factory) {
  const english = typeof module === "object" && module.exports
    ? require("./en.js")
    : root.SavourI18nEnglish;
  const api = factory(english ?? {});
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createI18n(/** @type {Record<string, string>} */ english) {
  "use strict";

  // The interface is written in Traditional Chinese; the English dictionary is keyed by that Chinese
  // text. A string without an English entry shows in Chinese, so a missing translation is never blank.
  // Placeholders look like {n} and are filled from the second argument.
  const LANGUAGES = Object.freeze(["zh", "en"]);
  const PREFERENCES = Object.freeze(["auto", "zh", "en"]);
  let language = "zh";

  // "auto" follows the browser's interface language: Chinese for any zh-*, English otherwise.
  /**
   * @param {"auto"|"zh"|"en"} preference
   * @param {string} [browserLanguage]
   * @returns {"zh"|"en"}
   */
  function resolveLanguage(preference, browserLanguage = "") {
    if (PREFERENCES.includes(preference) && preference !== "auto") return preference;
    // No browser language to follow (tests, old browsers): the interface's own language.
    if (!browserLanguage) return "zh";
    return /^zh\b/i.test(String(browserLanguage)) ? "zh" : "en";
  }

  function setLanguage(/** @type {any} */ value) {
    language = LANGUAGES.includes(value) ? value : "zh";
    return language;
  }

  function getLanguage() {
    return language;
  }

  /**
   * @param {string} text
   * @param {Record<string, string | number>} [params]
   * @returns {string}
   */
  function fill(text, params) {
    return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;
  }

  /**
   * Translates a Chinese string into the current language and fills {placeholders}.
   * @param {string} text
   * @param {Record<string, string|number>} [params]
   * @returns {string}
   */
  function t(text, params) {
    const key = String(text ?? "");
    return fill(language === "en" && english[key] !== undefined ? english[key] : key, params);
  }

  // Titles Savour fills in when a page or database has none. They are stored as data (in Notion and in
  // local state), so they are translated where they are shown, not where they are made.
  const PLACEHOLDER_TITLES = Object.freeze(["未命名貼文", "無文字貼文", "未命名資料庫"]);

  /**
   * A page or database title for display: one of Savour's fill-in titles in the current language,
   * any other title unchanged.
   * @param {unknown} title
   * @returns {string}
   */
  function displayTitle(title) {
    const text = String(title ?? "");
    return PLACEHOLDER_TITLES.includes(text) ? t(text) : text;
  }

  function normalizeSpace(/** @type {any} */ value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  // Text of static pages (popup.html, options.html, picker.html): every text node, and the text
  // attributes people see or hear, are looked up by their Chinese wording.
  const TEXT_ATTRIBUTES = ["placeholder", "aria-label", "title", "alt"];

  function translateDocument(/** @type {Document} */ doc) {
    if (language !== "en" || !doc) return;
    const walker = doc.createTreeWalker(doc, 4 /* SHOW_TEXT */);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (/^(?:SCRIPT|STYLE)$/.test(node.parentNode?.nodeName ?? "")) continue;
      const original = node.nodeValue ?? "";
      const key = normalizeSpace(original);
      if (!key || english[key] === undefined) continue;
      const lead = /^\s*/.exec(original)?.[0] ?? "";
      const tail = /\s*$/.exec(original)?.[0] ?? "";
      node.nodeValue = `${lead}${english[key]}${tail}`;
    }
    for (const element of doc.querySelectorAll("*")) {
      for (const name of TEXT_ATTRIBUTES) {
        const key = normalizeSpace(element.getAttribute(name));
        if (key && english[key] !== undefined) element.setAttribute(name, english[key]);
      }
      if (element.nodeName === "INPUT" && /** @type {HTMLInputElement} */ (element).type === "text") {
        const key = normalizeSpace(element.getAttribute("value"));
        if (key && english[key] !== undefined) element.setAttribute("value", english[key]);
      }
    }
    doc.documentElement?.setAttribute("lang", "en");
  }

  // The language the user chose in the settings page, falling back to the browser's.
  async function loadFromStorage(/** @type {typeof chrome} */ chromeApi, configKey = "savourConfig") {
    /** @type {"auto" | "zh" | "en"} */
    let preference = "auto";
    try {
      preference = /** @type {any} */ ((await chromeApi.storage.local.get(configKey))?.[configKey])?.uiLanguage ?? "auto";
    } catch {
      // Storage is not readable here (a content script); the caller passes the language instead.
    }
    return setLanguage(resolveLanguage(preference, chromeApi?.i18n?.getUILanguage?.() ?? ""));
  }

  return { LANGUAGES, PLACEHOLDER_TITLES, PREFERENCES, displayTitle, getLanguage, loadFromStorage, resolveLanguage, setLanguage, t, translateDocument, english };
});
