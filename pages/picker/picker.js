/**
 * Page picker window logic: search the archive's page titles and choose where a selection is added.
 *
 * Exported as a factory so tests can drive it with a fake document and fake messages. The real window
 * is wired at the bottom of the file.
 */
(function initializeSavourPicker(root, factory) {
  const i18n = typeof module === "object" && module.exports ? require("../../i18n/index.js") : root.SavourI18n;
  const api = factory(i18n);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourPicker = api;
})(globalThis, function createSavourPickerModule(/** @type {typeof import("../../i18n/index.js")} */ i18n) {
  "use strict";
  const t = i18n.t;

  /**
   * The window where the user picks the Notion page a selection goes to. It is an extension page,
   * not part of the website: the site cannot read the archive's page titles shown here, and it
   * cannot click or press keys in it. The selection itself stays in the background; this page only
   * holds the session token from its address.
   * @param {object} options
   * @param {Document} options.doc
   * @param {string} options.token the picker session token from the window's address
   * @param {(message: import("../../types").BackgroundMessage) => Promise<any>} options.sendMessage resolves to the worker's { ok, result, error } reply
   * @param {() => void} options.closeWindow
   * @param {number} [options.debounceMs] delay before a search runs; 300 by default
   * @param {(event: Event) => boolean} [options.isTrusted] tests replace this; real input only by default
   */
  function createPicker(options) {
    const { doc, token, sendMessage, closeWindow } = options;
    const debounceMs = options.debounceMs ?? 300;
    // Only real input counts; events a script made up are ignored.
    const isTrusted = options.isTrusted ?? ((/** @type {any} */ event) => event.isTrusted === true);
    const preview = /** @type {HTMLElement} */ (doc.getElementById("picker-preview"));
    const search = /** @type {HTMLInputElement} */ (doc.getElementById("picker-search"));
    const status = /** @type {HTMLElement} */ (doc.getElementById("picker-status"));
    const list = /** @type {HTMLElement} */ (doc.getElementById("picker-list"));
    const closeButton = /** @type {HTMLElement} */ (doc.getElementById("picker-close"));

    const newPage = { kind: "new", title: t("存成新頁面") };
    let defaultGroups = [{ label: "", items: [newPage] }];
    let preselect = "new";
    let items = /** @type {any[]} */ ([]);
    let activeIndex = 0;
    let busy = false;
    /** @type {ReturnType<typeof setTimeout> | number} */
    let searchTimer = 0;
    let searchSerial = 0;

    function element(/** @type {any} */ tag, /** @type {any} */ className, /** @type {string} */ text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    /**
     * @param {string} text
     * @param {boolean} [isError]
     */
    function showStatus(text, isError = false) {
      status.textContent = text;
      status.classList.toggle("is-error", isError);
    }

    function render(/** @type {any} */ groups, selected = "") {
      items = groups.flatMap((/** @type {any} */ group) => group.items);
      const selectedIndex = items.findIndex((item) => (item.kind === "new" ? "new" : item.pageId) === selected);
      activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
      list.replaceChildren();
      let index = 0;
      for (const group of groups) {
        if (!group.items.length) continue;
        if (group.label) list.append(element("li", "group", group.label));
        for (const item of group.items) {
          const row = doc.createElement("li");
          const button = element("button", "option", i18n.displayTitle(item.title));
          button.type = "button";
          button.setAttribute("role", "option");
          button.dataset.index = String(index);
          button.title = i18n.displayTitle(item.title);
          row.append(button);
          list.append(row);
          index += 1;
        }
      }
      highlight();
    }

    function highlight() {
      for (const button of list.querySelectorAll(/** @type {"button"} */ (".option"))) {
        const active = Number(button.dataset.index) === activeIndex;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
        if (active) button.scrollIntoView?.({ block: "nearest" });
      }
    }

    async function choose(/** @type {any} */ item) {
      if (!item || busy) return;
      busy = true;
      for (const button of list.querySelectorAll(/** @type {"button"} */ (".option"))) button.disabled = true;
      const target = item.kind === "page" ? { kind: "page", pageId: item.pageId } : { kind: "new" };
      try {
        const response = await sendMessage({ type: "PICKER_CHOOSE", token, target });
        if (response?.ok === false) throw new Error(response.error || t("無法保存選取文字"));
        showStatus(response?.result?.message || t("已加入保存佇列"));
        setTimeout(closeWindow, 900);
      } catch (error) {
        busy = false;
        for (const button of list.querySelectorAll(/** @type {"button"} */ (".option"))) button.disabled = false;
        showStatus(error.message || t("無法保存選取文字"), true);
      }
    }

    async function runSearch(/** @type {string} */ query) {
      const serial = ++searchSerial;
      if (!query) {
        showStatus("");
        render(defaultGroups, preselect);
        return;
      }
      showStatus(t("搜尋中…"));
      try {
        const response = await sendMessage({ type: "PICKER_SEARCH", token, query });
        if (serial !== searchSerial) return;
        if (response?.ok === false) throw new Error(response.error || t("搜尋失敗"));
        const results = (response?.result?.results ?? []).map((/** @type {any} */ item) => ({ kind: "page", ...item }));
        showStatus(results.length ? "" : t("整理庫裡沒有符合的頁面"));
        render([{ label: t("搜尋結果"), items: results }, { label: "", items: [newPage] }]);
      } catch (error) {
        if (serial !== searchSerial) return;
        showStatus(error.message || t("搜尋失敗"), true);
      }
    }

    search.addEventListener("input", (/** @type {any} */ event) => {
      if (!isTrusted(event)) return;
      clearTimeout(searchTimer);
      const query = search.value.trim();
      searchTimer = setTimeout(() => runSearch(query), query ? debounceMs : 0);
    });
    list.addEventListener("click", (/** @type {any} */ event) => {
      if (!isTrusted(event)) return;
      const button = event.target.closest?.(".option");
      if (button) choose(items[Number(button.dataset.index)]);
    });
    closeButton.addEventListener("click", (/** @type {any} */ event) => {
      if (isTrusted(event)) closeWindow();
    });
    doc.addEventListener("keydown", (/** @type {any} */ event) => {
      if (!isTrusted(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeWindow();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) return;
        activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        highlight();
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        choose(items[activeIndex]);
      }
    });

    /**
     * Asks the worker what this picker window is for and shows the choices: this post, recent pages, or a new page.
     * Shows an error instead when the window's session has expired.
     */
    async function load() {
      showStatus(t("讀取中…"));
      const response = await sendMessage({ type: "PICKER_SESSION", token }).catch((/** @type {any} */ error) => ({ ok: false, error: error.message }));
      if (!response?.ok) {
        list.replaceChildren();
        search.disabled = true;
        showStatus(response?.error || t("這個選單已經失效，請重新選取文字"), true);
        return;
      }
      const { previewText = "", choices = {} } = response.result ?? {};
      preview.textContent = previewText;
      defaultGroups = [
        ...(choices.current ? [{ label: t("這篇"), items: [{ kind: "page", ...choices.current }] }] : []),
        ...(choices.recent?.length ? [{ label: t("最近的頁面"), items: choices.recent.map((/** @type {any} */ item) => ({ kind: "page", ...item })) }] : []),
        { label: "", items: [newPage] }
      ];
      preselect = choices.preselect || "new";
      showStatus("");
      render(defaultGroups, preselect);
      search.focus();
    }

    return { load };
  }

  return { createPicker };
});

if (typeof module !== "object" && typeof chrome !== "undefined" && chrome.runtime?.id) {
  globalThis.SavourI18n.loadFromStorage(chrome).then(() => {
    globalThis.SavourI18n.translateDocument(document);
    return globalThis.SavourPicker.createPicker({
      doc: document,
      token: location.hash.slice(1),
      sendMessage: (/** @type {any} */ message) => chrome.runtime.sendMessage(message),
      closeWindow: () => window.close()
    }).load();
  });
}
