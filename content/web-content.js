/**
 * Content script for ordinary web pages, injected on demand into the tab the user chose to save.
 * Answers capture messages with an article, an X post, a YouTube video, a LinkedIn or Facebook post or a selection depending on the page.
 */
(function initializeSavourWebContent() {
  "use strict";

  // Injected on demand into the tab the user chose to save (any page except Threads and Plurk,
  // which have their own content scripts). Injecting twice must not add a second listener, but a
  // copy left over from before the extension was reloaded can no longer answer and is replaced.
  if (globalThis.__savourWebContentAlive?.()) return;
  const S = globalThis.SavourShared;
  const T = globalThis.SavourToast;
  const WA = globalThis.SavourWebArticle;
  const XC = globalThis.SavourXCapture;
  const YC = globalThis.SavourYouTubeCapture;
  const LC = globalThis.SavourLinkedInCapture;
  const FC = globalThis.SavourFacebookCapture;
  if (!S || !T || !WA || !XC || !YC || !LC || !FC || typeof globalThis.Readability !== "function") return;
  globalThis.__savourWebContentAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  const article = WA.createWebArticleCapture({ shared: S, Readability: globalThis.Readability });
  const xPost = XC.createXCapture({ shared: S });
  const youtube = YC.createYouTubeCapture({ shared: S });
  const linkedIn = LC.createLinkedInCapture({ shared: S });
  const facebook = FC.createFacebookCapture({ shared: S });

  function isX() {
    return S.isXUrl(location.href);
  }

  function capturePage() {
    if (isX()) return xPost.captureStatus(S.xStatusInfo(location.href).statusId);
    if (S.youtubeVideoId(location.href)) return youtube.captureVideo();
    if (S.isFacebookUrl(location.href)) return facebook.captureStatus();
    // LinkedIn articles (/pulse/) read like web articles; everything else there is a post page or a feed.
    if (S.isLinkedInUrl(location.href) && !location.pathname.startsWith("/pulse/")) return linkedIn.captureStatus();
    return article.captureArticle();
  }

  function captureSelection(/** @type {string} */ selectionText) {
    const selection = window.getSelection();
    // The page's own selection keeps line breaks; the context menu's selectionText flattens them.
    const text = S.cleanText(selection?.toString() || selectionText || "");
    if (!text) throw new Error(S.t("請先選取想保存的文字"));
    const anchors = selection?.rangeCount ? [...selection.getRangeAt(0).cloneContents().querySelectorAll("a[href]")] : [];
    const sourceUrl = S.normalizeThreadsUrl(location.href);
    const parsed = S.parseThreadsUrl(sourceUrl);
    return {
      platform: isX() ? "x" : "web",
      captureType: "selection",
      text,
      sourceUrl,
      author: parsed.platform === "x" ? parsed.handle : "",
      publishedAt: "",
      links: S.normalizeLinks(anchors.map(anchor => ({ text: anchor.textContent, url: anchor.href }))),
      continuations: /** @type {any[]} */ ([]),
      titleHint: document.title
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve()
      .then(() => handleMessage(message))
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  function handleMessage(/** @type {any} */ message) {
    // The background sends the interface language with every message.
    globalThis.SavourI18n?.setLanguage(message?.lang);
    switch (message?.type) {
      case "PING":
        return { ready: true };
      case "CAPTURE_CURRENT_THREAD":
        return capturePage();
      case "CAPTURE_SELECTION":
        return captureSelection(message.selectionText);
      case "GET_PAGE_DATA_STATUS":
        return { stale: false };
      case "WAIT_FOR_POST":
        return { ready: true };
      case "SHOW_TOAST":
        T.showToast(message.message, message.tone);
        return { shown: true };
      default:
        throw new Error(S.t("頁面不支援這個擷取操作"));
    }
  }
})();
