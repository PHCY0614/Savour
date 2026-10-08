/**
 * Background service worker: the only place that talks to Notion and owns the save queue.
 *
 * Pages (popup, settings, picker) and content scripts send it messages (see BackgroundMessage in
 * types.d.ts); `handleMessage` routes each one. It also builds the right-click menus, reads the
 * active tab on request, and wakes the queue with an alarm.
 *
 * Does not read web pages itself (content scripts do) and never sends the Notion token to a page.
 * Loaded with importScripts in the extension and with require() in Node tests.
 *
 * This file builds the shared services (settings, state, Notion requests, the queue) and wires them
 * into the parts under background/: tabs, plurk-paste, archive, capture-flow, append-picker and
 * status-sync. Each part gets only the services it names in `deps`.
 */
"use strict";

importScripts("i18n/en.js", "i18n/index.js", "lib/shared.js", "notion/schema.js", "notion/page-builder.js", "notion/http.js", "notion/repository.js", "notion/index.js", "storage/config.js", "model/dedupe-key.js", "storage/state.js", "storage/media-stage.js", "model/source-flags.js", "model/article-blocks.js", "model/capture-model.js", "queue/retry.js", "background/tabs.js", "background/plurk-paste.js", "background/archive.js", "background/capture-flow.js", "background/append-picker.js", "background/status-sync.js");

/** @type {typeof import("./i18n/index.js")} */
const I = typeof module === "object" && module.exports
  ? require("./i18n/index.js")
  : SavourI18n;
const S = SavourShared;
const N = SavourNotion;
/** @type {typeof import("./notion/http.js")} */
const NH = typeof module === "object" && module.exports
  ? require("./notion/http.js")
  : SavourNotionHttp;
/** @type {typeof import("./notion/repository.js")} */
const NR = typeof module === "object" && module.exports
  ? require("./notion/repository.js")
  : SavourNotionRepository;
/** @type {typeof import("./storage/config.js")} */
const SC = typeof module === "object" && module.exports
  ? require("./storage/config.js")
  : SavourStorageConfig;
/** @type {typeof import("./storage/state.js")} */
const SS = typeof module === "object" && module.exports
  ? require("./storage/state.js")
  : SavourStorageState;
/** @type {typeof import("./storage/media-stage.js")} */
const MS = typeof module === "object" && module.exports
  ? require("./storage/media-stage.js")
  : SavourMediaStage;
const mediaStage = MS.createMediaStage();
/** @type {typeof import("./model/source-flags.js")} */
const F = typeof module === "object" && module.exports
  ? require("./model/source-flags.js")
  : SavourSourceFlags;
/** @type {typeof import("./model/capture-model.js")} */
const M = typeof module === "object" && module.exports
  ? require("./model/capture-model.js")
  : SavourCaptureModel;
/** @type {typeof import("./queue/retry.js")} */
const Q = typeof module === "object" && module.exports
  ? require("./queue/retry.js")
  : SavourQueueRetry;
/** @type {typeof import("./background/tabs.js")} */
const BT = typeof module === "object" && module.exports
  ? require("./background/tabs.js")
  : SavourBackgroundTabs;
/** @type {typeof import("./background/plurk-paste.js")} */
const BP = typeof module === "object" && module.exports
  ? require("./background/plurk-paste.js")
  : SavourBackgroundPlurkPaste;
/** @type {typeof import("./background/archive.js")} */
const BA = typeof module === "object" && module.exports
  ? require("./background/archive.js")
  : SavourBackgroundArchive;
/** @type {typeof import("./background/capture-flow.js")} */
const BC = typeof module === "object" && module.exports
  ? require("./background/capture-flow.js")
  : SavourBackgroundCaptureFlow;
/** @type {typeof import("./background/append-picker.js")} */
const BK = typeof module === "object" && module.exports
  ? require("./background/append-picker.js")
  : SavourBackgroundAppendPicker;
/** @type {typeof import("./background/status-sync.js")} */
const BS = typeof module === "object" && module.exports
  ? require("./background/status-sync.js")
  : SavourBackgroundStatusSync;

const { CONFIG_KEY, DEFAULT_CONFIG } = SC;
const { STATE_KEY, DEFAULT_STATE } = SS;
const { PROCESS_ALARM } = Q;
const INCOMPLETE_THREAD_FLAG = "串文未完整";
// Every web page can be saved, so the menus show on all of them.
const PAGE_PATTERNS = ["http://*/*", "https://*/*"];

// ---- Shared services -------------------------------------------------------------------------
// Parts that are created later are reached through small arrow functions, so the services and
// parts can refer to each other without caring about creation order.

const {
  getPublicConfig,
  readConfig,
  readToken,
  requireToken,
  saveSettings
} = SC.createConfigStorage({
  chromeApi: chrome,
  shared: S,
  resolveArchiveTarget: (/** @type {string} */ target, /** @type {string} */ token) => resolveArchiveTarget(target, token),
  assertDataSourceChangeAllowed: () => assertDataSourceChangeAllowed(),
  onDataSourceChanged: (/** @type {string} */ previousId, /** @type {string} */ nextId) => resetLocalIndexForDataSource(previousId, nextId)
});

const {
  clearRecentItems,
  readState,
  withStateLock,
  writeState
} = SS.createStateStorage({
  chromeApi: chrome,
  cloneState: (value) => structuredClone(value)
});

const { notionRequest } = NH.createNotionHttp({
  shared: S,
  apiVersion: N.API_VERSION,
  fetchImpl: (input, init) => fetch(input, init),
  requireToken
});

function sanitizeCapture(/** @type {any} */ raw) {
  const captureType = raw?.captureType === "selection" ? "selection" : "post";
  const sourceType = captureType === "selection" ? "selection" : "page";
  return M.normalizeCapture(raw, {
    sourceType,
    completeness: captureType === "selection" ? "user-confirmed" : F.derivePageCompleteness(raw),
    relationshipMethod: captureType === "selection" ? "manual" : "page-inference"
  });
}

function assertCaptureIntegrity(/** @type {import("./types").Capture} */ capture) {
  return M.validateCapture(capture);
}

function hasValidCaptureIntegrity(/** @type {import("./types").Capture} */ capture) {
  return M.hasValidCaptureIntegrity(capture);
}

function captureEntries(/** @type {import("./types").Capture} */ capture) {
  const continuations = capture.continuations ?? [];
  const authorReplies = capture.authorReplies ?? [];
  return [capture, ...continuations, ...authorReplies];
}

// ---- Parts -----------------------------------------------------------------------------------

const {
  activeThreadsTab,
  assertOwnContentScript,
  ensureFreshThreadPage,
  ensurePageScripts,
  fetchImageInTab,
  sendToTab,
  sendToTabWhenReady
} = BT.createTabs({ I, S });

const { fetchPlurkPaste, readPlurkPasteInTab } = BP.createPlurkPaste({ S, sendToTabWhenReady });

const {
  assertDataSourceChangeAllowed,
  createArchive,
  ensureArchiveSchema,
  listNotionDataSources,
  resetLocalIndexForDataSource,
  resolveArchiveTarget,
  testConnection,
  testNotionAuth
} = BA.createArchive({
  CONFIG_KEY,
  I,
  N,
  S,
  isProcessing: () => isProcessing(),
  notionRequest,
  readConfig,
  readState,
  readToken,
  requireToken,
  scheduleQueue: (/** @type {number} */ delayMs) => scheduleQueue(delayMs),
  withStateLock,
  writeState
});

const { appendSelectionToPage, saveCaptureToNotion } = NR.createNotionRepository({
  shared: S,
  notion: N,
  notionRequest,
  captureEntries,
  fetchImpl: (input, init) => fetch(input, init),
  cloneCapture: (value) => structuredClone(value),
  createFormData: () => new FormData(),
  mediaStage
});

const {
  enqueueCaptures,
  enqueueSelectionAppend,
  isProcessing,
  processQueue,
  recoverInterruptedItems,
  retryFailedItems,
  scheduleQueue
} = Q.createQueueRetry({
  chromeApi: chrome,
  shared: S,
  notion: N,
  readState,
  writeState,
  withStateLock,
  readConfig,
  readToken,
  ensureArchiveSchema,
  saveCaptureToNotion,
  appendSelectionToPage,
  sanitizeCapture,
  assertCaptureIntegrity,
  hasValidCaptureIntegrity,
  getStatus: () => getStatus(),
  cloneQueueItem: (value) => structuredClone(value)
});

const {
  exportAudit,
  getStatus,
  syncNotionState
} = BS.createStatusSync({
  INCOMPLETE_THREAD_FLAG,
  N,
  S,
  ensureArchiveSchema,
  isProcessing,
  notionRequest,
  readConfig,
  readState,
  readToken,
  requireToken,
  withStateLock,
  writeState
});

const { activePageStatus, captureActiveSelection, captureActiveThread } = BC.createCaptureFlow({
  INCOMPLETE_THREAD_FLAG,
  S,
  activeThreadsTab,
  enqueueCaptures,
  ensureFreshThreadPage,
  ensurePageScripts,
  fetchImageInTab,
  getStatus,
  mediaStage,
  readState,
  sendToTab,
  withStateLock,
  writeState
});

const {
  assertPickerPage,
  assertPopupPage,
  chooseFromPicker,
  currentPostAppendTarget,
  createPickerSession,
  openAppendPicker,
  pickerSessionView,
  searchFromPicker,
  selectionAppendMessage,
  takePendingPicker
} = BK.createAppendPicker({
  I,
  N,
  S,
  ensureArchiveSchema,
  enqueueCaptures,
  enqueueSelectionAppend,
  notionRequest,
  readConfig,
  readState,
  requireToken,
  sendToTab
});

// ---- Startup, menus and message routing ------------------------------------------------------

// The interface language: the user's choice in the settings, else the browser's. Content scripts
// cannot read the settings, so every message to a tab carries the language.
async function ensureLanguage() {
  return I.loadFromStorage(chrome, CONFIG_KEY);
}

async function setStorageAccess() {
  for (const area of [chrome.storage.local, chrome.storage.session]) {
    try {
      await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    } catch {
      // Older Chrome versions may not expose setAccessLevel.
    }
  }
}

async function initializeDefaults() {
  await setStorageAccess();
  await ensureLanguage();
  const local = await chrome.storage.local.get([CONFIG_KEY, STATE_KEY]);
  if (!local[CONFIG_KEY]) await chrome.storage.local.set({ [CONFIG_KEY]: { ...DEFAULT_CONFIG } });
  if (!local[STATE_KEY]) await chrome.storage.local.set({ [STATE_KEY]: structuredClone(DEFAULT_STATE) });
  await recoverInterruptedItems();
  await pruneMediaStage();
}

// Staged images that no queued item refers to any more (a capture that was dropped) are removed after a day.
async function pruneMediaStage() {
  try {
    const state = await readState();
    const keep = new Set(state.queue.flatMap(item => Object.values(item.capture?.stagedImages ?? {})));
    await mediaStage.prune(keep);
  } catch {
    // Pruning is housekeeping; a failure is tried again at the next start.
  }
}

function installContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "savour-selection",
      title: S.t("將選取文字保存到 Notion"),
      contexts: ["selection"],
      documentUrlPatterns: PAGE_PATTERNS
    });
    // The current page, wherever in it the user clicked; a link or picture right-clicked is not what is saved.
    chrome.contextMenus.create({
      id: "savour-save-post",
      title: S.t("保存目前頁面到 Notion"),
      contexts: ["page", "link", "image", "selection"],
      documentUrlPatterns: PAGE_PATTERNS
    });
    for (const [id, title] of [
      ["savour-save-selection", S.t("存成新頁面")],
      ["savour-append-selection-here", S.t("加到這篇的 Notion 頁面")],
      ["savour-append-selection-pick", S.t("加到其他頁面…")]
    ]) {
      chrome.contextMenus.create({
        id,
        parentId: "savour-selection",
        title,
        contexts: ["selection"],
        documentUrlPatterns: PAGE_PATTERNS
      });
    }
  });
}

// Menu titles follow the language, so a changed choice rebuilds them.
chrome.storage.onChanged?.addListener?.((changes, area) => {
  if (area === "local" && changes[CONFIG_KEY]) {
    ensureLanguage().then(() => installContextMenus()).catch(() => {});
  }
});

// Menus are rebuilt first, so an error while initializing storage cannot leave the old menus in place.
chrome.runtime.onInstalled.addListener(async () => {
  await ensureLanguage();
  installContextMenus();
  await initializeDefaults();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureLanguage();
  installContextMenus();
  await initializeDefaults();
  scheduleQueue(1000);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PROCESS_ALARM) processQueue().catch(() => {});
});

// Saves the tab's page or post and says how it went in a toast on the page (shortcut and right-click menu).
async function saveCurrentPageAndTell(/** @type {import("./types").PageTab} */ tab) {
  const result = await captureActiveThread(tab);
  await sendToTabWhenReady(tab.id, {
    type: "SHOW_TOAST",
    message: result.added
      ? result.appendMissing ? S.t("已加入佇列，會把缺少的串文接在原頁面最後") : S.t("已加入 Notion 保存佇列")
      : S.t("這篇已經保存或正在等待同步")
  });
}

chrome.contextMenus.onClicked.addListener(async (info, clickedTab) => {
  if (!clickedTab?.id) return;
  // ensurePageScripts below rejects a tab whose URL cannot be saved.
  const tab = /** @type {import("./types").PageTab} */ (clickedTab);
  await ensureLanguage();
  try {
    await ensurePageScripts(tab);
    let capture;
    if (info.menuItemId === "savour-append-selection-here") {
      const selection = await sendToTab(tab.id, { type: "CAPTURE_SELECTION", selectionText: info.selectionText ?? "" });
      const target = await currentPostAppendTarget(tab.url);
      if (!target) throw new Error(S.t("這篇還沒保存到 Notion，請先按「保存目前文章」，或改選「加到其他頁面…」"));
      const result = await enqueueSelectionAppend(selection, target);
      await sendToTab(tab.id, { type: "SHOW_TOAST", message: selectionAppendMessage(result, { withTitle: false }) });
      return;
    }
    if (info.menuItemId === "savour-append-selection-pick") {
      await openAppendPicker(tab, info.selectionText ?? "");
      return;
    }
    if (info.menuItemId === "savour-save-post") {
      await saveCurrentPageAndTell(tab);
      return;
    }
    if (info.menuItemId === "savour-save-selection") {
      capture = await sendToTab(tab.id, { type: "CAPTURE_SELECTION", selectionText: info.selectionText ?? "" });
    }
    if (!capture) return;
    const result = await enqueueCaptures([capture], { verifyExisting: true });
    await sendToTab(tab.id, {
      type: "SHOW_TOAST",
      message: result.added ? S.t("已加入保存佇列，共 {n} 篇", { n: result.added }) : S.t("這篇已經在保存紀錄中")
    });
  } catch (error) {
    await sendToTab(tab.id, { type: "SHOW_TOAST", message: error.message || S.t("無法擷取內容"), tone: "error" }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async command => {
  await ensureLanguage();
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id || !S.isSupportedSourceUrl(activeTab.url ?? "")) return;
  const tab = /** @type {import("./types").PageTab} */ (activeTab);
  try {
    await ensurePageScripts(tab);
    if (command === "save-selection") {
      await openAppendPicker(tab);
      return;
    }
    await saveCurrentPageAndTell(tab);
  } catch (error) {
    await sendToTab(tab.id, { type: "SHOW_TOAST", message: error.message, tone: "error" }).catch(() => {});
  }
});

const CONTENT_SCRIPT_MESSAGES = new Set(["FETCH_PLURK_PASTE", "READ_PLURK_PASTE_IN_TAB"]);

/**
 * Throws unless the message comes from one of Savour's own pages (popup, settings, picker).
 * @param {chrome.runtime.MessageSender} sender
 */
function assertExtensionPage(sender) {
  if (sender?.id !== chrome.runtime.id || !String(sender?.url ?? "").startsWith(chrome.runtime.getURL(""))) {
    throw new Error(S.t("不支援的操作"));
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({
      ok: false,
      error: error.message || String(error),
      code: error.code || "unknown_error",
      ...(error.createCount ? { createCount: error.createCount } : {}),
      ...(error.limit ? { limit: error.limit } : {})
    }));
  return true;
});

/**
 * Routes one message from an extension page or content script. Sender checks guard the picker and popup messages.
 * @param {import("./types").BackgroundMessage} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<unknown>} the `result` of the response
 */
async function handleMessage(message, sender) {
  await ensureLanguage();
  // Content scripts run inside websites, so only the two Plurk Paste messages are accepted from them
  // (checked below). Everything else, settings and the token included, comes from Savour's own pages.
  if (!CONTENT_SCRIPT_MESSAGES.has(message?.type)) assertExtensionPage(sender);
  switch (message?.type) {
    case "GET_STATUS":
      return getStatus();
    case "GET_CONFIG":
      return getPublicConfig();
    case "SAVE_SETTINGS":
      return saveSettings(message.settings ?? {});
    case "CREATE_ARCHIVE":
      return createArchive();
    case "TEST_NOTION_AUTH":
      return testNotionAuth();
    case "TEST_CONNECTION":
      return testConnection();
    case "LIST_NOTION_DATA_SOURCES":
      return listNotionDataSources(message.token);
    case "FETCH_PLURK_PASTE":
      assertOwnContentScript(sender);
      return fetchPlurkPaste(message.url);
    case "READ_PLURK_PASTE_IN_TAB":
      assertOwnContentScript(sender);
      return readPlurkPasteInTab(message.url);
    case "SAVE_CAPTURES": { // Normal selection and bulk capture transport.
      const captures = Array.isArray(message.captures) ? message.captures : [];
      // Existing Notion pages are never overwritten, so message.replaceExisting is ignored.
      return enqueueCaptures(captures, {
        verifyExisting: Boolean(message.verifyExisting),
        confirmedLargeCreate: Boolean(message.confirmedLargeCreate),
        createCountOffset: Math.max(0, Number(message.createCountOffset) || 0)
      });
    }
    case "PICKER_SESSION":
      assertPickerPage(sender);
      return pickerSessionView(message.token);
    case "PICKER_SEARCH":
      assertPickerPage(sender);
      return searchFromPicker(message.token, message.query);
    case "PICKER_CHOOSE":
      assertPickerPage(sender);
      return chooseFromPicker(message.token, message.target);
    case "TAKE_PENDING_PICKER":
      assertPopupPage(sender);
      return takePendingPicker();
    case "PREPARE_APPEND_PICKER": {
      // The popup shows the picker itself: capture the open page's selection and hand back the session.
      assertPopupPage(sender);
      const tab = await activeThreadsTab();
      await ensurePageScripts(tab);
      return { token: await createPickerSession(tab) };
    }
    case "CAPTURE_ACTIVE_THREAD":
      return captureActiveThread();
    case "UPDATE_ACTIVE_PAGE":
      return captureActiveThread(null, { update: true });
    case "CAPTURE_ACTIVE_SELECTION":
      return captureActiveSelection();
    case "GET_ACTIVE_PAGE_STATUS":
      return activePageStatus();
    case "RETRY_FAILED":
      return retryFailedItems();
    case "CLEAR_RECENT":
      return clearRecentItems();
    case "SYNC_NOTION_STATE":
      return syncNotionState();
    case "EXPORT_AUDIT":
      return exportAudit();
    default:
      throw new Error(S.t("不支援的操作"));
  }
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    DEFAULT_CONFIG,
    DEFAULT_STATE,
    assertCaptureIntegrity,
    enqueueCaptures,
    ensureArchiveSchema,
    handleMessage,
    initializeDefaults,
    processQueue,
    readState,
    sanitizeCapture,
    writeState
  };
} else {
  initializeDefaults().then(() => scheduleQueue(1000)).catch(() => {});
}
