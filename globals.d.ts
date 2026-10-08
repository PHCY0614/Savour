/**
 * Globals for type checking only (`npm run typecheck`); nothing here exists as a file at runtime.
 */

// The service worker loads its modules with importScripts, and every module attaches itself to the
// global scope under one of these names.
declare function importScripts(...urls: string[]): void;
declare var SavourI18n: typeof import("./i18n/index.js");
declare var SavourI18nEnglish: typeof import("./i18n/en.js");
declare var SavourShared: typeof import("./lib/shared.js");
declare var SavourToast: typeof import("./content/toast.js");
declare var SavourNotion: typeof import("./notion/index.js");
declare var SavourNotionSchema: typeof import("./notion/schema.js");
declare var SavourNotionPageBuilder: typeof import("./notion/page-builder.js");
declare var SavourNotionHttp: typeof import("./notion/http.js");
declare var SavourNotionRepository: typeof import("./notion/repository.js");
declare var SavourStorageConfig: typeof import("./storage/config.js");
declare var SavourStorageState: typeof import("./storage/state.js");
declare var SavourMediaStage: typeof import("./storage/media-stage.js");
declare var SavourDedupeKey: typeof import("./model/dedupe-key.js");
declare var SavourSourceFlags: typeof import("./model/source-flags.js");
declare var SavourCaptureModel: typeof import("./model/capture-model.js");
declare var SavourArticleBlocks: typeof import("./model/article-blocks.js");
declare var SavourQueueRetry: typeof import("./queue/retry.js");
declare var SavourPicker: typeof import("./pages/picker/picker.js");
declare var SavourDomScope: typeof import("./content/dom-scope.js");
declare var SavourDomExtract: typeof import("./content/dom-extract.js");
declare var SavourLegacyDiscussionDom: typeof import("./content/legacy-discussion-dom.js");
declare var SavourLegacyDiscussionData: typeof import("./content/legacy-discussion-data.js");
declare var SavourPageCapture: typeof import("./content/page-capture.js");
declare var SavourWebArticle: typeof import("./content/web-article.js");
declare var SavourXCapture: typeof import("./content/x-capture.js");
declare var SavourYouTubeCapture: typeof import("./content/youtube-capture.js");
declare var SavourLinkedInCapture: typeof import("./content/linkedin-capture.js");
declare var SavourFacebookCapture: typeof import("./content/facebook-capture.js");
declare var SavourInstagramCapture: typeof import("./content/instagram-capture.js");
declare var SavourPlurkCapture: typeof import("./content/plurk-capture.js");
declare var SavourBackgroundTabs: typeof import("./background/tabs.js");
declare var SavourBackgroundPlurkPaste: typeof import("./background/plurk-paste.js");
declare var SavourBackgroundArchive: typeof import("./background/archive.js");
declare var SavourBackgroundCaptureFlow: typeof import("./background/capture-flow.js");
declare var SavourBackgroundAppendPicker: typeof import("./background/append-picker.js");
declare var SavourBackgroundStatusSync: typeof import("./background/status-sync.js");
declare var Readability: any;
declare var __savourWebContentAlive: (() => boolean) | undefined;

// The content scripts look elements up with selectors such as "a[href]" or "button" and then read these
// properties directly, so they are declared on every Element instead of cast at each call site. Read
// them only where the selector guarantees them. innerText stays optional: callers fall back to textContent.
interface Element {
  href: string;
  innerText?: string;
  click(): void;
  focus(): void;
  dataset: DOMStringMap;
}

// The code attaches extra fields to errors it throws (an HTTP status, a machine-readable code, ...)
// and reads them where the error is caught.
interface Error {
  code?: string;
  status?: number;
  permanent?: boolean;
  privateNetwork?: boolean;
  partialPageCreated?: boolean;
  createCount?: number;
  limit?: number;
}
