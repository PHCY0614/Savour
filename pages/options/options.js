/**
 * Settings page: Notion token, choosing or creating the archive database and the
 * interface language.
 *
 * Talks to the background worker only through messages; the token typed here is handed to the worker
 * and not kept on this page after saving.
 */
"use strict";

// Each page is its own script and never loads with another, but the type checker sees them as one
// program, so these two names are exempted there.
// @ts-ignore TS2451
const I = globalThis.SavourI18n;
// @ts-ignore TS2451
const t = I.t;
const form = /** @type {HTMLElement} */ (document.getElementById("settings-form"));
const tokenInput = /** @type {HTMLInputElement} */ (document.getElementById("token"));
const tokenState = /** @type {HTMLElement} */ (document.getElementById("token-state"));
const rememberToken = /** @type {HTMLInputElement} */ (document.getElementById("remember-token"));
const parentPageUrl = /** @type {HTMLInputElement} */ (document.getElementById("parent-page-url"));
const archiveName = /** @type {HTMLInputElement} */ (document.getElementById("archive-name"));
const archiveTarget = /** @type {HTMLInputElement} */ (document.getElementById("archive-target"));
const testNotionAuthButton = /** @type {HTMLButtonElement} */ (document.getElementById("test-notion-auth"));
const connectArchiveButton = /** @type {HTMLButtonElement} */ (document.getElementById("connect-archive"));
const createArchiveButton = /** @type {HTMLButtonElement} */ (document.getElementById("create-archive"));
const resultCard = /** @type {HTMLElement} */ (document.getElementById("result-card"));
const resultTitle = /** @type {HTMLElement} */ (document.getElementById("result-title"));
const resultMessage = /** @type {HTMLElement} */ (document.getElementById("result-message"));
const archiveLink = /** @type {HTMLElement} */ (document.getElementById("archive-link"));
const loadDataSourcesButton = /** @type {HTMLButtonElement} */ (document.getElementById("load-data-sources"));
const dataSourceStatus = /** @type {HTMLElement} */ (document.getElementById("data-source-status"));
const dataSourcePicker = /** @type {HTMLElement} */ (document.getElementById("data-source-picker"));
const dataSourceSelect = /** @type {HTMLSelectElement} */ (document.getElementById("data-source-select"));
const dataSourceSwitchWarning = /** @type {HTMLElement} */ (document.getElementById("data-source-switch-warning"));
let currentDataSourceId = "";
let manualTargetEdited = false;
document.addEventListener("DOMContentLoaded", async () => {
  await I.loadFromStorage(chrome);
  I.translateDocument(document);
  renderLanguageToggle();
  loadSettings();
});

form.addEventListener("submit", event => {
  event.preventDefault();
  runAction(async () => {
    const config = await saveSettings();
    showResult(t("設定已保存"), config.hasToken ? t("設定已更新。") : t("基本設定已更新，但還需要輸入 Notion Token。"), false, config.databaseUrl);
  });
});

// The 中 / EN switch in the corner; the new language shows once the page is reloaded.
/** @type {import("../../types").Config["uiLanguage"]} */
let languagePreference = "auto";
const languageButtons = [...document.querySelectorAll(".language-toggle button")];

function renderLanguageToggle() {
  for (const button of languageButtons) {
    const active = button.dataset.language === I.getLanguage();
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

for (const button of languageButtons) {
  button.addEventListener("click", () => {
    if (button.dataset.language === I.getLanguage()) return;
    // The buttons in options.html carry data-language="zh" or "en".
    languagePreference = /** @type {"zh" | "en"} */ (button.dataset.language);
    runAction(async () => {
      await saveSettings();
      location.reload();
    });
  });
}

testNotionAuthButton.addEventListener("click", () => {
  runAction(async () => {
    await saveSettings();
    await sendBackground({ type: "TEST_NOTION_AUTH" });
    showResult(t("Notion 授權成功"), t("Integration Token 可以正常連接 Notion。"), false);
  });
});

loadDataSourcesButton.addEventListener("click", () => loadDataSources());

dataSourceSelect.addEventListener("change", () => {
  if (dataSourceSelect.value) archiveTarget.value = dataSourceSelect.value;
  updateSwitchWarning();
});

archiveTarget.addEventListener("input", () => {
  manualTargetEdited = true;
  const target = compactNotionId(archiveTarget.value);
  const match = [...dataSourceSelect.options].find(option => option.value && compactNotionId(option.value) === target);
  dataSourceSelect.value = match?.value || "";
  updateSwitchWarning();
});

connectArchiveButton.addEventListener("click", () => {
  if (!dataSourceSelect.value && !archiveTarget.value.trim()) {
    showResult(t("還沒選擇整理庫"), t("請先按「載入可用資料庫」並從清單選擇，或在進階設定貼上資料庫網址。"), true);
    return;
  }
  if (!dataSourceSwitchWarning.hidden && !window.confirm(
    t("要換到另一個 Notion 資料庫嗎？\n\n工具會清掉本機的「已保存」紀錄與失敗項目，改讀新資料庫的內容。Notion 裡的文章不會被刪除。")
  )) return;
  runAction(async () => {
    const config = await saveSettings({ switchArchive: true });
    const result = await sendBackground({ type: "TEST_CONNECTION" });
    currentDataSourceId = compactNotionId(config.dataSourceId);
    const schemaChanges = [];
    if (result.addedProperties?.length) schemaChanges.push(t("補上 {n} 個必要欄位", { n: result.addedProperties.length }));
    const schemaMessage = schemaChanges.length
      ? t("並{changes}。", { changes: schemaChanges.join(t("、")) })
      : t("資料庫欄位已是最新版本。");
    let syncMessage = "";
    if (config.dataSourceChanged) {
      const synced = await sendBackground({ type: "SYNC_NOTION_STATE" });
      syncMessage = t("已讀取這個資料庫既有的 {n} 篇文章。", { n: synced.synced });
    }
    showResult(t("整理庫已連接"), t("工具可以讀取並寫入這個整理庫，{schema}{sync}", { schema: schemaMessage, sync: syncMessage }), false, result.databaseUrl);
    await loadDataSources({ quiet: true });
  });
});

createArchiveButton.addEventListener("click", () => {
  if (currentDataSourceId && !window.confirm(
    t("建立新的整理庫後，之後的文章會改存到新的資料庫。\n\n工具會清掉本機的「已保存」紀錄與失敗項目；原本資料庫裡的文章不會被刪除。要繼續嗎？")
  )) return;
  runAction(async () => {
    await saveSettings();
    const config = await sendBackground({ type: "CREATE_ARCHIVE" });
    archiveTarget.value = config.archiveTarget || config.databaseUrl || config.dataSourceId || "";
    currentDataSourceId = compactNotionId(config.dataSourceId);
    showResult(t("整理庫已建立"), t("現在可以回到網頁，開始保存。"), false, config.databaseUrl);
    await loadDataSources({ quiet: true });
  });
});

/**
 * Sends a message to the background worker and returns its result; throws the worker's error.
 * @param {import("../../types").BackgroundMessage} message
 * @returns {Promise<any>}
 */
async function sendBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || t("擴充功能背景服務沒有回應"));
  return response.result;
}

async function loadSettings() {
  try {
    const config = await sendBackground({ type: "GET_CONFIG" });
    rememberToken.checked = Boolean(config.rememberToken);
    languagePreference = config.uiLanguage || "auto";
    renderLanguageToggle();
    parentPageUrl.value = config.parentPageUrl || "";
    archiveName.value = t(config.archiveName || "留己看");
    archiveTarget.value = config.archiveTarget || config.databaseUrl || config.dataSourceId || "";
    currentDataSourceId = compactNotionId(config.dataSourceId);
    tokenState.textContent = config.hasToken
      ? config.rememberToken ? t("Token 已保存在這台電腦") : t("Token 只在目前 Chrome 工作階段有效")
      : t("尚未設定");
    if (config.databaseUrl) showResult(t("整理庫已連接"), t("可以回到網頁開始保存。"), false, config.databaseUrl);
    if (config.hasToken) await loadDataSources({ quiet: true });
  } catch (error) {
    showResult(t("無法載入設定"), error.message, true);
  }
}

/**
 * The last Notion id in a URL or id, as 32 lowercase hex characters; "" when there is none.
 * @param {unknown} value
 */
function compactNotionId(value) {
  const match = String(value ?? "").match(/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/g);
  return match ? match[match.length - 1].replace(/-/g, "").toLowerCase() : "";
}

// The manual field may hold a database URL (a different ID from its data source), so it only counts once edited.
function selectedTargetId() {
  return compactNotionId(dataSourceSelect.value || (manualTargetEdited ? archiveTarget.value : ""));
}

function updateSwitchWarning() {
  const target = selectedTargetId();
  dataSourceSwitchWarning.hidden = !(currentDataSourceId && target && target !== currentDataSourceId);
}

function showDataSourceStatus(/** @type {any} */ message, isError = false) {
  dataSourceStatus.textContent = message;
  dataSourceStatus.classList.toggle("is-error", isError);
}

/**
 * Fills the database list with what the token can reach. `quiet` skips the "loading" message.
 * @param {{ quiet?: boolean }} [options]
 */
async function loadDataSources({ quiet = false } = {}) {
  loadDataSourcesButton.disabled = true;
  if (!quiet) showDataSourceStatus(t("正在向 Notion 讀取可用的資料庫…"));
  try {
    const result = await sendBackground({ type: "LIST_NOTION_DATA_SOURCES", token: tokenInput.value.trim() });
    renderDataSources(result.dataSources ?? [], result.limitReached);
    loadDataSourcesButton.textContent = t("重新整理清單");
  } catch (error) {
    showDataSourceStatus(explainError(error.message), true);
  } finally {
    loadDataSourcesButton.disabled = false;
  }
}

/**
 * @param {Array<{ id: string, title: string, emoji?: string }>} dataSources
 * @param {boolean} limitReached Notion returned more than the list shows
 */
function renderDataSources(dataSources, limitReached) {
  dataSourceSelect.replaceChildren(new Option(t("請選擇資料庫"), ""));
  let currentFound = false;
  for (const source of dataSources) {
    const option = new Option(`${source.emoji ? `${source.emoji} ` : ""}${I.displayTitle(source.title)}`, source.id);
    if (compactNotionId(source.id) === currentDataSourceId) {
      option.textContent += t("（目前使用中）");
      option.selected = true;
      currentFound = true;
    }
    dataSourceSelect.appendChild(option);
  }
  dataSourcePicker.hidden = !dataSources.length;
  if (!dataSources.length) {
    showDataSourceStatus(t("這組 Token 目前沒有可用的資料庫。請到 Notion 資料庫右上角「⋯」→「Connections」加入這個 Integration，再按重新整理清單。"), true);
  } else {
    const notes = [t("找到 {n} 個資料庫。", { n: dataSources.length })];
    if (currentDataSourceId && !currentFound) notes.push(t("目前使用中的整理庫不在清單裡，可能已移除授權。"));
    if (limitReached) notes.push(t("資料庫太多，只列出前 300 個；找不到時請用下方「進階」手動貼網址。"));
    showDataSourceStatus(notes.join(""));
  }
  updateSwitchWarning();
}

// Only "使用這個整理庫" sends archiveTarget, so other buttons never switch the database by accident.
async function saveSettings({ switchArchive = false } = {}) {
  const config = await sendBackground({
    type: "SAVE_SETTINGS",
    settings: {
      token: tokenInput.value.trim(),
      rememberToken: rememberToken.checked,
      parentPageUrl: parentPageUrl.value.trim(),
      archiveName: archiveName.value.trim(),
      uiLanguage: languagePreference,
      ...(switchArchive ? { archiveTarget: archiveTarget.value.trim() } : {})
    }
  });
  tokenInput.value = "";
  tokenState.textContent = config.hasToken
    ? config.rememberToken ? t("Token 已保存在這台電腦") : t("Token 只在目前 Chrome 工作階段有效")
    : t("尚未設定");
  return config;
}

/**
 * Runs a settings action with the buttons disabled; an error shows in the result card.
 * @param {() => Promise<void>} task
 */
async function runAction(task) {
  setBusy(true);
  try {
    await task();
  } catch (error) {
    showResult(t("操作失敗"), explainError(error.message), true);
  } finally {
    setBusy(false);
  }
}

/**
 * @param {boolean} busy
 */
function setBusy(busy) {
  form.querySelectorAll("button").forEach(button => {
    button.disabled = busy;
  });
}

/**
 * @param {string} title
 * @param {string} message
 * @param {boolean} isError
 * @param {string} [url] the archive link shown under the message
 */
function showResult(title, message, isError, url = "") {
  resultCard.hidden = false;
  resultCard.classList.toggle("is-error", isError);
  resultTitle.textContent = title;
  resultMessage.textContent = message;
  archiveLink.hidden = !url;
  archiveLink.href = url || "#";
}

/**
 * Turns a Notion error into advice for the usual causes: page not shared, bad token, missing permissions.
 * @param {string} message
 */
function explainError(message) {
  if (/object_not_found|Could not find|找不到/i.test(message)) {
    return t("Notion 找不到指定頁面或資料庫。請確認空白頁面或既有資料庫已透過 Add connections 授權給這個 Integration。");
  }
  if (/unauthorized|token/i.test(message)) {
    return t("Notion Token 無效或已失效，請重新複製 Token。");
  }
  if (/restricted_resource|permission|權限/i.test(message)) {
    return t("Integration 權限不足，請開啟讀取內容、插入內容與更新內容權限。");
  }
  return message;
}
