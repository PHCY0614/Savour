/**
 * Toolbar popup: save the current page or selection, see what is queued, failed or saved,
 * and reach sync, export, settings and the archive.
 *
 * Holds no state of its own beyond the last status; every action is a message to the background worker
 * and the view is redrawn from `GET_STATUS`. When a page picker is waiting it hands over to picker.html.
 */
"use strict";

// Each page is its own script and never loads with another, but the type checker sees them as one
// program, so these two names are exempted there.
// @ts-ignore TS2451
const I = globalThis.SavourI18n;
// @ts-ignore TS2451
const t = I.t;
/** @type {Record<string, any>} */
const elements = {};
/** @type {any} */ let currentStatus = null;
// How the recent list words each review flag; the flags themselves are stored as they are.
/** @type {Record<string, string>} */
const REVIEW_NOTES = Object.freeze({
  "串文未完整": "串文可能不完整",
  "正文疑似遺漏": "正文可能有遺漏",
  "圖片未完整": "圖片未完整"
});

document.addEventListener("DOMContentLoaded", async () => {
  await I.loadFromStorage(chrome);
  I.translateDocument(document);
  // Opened by the 保存選取的文字 shortcut or 加到其他頁面…: show the page picker instead of the usual popup.
  // No background response just means there is no pending picker; show the normal popup.
  const pending = await chrome.runtime.sendMessage({ type: "TAKE_PENDING_PICKER" }).catch(() => /** @type {any} */ (null));
  if (pending?.ok && pending.result?.token) {
    location.replace(`../picker/picker.html#${pending.result.token}`);
    return;
  }
  for (const id of [
    "connection", "connection-label", "more-menu", "more-toggle", "more-list", "setup-warning", "open-settings-warning", "saved-count", "pending-count",
    "failed-count", "capture-thread", "save-selection", "append-selection", "update-panel", "update-page", "update-page-hint",
    "saved-page-link",
    "incomplete-section", "incomplete-count", "incomplete-list", "open-next-incomplete",
    "message", "recent-list", "recent-empty", "sync-state", "sync-notion", "clear-recent", "export-audit", "open-archive", "retry-failed",
    "open-settings"
  ]) {
    elements[id] = document.getElementById(id);
  }

  elements["capture-thread"].addEventListener("click", () => captureOne({ type: "CAPTURE_CURRENT_THREAD", includeContinuations: true }));
  elements["save-selection"].addEventListener("click", () => captureOne({ type: "CAPTURE_SELECTION" }));
  elements["append-selection"].addEventListener("click", appendSelection);
  elements["update-page"].addEventListener("click", updatePage);
  elements["open-next-incomplete"].addEventListener("click", openNextIncomplete);
  elements["retry-failed"].addEventListener("click", retryFailed);
  elements["sync-notion"].addEventListener("click", syncNotionState);
  elements["clear-recent"].addEventListener("click", clearRecent);
  elements["export-audit"].addEventListener("click", exportAudit);
  elements["open-archive"].addEventListener("click", openArchive);
  elements["open-settings"].addEventListener("click", openSettings);
  elements["open-settings-warning"].addEventListener("click", openSettings);
  elements["more-toggle"].addEventListener("click", () => setMoreMenu(elements["more-list"].hidden));
  document.addEventListener("click", event => {
    if (!elements["more-menu"].contains(event.target)) setMoreMenu(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !elements["more-list"].hidden) {
      setMoreMenu(false);
      elements["more-toggle"].focus();
    }
  });

  await refresh();
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

/** @type {any} */ let activePage = null;
let updateConfirmPending = false;

/**
 * Reloads the status and the active tab's saved-page status, then redraws the popup.
 */
async function refresh() {
  try {
    [currentStatus, activePage] = await Promise.all([
      sendBackground({ type: "GET_STATUS" }),
      // Pages the extension cannot read (chrome://, the web store) have no saved-page status; skip the update panel.
      sendBackground({ type: "GET_ACTIVE_PAGE_STATUS" }).catch(() => /** @type {any} */ (null))
    ]);
    renderStatus();
  } catch (error) {
    showMessage(error.message, true);
  }
}

// A page already saved can have its original replaced with what the tab shows now.
function renderUpdatePanel() {
  const saved = activePage?.status === "saved";
  elements["update-panel"].hidden = !saved;
  elements["update-page"].disabled = !currentStatus.configured;
  elements["update-page"].classList.toggle("is-confirming", updateConfirmPending);
  elements["update-page-hint"].textContent = updateConfirmPending
    ? t("再按一次確認：Notion 頁面的原文會換成目前的內容，原文上下你寫的筆記都會保留")
    : t("用目前頁面的內容換掉 Notion 裡的原文；你寫的筆記會保留");
  elements["saved-page-link"].hidden = !(saved && activePage?.notionUrl);
  if (activePage?.notionUrl) elements["saved-page-link"].href = activePage.notionUrl;
}

async function updatePage() {
  if (!updateConfirmPending) {
    updateConfirmPending = true;
    renderUpdatePanel();
    return;
  }
  updateConfirmPending = false;
  await runBusy(async () => {
    const result = await sendBackground({ type: "UPDATE_ACTIVE_PAGE" });
    const reloadNote = result.pageReloaded ? t("已重新整理頁面以讀取完整串文。") : "";
    if (result.localStatus === "pending") showMessage(t("這篇正在等待同步，完成後再更新"));
    else if (result.updateExisting) showMessage(`${reloadNote}${t("已加入佇列，會用目前的內容更新 Notion 頁面的原文，你寫的筆記會保留")}`);
    else if (result.added) showMessage(`${reloadNote}${t("已加入保存佇列")}`);
    else showMessage(t("這篇已經在佇列中"));
  });
}

function renderStatus() {
  elements["saved-count"].textContent = currentStatus.saved;
  elements["pending-count"].textContent = currentStatus.pending;
  elements["failed-count"].textContent = currentStatus.failed;
  elements["setup-warning"].hidden = currentStatus.configured;
  elements.connection.classList.toggle("is-connected", currentStatus.configured);
  elements["connection-label"].textContent = currentStatus.configured ? t("已連線 Notion") : t("尚未設定");
  elements["failed-count"].parentElement.classList.toggle("has-failed", currentStatus.failed > 0);
  elements["open-archive"].disabled = !currentStatus.databaseUrl;
  elements["retry-failed"].hidden = !currentStatus.failed;
  elements["sync-notion"].disabled = !currentStatus.configured;
  elements["sync-notion"].textContent = t("同步 Notion");
  elements["clear-recent"].disabled = !currentStatus.recent?.length;
  renderClearButton();
  elements["sync-state"].textContent = currentStatus.lastSyncedAt
    ? t("上次同步：{time}", { time: new Date(currentStatus.lastSyncedAt).toLocaleString(I.getLanguage() === "en" ? "en-GB" : "zh-Hant", { dateStyle: "short", timeStyle: "short" }) })
    : t("尚未與 Notion 完整同步");

  const actions = ["capture-thread", "save-selection", "append-selection"];
  for (const id of actions) elements[id].disabled = !currentStatus.configured;
  renderUpdatePanel();

  renderIncompleteThreads();

  elements["recent-list"].replaceChildren();
  for (const item of currentStatus.recent ?? []) {
    const row = document.createElement("li");
    if (item.notionUrl) {
      const link = document.createElement("a");
      link.href = item.notionUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      const resultLabel = item.result === "appended"
        ? t("已補上串文")
        : item.result === "selection_appended"
        ? t("已加入選取文字")
        : item.result === "selection_exists"
        ? t("選取文字已在頁面上")
        : item.result === "updated"
        ? t("已更新")
        : item.result === "already_saved"
          ? t("已存在")
          : item.result === "saved_partial" ? t("圖片未完整") : t("已保存");
      const notes = (item.reviewItems ?? []).map((/** @type {string} */ flag) => REVIEW_NOTES[flag]).filter(Boolean).map((/** @type {string} */ note) => t(note));
      link.textContent = [...new Set([resultLabel, ...notes]), I.displayTitle(item.title)].join(" · ");
      row.appendChild(link);
    } else {
      row.textContent = I.displayTitle(item.title);
    }
    elements["recent-list"].appendChild(row);
  }
  elements["recent-empty"].hidden = Boolean(currentStatus.recent?.length);
}

/**
 * Saves the active tab's post or selection and says how it went: queued, already saved, waiting, or saved
 * with warnings.
 * @param {{ type: string, includeContinuations?: boolean }} pageMessage CAPTURE_CURRENT_THREAD saves the post; anything else saves the selection
 */
async function captureOne(pageMessage) {
  await runBusy(async () => {
    let result;
    let details;
    if (pageMessage?.type === "CAPTURE_CURRENT_THREAD") {
      result = await sendBackground({ type: "CAPTURE_ACTIVE_THREAD" });
      details = {
        count: result.captureSummary?.longTextCount ?? 0,
        imageCount: result.captureSummary?.imageCount ?? 0,
        warnings: result.captureSummary?.warnings ?? []
      };
    } else {
      result = await sendBackground({ type: "CAPTURE_ACTIVE_SELECTION" });
      details = {
        count: result.captureSummary?.longTextCount ?? 0,
        imageCount: result.captureSummary?.imageCount ?? 0,
        warnings: result.captureSummary?.warnings ?? []
      };
    }
    const queuedMessage = result.appendMissing
      ? t("已加入佇列，會把缺少的串文接在原頁面最後面，不會動到原本的內容")
      : t("已加入保存佇列");
    const reloadNote = result.pageReloaded ? t("已重新整理頁面以讀取完整串文。") : "";
    if (result.localStatus === "saved") {
      // The local record says saved; after the page was deleted in Notion, a sync clears that record.
      showMessage(t("這篇已經保存過了；內容有變動時可以按「更新 Notion 頁面」。在 Notion 刪掉了？先按下方「同步 Notion」再保存。"));
    } else if (result.localStatus === "pending") {
      showMessage(t("這篇正在等待同步"));
    } else if (result.localStatus === "failed") {
      showMessage(t("這篇在失敗項目中，請使用「重試失敗項目」"), true);
    } else if (details.warnings.length) {
      const parts = [];
      if (details.count) parts.push(t("{n} 個長文附件", { n: details.count }));
      if (details.imageCount) parts.push(t("{n} 張圖片", { n: details.imageCount }));
      showMessage(
        `${reloadNote}${queuedMessage}${parts.length ? t("，取得 {parts}", { parts: parts.join(t("、")) }) : ""}${t("。{warning}", { warning: details.warnings[0] })}`,
        true
      );
    } else if (result.added) {
      const parts = [];
      if (details.count) parts.push(t("{n} 個長文附件", { n: details.count }));
      if (details.imageCount) parts.push(t("{n} 張圖片", { n: details.imageCount }));
      showMessage(`${reloadNote}${queuedMessage}${parts.length ? t("，取得 {parts}", { parts: parts.join(t("、")) }) : ""}`);
    } else {
      showMessage(t("這篇已經保存或正在等待同步"));
    }
  });
}

// Adds the selection to an existing page: the picker (the same one the right-click menu opens) replaces this popup.
async function appendSelection() {
  await runBusy(async () => {
    const { token } = await sendBackground({ type: "PREPARE_APPEND_PICKER" });
    location.replace(`../picker/picker.html#${token}`);
  });
}

function renderIncompleteThreads() {
  const items = currentStatus.incompleteThreads ?? [];
  elements["incomplete-section"].hidden = !items.length;
  elements["incomplete-count"].textContent = t("{n} 篇", { n: items.length });
  elements["open-next-incomplete"].disabled = !currentStatus.configured || !items.length;
  elements["incomplete-list"].replaceChildren();

  for (const item of items.slice(0, 20)) {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = I.displayTitle(item.title);
    row.appendChild(link);
    elements["incomplete-list"].appendChild(row);
  }
}

async function openNextIncomplete() {
  const item = currentStatus?.incompleteThreads?.[0];
  if (!item?.sourceUrl) {
    showMessage(t("目前沒有待補完串文"));
    return;
  }
  await chrome.tabs.create({ url: item.sourceUrl, active: true });
  window.close();
}

async function retryFailed() {
  await runBusy(async () => {
    const result = await sendBackground({ type: "RETRY_FAILED" });
    showMessage(t("已重新排入 {n} 個項目", { n: result.retried }));
  });
}

async function syncNotionState() {
  await runBusy(async () => {
    elements["sync-notion"].textContent = t("同步中…");
    const result = await sendBackground({ type: "SYNC_NOTION_STATE" });
    showMessage(t("同步完成，共 {synced} 篇。新增 {added} 篇，移除 {removed} 筆舊紀錄", { synced: result.synced, added: result.added, removed: result.removed }));
  });
}

let clearConfirmPending = false;

function renderClearButton() {
  elements["clear-recent"].classList.toggle("is-confirming", clearConfirmPending);
  elements["clear-recent"].textContent = clearConfirmPending ? t("再按一次確認清除") : t("清除紀錄");
}

function setMoreMenu(/** @type {any} */ open) {
  elements["more-list"].hidden = !open;
  elements["more-toggle"].setAttribute("aria-expanded", String(open));
  if (!open && clearConfirmPending) {
    clearConfirmPending = false;
    renderClearButton();
  }
}

async function clearRecent() {
  if (!clearConfirmPending) {
    clearConfirmPending = true;
    renderClearButton();
    return;
  }
  clearConfirmPending = false;
  setMoreMenu(false);
  await runBusy(async () => {
    const result = await sendBackground({ type: "CLEAR_RECENT" });
    showMessage(t("已清除 {n} 筆最近紀錄，不影響 Notion 文章", { n: result.cleared }));
  });
}

async function exportAudit() {
  setMoreMenu(false);
  await runBusy(async () => {
    const audit = await sendBackground({ type: "EXPORT_AUDIT" });
    const blob = new Blob([JSON.stringify(audit, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `savour-audit-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage(t("保存清單已匯出"));
  });
}

async function openArchive() {
  if (currentStatus?.databaseUrl) await chrome.tabs.create({ url: currentStatus.databaseUrl });
}

async function openSettings() {
  await chrome.runtime.openOptionsPage();
}

/**
 * Runs a popup action with the buttons disabled and a "處理中" message, then refreshes. Errors show in the
 * message line.
 * @param {() => Promise<void>} task
 */
async function runBusy(task) {
  setButtonsDisabled(true);
  showMessage(t("處理中"));
  try {
    await task();
    await new Promise(resolve => setTimeout(resolve, 200));
    await refresh();
  } catch (error) {
    showMessage(error.message || String(error), true);
  } finally {
    setButtonsDisabled(false);
    if (currentStatus) renderStatus();
  }
}

/**
 * @param {boolean} disabled
 */
function setButtonsDisabled(disabled) {
  // Settings and the database link stay usable while a save is running.
  document.querySelectorAll(/** @type {"button"} */ ("button:not([data-always-enabled])")).forEach(button => {
    if (disabled) button.dataset.wasDisabled = String(button.disabled);
    button.disabled = disabled || button.dataset.wasDisabled === "true";
    if (!disabled) delete button.dataset.wasDisabled;
  });
}

/**
 * @param {string} message
 * @param {boolean} [isError]
 */
function showMessage(message, isError = false) {
  elements.message.textContent = message || "";
  elements.message.classList.toggle("is-error", isError);
}
