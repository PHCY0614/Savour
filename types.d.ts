/**
 * Shapes shared across Savour's modules. This file only feeds editors and `checkJs`; nothing loads it
 * at runtime. Reference a type from JSDoc with `@param {import("./types").Capture} capture`.
 */

/** Where a page was read from. */
export type Platform = "threads" | "x" | "instagram" | "plurk" | "web";

/** How the capture was obtained: Threads API, the open page, a text selection, or typed in by hand. */
export type SourceType = "api" | "page" | "selection" | "manual";

export type Completeness = "complete" | "partial" | "user-confirmed";

/** One picture or video found in a post or article. Only https URLs survive sanitizing. */
export interface MediaItem extends TextPlace {
  type: "image" | "video";
  /** Same value as `type`, kept for older code. */
  kind: "image" | "video";
  url: string;
  thumbnailUrl: string;
  alt: string;
  altText: string;
  width: number;
  height: number;
  /** Set once Notion has imported the file. */
  notionFileId: string;
}

/** A picture, link card or video that sat inside a post's text; without it, it follows the text. */
export interface TextPlace {
  /** Character offset in the text. */
  at?: number;
  /** Place among the post's attachments, for those at the same offset. */
  order?: number;
}

export interface LinkRef extends TextPlace {
  text: string;
  url: string;
}

/** A YouTube or Vimeo player embedded in a post, as its watch-page address. */
export interface VideoRef extends TextPlace {
  url: string;
}

export interface QuotedPost {
  mediaId: string;
  shortcode: string;
  canonicalUrl: string;
}

/** A post's own fields, also used for each continuation and author reply of a thread. */
export interface CaptureEntry {
  platform?: Platform;
  text: string;
  sourceUrl: string;
  canonicalUrl: string;
  shortcode: string;
  threadsMediaId: string;
  /** A handle for social posts; a byline for web pages. */
  author: string;
  /** ISO date, or "" when unknown. */
  publishedAt: string;
  topicTag: string;
  /** "2/5" style position inside the author's own thread, or "". */
  threadPosition: string;
  reviewFlags: string[];
  media: MediaItem[];
  /** Links found inside the text. */
  links: LinkRef[];
  /** Link preview cards, at most 10. */
  linkCards: LinkRef[];
  /** YouTube / Vimeo players embedded in the post, at most 5. */
  videos: VideoRef[];
  quotedPosts: QuotedPost[];
  sourceType: SourceType;
  completeness: Completeness;
  longTextAttachments: any[];
  longText: any;
  longTextDiagnostics: any;
  mediaDiagnostics: any;
  captureValidation: any;
  /** Present for web articles: sanitized blocks before they become Notion blocks. */
  articleBlocks?: unknown[];
  title?: string;
  siteName?: string;
  excerpt?: string;
}

/**
 * What the content script sends and `normalizeCapture` returns. Everything from the page is untrusted
 * and re-checked in `model/capture-model.js` before it is queued.
 */
export interface Capture extends CaptureEntry {
  id: string;
  schemaVersion: number;
  captureType: "post" | "selection";
  captureKind: "post" | "selection";
  /** Same author's later posts in the thread, in order. */
  continuations: CaptureEntry[];
  /** The author's unnumbered replies under their own post. */
  authorReplies: CaptureEntry[];
  /** Page address of an image -> key of its bytes in the media stage (storage/media-stage.js), read when the user saved. */
  stagedImages?: Record<string, string>;
  /** A web capture whose images are uploaded by the extension instead of imported by Notion. */
  downloadMedia?: boolean;
  /** Key used to find the same page again; see `model/dedupe-key.js`. */
  dedupeKey: string;
  /** ISO time the capture was made. */
  savedAt: string;
  capturedAt: string;
  lastSyncedAt: string;
  userConfirmedAt: string;
  /** Why the page may be incomplete, e.g. "page-completeness-unverified". */
  incompleteReasons: string[];
  relationshipMethod: string;
  rootPostId: string;
  titleHint: string;
}

export type QueueStatus = "pending" | "processing" | "failed";

/** A capture waiting to be written to Notion. Removed from the queue once saved. */
export interface QueueItem {
  id: string;
  capture: Capture;
  /** Add only the missing thread parts to an existing page. */
  appendMissing?: boolean;
  /** Replace the original on an existing page; the user's notes stay. */
  updateExisting?: boolean;
  /** For a selection added to an existing page. */
  appendTo?: { pageId: string; title: string };
  status: QueueStatus;
  /** Failed attempts so far; three failures (or a permanent error) mark the item "failed". */
  attempts: number;
  createdAt: string;
  lastError: string;
  /** When processing began; set while status is "processing". */
  startedAt?: string;
  /** A page this tool created but did not finish writing; a retry rebuilds it. */
  repairPartialPage?: boolean;
}

export type SaveResult =
  | "saved" | "saved_partial" | "appended" | "updated" | "already_saved"
  | "selection_appended" | "selection_exists";

/** One row of the popup's "recent" list. */
export interface RecentItem {
  key: string;
  title: string;
  notionUrl: string;
  result: SaveResult;
  at: string;
  /** What may be missing from the saved page (REVIEW_FLAGS); shown in the popup, not written to Notion. */
  reviewItems?: string[];
}

/** What is remembered locally about a page that is already in Notion. */
export interface SavedRecord {
  sourceUrl: string;
  title: string;
  author: string;
  captureType: string;
  notionPageId: string;
  notionUrl: string;
  savedAt: string;
  topicTag: string;
  reviewItems: string[];
  duplicateFoundInNotion: boolean;
  updatedExisting: boolean;
  longTextAttachmentCount: number;
  authorReplyPostIds: string[];
}

/** Everything in `chrome.storage.local` under STATE_KEY (`savourState`). */
export interface State {
  queue: QueueItem[];
  /** Keyed by capture key (model/dedupe-key.js). */
  saved: Record<string, SavedRecord>;
  recent: RecentItem[];
  lastSyncedAt: string;
  /** "pageId:textHash" -> ISO time the selection was added to that page (newest 500 kept). */
  selectionAppends: Record<string, string>;
  /** The few pages most recently chosen as an append target. */
  appendTargets: Array<{ pageId: string; title: string }>;
}

/** Everything in `chrome.storage.local` under CONFIG_KEY (`savourConfig`). */
export interface Config {
  archiveName: string;
  parentPageUrl: string;
  targetHandle: string;
  archiveTarget: string;
  dataSourceId: string;
  databaseId: string;
  databaseUrl: string;
  rememberToken: boolean;
  uiLanguage: "auto" | "zh" | "en";
  internalColumnsHiddenFor: string;
  columnMap: ColumnMap | null;
}

/** Which Notion column holds what in one archive; see notion/schema.js. */
export interface ColumnMap {
  dataSourceId: string;
  /** The language new columns and options of this archive are named in. */
  language: "zh" | "en";
  /** Column key (title, sourceUrl, ...) -> the column's Notion id and its name when last read. */
  columns: Record<string, { id: string; name: string }>;
  /** 來源 option key (threads, plurk, ...) -> the option's id, "" when the archive lacks it, and its name. */
  platformOptions: Record<string, { id: string; name: string }>;
}

/** `Config` as the pages see it: the token itself never leaves the background worker. */
export interface PublicConfig extends Config {
  hasToken: boolean;
}

/** What the popup reads with GET_STATUS. */
export interface Status {
  /** A token and an archive are both set, so saving can work. */
  configured: boolean;
  hasToken: boolean;
  hasArchive: boolean;
  archiveName: string;
  saved: number;
  pending: number;
  failed: number;
  databaseUrl: string;
  lastSyncedAt: string;
  recent: RecentItem[];
  incompleteThreads: Array<{ key: string; title: string; sourceUrl: string; notionUrl: string; savedAt: string }>;
}

/** Messages the extension's own pages send to the background worker with `chrome.runtime.sendMessage`. */
export type BackgroundMessage =
  | { type: "GET_STATUS" }
  | { type: "GET_CONFIG" }
  | { type: "SAVE_SETTINGS"; settings: Partial<Config> & { token?: string } }
  | { type: "CREATE_ARCHIVE" }
  | { type: "TEST_NOTION_AUTH" }
  | { type: "TEST_CONNECTION" }
  | { type: "LIST_NOTION_DATA_SOURCES"; token?: string }
  | { type: "SAVE_CAPTURES"; captures: unknown[]; verifyExisting?: boolean; confirmedLargeCreate?: boolean; createCountOffset?: number }
  | { type: "CAPTURE_ACTIVE_THREAD" }
  | { type: "UPDATE_ACTIVE_PAGE" }
  | { type: "CAPTURE_ACTIVE_SELECTION" }
  | { type: "GET_ACTIVE_PAGE_STATUS" }
  | { type: "RETRY_FAILED" }
  | { type: "CLEAR_RECENT" }
  | { type: "SYNC_NOTION_STATE" }
  | { type: "EXPORT_AUDIT" }
  // Only the picker window may send these; the worker checks the sender.
  | { type: "PICKER_SESSION"; token: string }
  | { type: "PICKER_SEARCH"; token: string; query: string }
  | { type: "PICKER_CHOOSE"; token: string; target: unknown }
  // Only the popup may send this.
  | { type: "TAKE_PENDING_PICKER" }
  | { type: "PREPARE_APPEND_PICKER" }
  // Only Savour's own content scripts may send these.
  | { type: "FETCH_PLURK_PASTE"; url: string }
  | { type: "READ_PLURK_PASTE_IN_TAB"; url: string };

/** Every background reply has this shape. */
export type BackgroundResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string; code: string; createCount?: number; limit?: number };

/**
 * A response body from api.notion.com. Notion's JSON is not validated, so it stays loosely typed;
 * read it with optional chaining and defaults.
 */
export type NotionJson = any;

export interface NotionRequestOptions {
  method?: string;
  body?: unknown;
  /** Defaults to the stored token. */
  token?: string;
  headers?: Record<string, string>;
  /** Allows retrying on 429, 5xx and network errors. */
  retrySafe?: boolean;
}

/** What `saveCaptureToNotion` and `appendSelectionToPage` return: the Notion page plus what happened. */
export interface NotionSaveResult {
  id: string;
  url: string;
  duplicateFoundInNotion?: boolean;
  updatedExisting?: boolean;
  selectionAlreadyOnPage?: boolean;
  appendedSelection?: boolean;
  /** Missing thread parts were added to the end of an existing page. */
  appendedContinuations?: boolean;
  /** The capture key the page had before this save, when it changed. */
  previousCaptureKey?: string;
  mediaUploadSummary?: MediaUploadSummary;
  [key: string]: unknown;
}

/** How many of a capture's pictures and videos were found and imported into Notion. */
export interface MediaUploadSummary {
  detected: number;
  uploaded: number;
  failed: number;
}

/** What the enqueue functions return: counts, then the current status. */
export interface EnqueueResult extends Status {
  added: number;
  duplicates: number;
  enqueuedIds: string[];
  /** A selection that is already on the target page. */
  alreadyOnPage?: boolean;
  /** For a selection append: the page it goes to. */
  target?: { pageId: string; title: string };
}

/** A tab with an id and a URL Savour can save. activeThreadsTab returns one; ensurePageScripts rejects any other URL. */
export type PageTab = chrome.tabs.Tab & { id: number; url: string };

/**
 * The services background.js builds and hands to its parts. Each part names the ones it uses with
 * `Pick<Services, ...>`, so a part cannot quietly depend on a service it does not declare.
 */
export interface Services {
  // Modules
  S: typeof import("./lib/shared.js");
  D: typeof import("./model/dedupe-key.js");
  N: typeof import("./notion/index.js");
  I: typeof import("./i18n/index.js");
  CONFIG_KEY: string;
  INCOMPLETE_THREAD_FLAG: string;

  // Settings and state (storage/)
  readConfig(): Promise<Config>;
  readToken(): Promise<string>;
  /** Throws a user-readable error when no token is set. */
  requireToken(): Promise<string>;
  readState(): Promise<State>;
  /** Call inside `withStateLock` after `readState`. */
  writeState(state: State): Promise<void>;
  withStateLock<T>(task: () => Promise<T>): Promise<T>;

  // Notion (notion/)
  notionRequest(path: string, options: NotionRequestOptions): Promise<NotionJson>;
  ensureArchiveSchema(dataSourceId: string, token: string, options?: { force?: boolean }): Promise<NotionJson>;
  saveCaptureToNotion(capture: Capture, dataSourceId: string, token: string, options?: { repairPartialPage?: boolean; appendMissing?: boolean; updateExisting?: boolean}): Promise<NotionSaveResult>;
  appendSelectionToPage(capture: Capture, pageId: string, dataSourceId: string, token: string): Promise<NotionSaveResult>;

  // Captures (model/)
  /** Normalizes an untrusted capture from a page. */
  sanitizeCapture(raw: unknown): Capture;
  /** Throws when the capture fails validation. */
  assertCaptureIntegrity(capture: Capture): unknown;
  hasValidCaptureIntegrity(capture: Capture): boolean;

  // Queue (queue/retry.js)
  enqueueCaptures(rawCaptures: unknown[], options?: { verifyExisting?: boolean; confirmedLargeCreate?: boolean; createCountOffset?: number; appendMissing?: boolean; updateExisting?: boolean }): Promise<EnqueueResult>;
  enqueueSelectionAppend(rawCapture: unknown, target: { pageId: string; title: string }): Promise<EnqueueResult>;
  isProcessing(): boolean;
  scheduleQueue(delayMs?: number): void;

  // Status (background/status-sync.js)
  getStatus(): Promise<Status>;

  // Tabs (background/tabs.js)
  /** The active tab when it is a web page that can be saved; throws otherwise. */
  activeThreadsTab(): Promise<PageTab>;
  /** Sends a message to the tab's content script and unwraps the `{ ok, result }` reply. */
  sendToTab(tabId: number, message: { type: string; [key: string]: unknown }): Promise<any>;
  sendToTabWhenReady(tabId: number, message: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<any>;
  ensurePageScripts(tab: PageTab): Promise<unknown>;
  /** Reloads the tab once when its page data is stale; true when it reloaded. */
  ensureFreshThreadPage(tabId: number): Promise<boolean>;
  /** Reads one image from inside the tab's page (the image sites allow their own pages); the bytes come as base64. */
  fetchImageInTab(tabId: number, url: string, maxBytes?: number, timeoutMs?: number): Promise<{ ok: boolean; type?: string; size?: number; base64?: string; error?: string }>;
  /** Images read from the page when the user saved, kept until they are uploaded. */
  mediaStage: ReturnType<typeof import("./storage/media-stage.js").createMediaStage>;
}
