/**
 * Plurk capture: reads a plurk and its author's replies, and fetches long text from a Plurk Paste link
 * through a reader supplied by plurk-content.js.
 */
(function initializeSavourPlurkCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourPlurkCapture = api;
})(globalThis, function createSavourPlurkCaptureModule() {
  "use strict";

  const CAPTURE_VALIDATION_VERSION = 2;

  /**
   * Builds the Plurk capture flows. `options.readPaste(url)` reads a paste.plurk.com page through the worker.
   */
  function createPlurkCapture(/** @type {any} */ options) {
    const S = options.shared;
    // readPaste(url) resolves to { title, text } or throws; supplied by the content script wiring.
    const readPaste = options.readPaste;

    function currentPlurkId() {
      return S.parseThreadsUrl(location.href).platform === "plurk" ? S.parseThreadsUrl(location.href).postId : "";
    }

    function permalinkRoot() {
      return document.querySelector("#permanent-plurk");
    }

    function mainTextHolder(/** @type {Element} */ container) {
      return [...container.querySelectorAll(".text_holder")].find(node => !node.closest(".response")) ?? null;
    }

    function isEmoticon(/** @type {any} */ image) {
      return /emoticon/i.test(image.className) || /(^|\.)emos\.plurk\.com$/i.test(hostOf(image.src));
    }

    function hostOf(/** @type {string} */ url) {
      try {
        return new URL(url, location.href).hostname;
      } catch {
        return "";
      }
    }

    // Plain text of a text_holder: <br> become line breaks; emoticons, uploaded-image thumbnails
    // and link-preview cards are left out (they are saved as images / bookmarks instead).
    // `videoMarks`, when given, receives { url, at } for each embedded video: the length of the cleaned text before it.
    function holderText(/** @type {Element} */ holder, /** @type {any[] | null} */ videoMarks = null) {
      let text = "";
      const walk = (/** @type {Element} */ node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            text += child.nodeValue;
          } else if (child.nodeName === "BR") {
            text += "\n";
          } else if (child instanceof Element) {
            if (videoMarks && child.matches("iframe[src]")) {
              const url = S.embeddedVideoWatchUrl(child.getAttribute("src"));
              if (url) videoMarks.push({ url, at: S.cleanText(text).length });
              continue;
            }
            if (child.matches("img") && isEmoticon(child)) continue;
            if (child.matches("a.pictureservices, a.meta")) continue;
            walk(child);
          }
        }
      };
      walk(holder);
      return S.cleanText(text);
    }

    function holderLinks(/** @type {Element} */ holder) {
      return S.normalizeLinks([...holder.querySelectorAll("a[href]")]
        .filter(anchor => !anchor.matches(".pictureservices, .meta"))
        .map(anchor => ({ text: S.cleanText(anchor.textContent), url: anchor.href })));
    }

    function holderLinkCards(/** @type {Element} */ holder, /** @type {any} */ links) {
      const inline = new Set(links.map((/** @type {any} */ link) => link.url));
      return S.normalizeLinks([...holder.querySelectorAll("a.meta[href]")]
        .map(anchor => ({ text: S.cleanText(anchor.textContent), url: anchor.href }))
        .filter(card => !inline.has(card.url)), 10);
    }

    function holderMedia(/** @type {Element} */ holder) {
      const seen = new Set();
      return [...holder.querySelectorAll("a.pictureservices[href]")]
        .map(anchor => ({ url: anchor.href, thumbnail: anchor.querySelector("img")?.src ?? "" }))
        .filter(item => /^https:\/\//i.test(item.url) && !seen.has(item.url) && seen.add(item.url))
        .map(item => ({ type: "image", url: item.url, thumbnailUrl: item.thumbnail, alt: "", width: 0, height: 0 }));
    }

    function holderPasteLinks(/** @type {Element} */ holder) {
      return [...new Set([...holder.querySelectorAll("a.plurkpaste[href], a[href*='paste.plurk.com/show/']")]
        .map(anchor => anchor.href)
        .filter(url => S.isPlurkPasteUrl(url)))];
    }

    async function pasteAttachments(/** @type {Element} */ holder) {
      const attachments = [];
      const failures = [];
      for (const url of holderPasteLinks(holder).slice(0, 10)) {
        try {
          const paste = await readPaste(url);
          if (!S.cleanText(paste?.text)) throw new Error(S.t("沒有讀到內容"));
          attachments.push({
            title: `Plurk Paste：${S.cleanText(paste.title) || "長文"}`.slice(0, 200),
            text: paste.text,
            source: "plurk_paste"
          });
        } catch {
          failures.push(url);
        }
      }
      return { attachments, failures };
    }

    function authorOf(/** @type {Element} */ container) {
      const name = container.querySelector(".user a.name, a.name");
      const href = name?.getAttribute("href") ?? "";
      const handle = S.cleanHandle(href.replace(/^\//, "").split(/[/?#]/)[0]);
      // Whispers link to /anonymous; their display name is the only identity shown.
      return handle && handle !== "anonymous" ? handle : S.cleanText(name?.textContent ?? "");
    }

    function responseNames() {
      return new Set([...document.querySelectorAll(".response .user a.name")]
        .map(node => S.cleanText(node.textContent))
        .filter(Boolean));
    }

    // A reply that starts with "readername: " answers someone; the author's other replies extend the plurk.
    function isAddressedReply(/** @type {string} */ text, /** @type {any} */ names) {
      const match = S.cleanText(text).match(/^([^\n:：]{1,40})[:：]\s/);
      return Boolean(match && names.has(S.cleanText(match[1])));
    }

    async function buildEntry(/** @type {Element} */ holder, /** @type {any} */ base) {
      const links = holderLinks(holder);
      const { attachments, failures } = await pasteAttachments(holder);
      // YouTube and Vimeo players the page draws in place of a pasted video link, with where they sit in the text.
      const videoMarks = /** @type {any[]} */ ([]);
      const text = holderText(holder, videoMarks);
      return {
        ...base,
        text,
        links,
        linkCards: holderLinkCards(holder, links),
        media: holderMedia(holder),
        videos: videoMarks.map(mark => mark.url),
        videoOffsets: videoMarks.map(mark => Math.min(mark.at, text.length)),
        longTextAttachments: attachments,
        reviewFlags: failures.length ? ["正文疑似遺漏"] : [],
        pasteFailures: failures
      };
    }

    /**
     * Captures the open plurk: text, pictures, links, and the text of any paste.plurk.com long post it links to.
     * Throws when the page content does not belong to the plurk in the URL.
     */
    async function captureCurrentPlurk() {
      const plurkId = currentPlurkId();
      const container = permalinkRoot();
      if (!plurkId || !container) throw new Error(S.t("請先開啟噗浪的單篇噗文（網址是 plurk.com/p/…）再保存"));
      const holder = mainTextHolder(container);
      if (!holder) throw new Error(S.t("找不到這則噗的內容，請等頁面載入完成後再試一次"));
      // The URL id is the base-36 form of the numeric plurk id the page renders; they must agree.
      const numericId = container.querySelector(".plurk[data-pid]:not(.response)")?.getAttribute("data-pid") ?? "";
      if (numericId && parseInt(plurkId, 36) !== Number(numericId)) {
        throw new Error(S.t("頁面內容與網址不是同一則噗，已取消保存"));
      }
      const sourceUrl = S.normalizeThreadsUrl(location.href);
      const validation = { version: CAPTURE_VALIDATION_VERSION, source: "plurk-page", postId: plurkId, validated: true };
      const author = authorOf(container);
      const publishedAt = container.querySelector(".posted[data-posted]")?.getAttribute("data-posted") || "";
      const root = await buildEntry(holder, {
        platform: "plurk",
        captureType: "post",
        sourceUrl,
        author,
        publishedAt,
        topicTag: "",
        threadPosition: "",
        quotedPosts: [],
        continuations: [],
        titleHint: document.title,
        captureValidation: validation
      });

      const ownerName = S.cleanText(container.querySelector("a.name")?.textContent ?? "");
      const names = responseNames();
      if (ownerName) names.delete(ownerName);
      const authorReplies = [];
      const ownerResponses = [...document.querySelectorAll(".response.highlight_owner[data-rid]")]
        .filter(response => !numericId || response.getAttribute("data-pid") === numericId);
      for (const response of ownerResponses) {
        const replyHolder = response.querySelector(".text_holder");
        if (!replyHolder || isAddressedReply(holderText(replyHolder), names)) continue;
        const entry = await buildEntry(replyHolder, {
          sourceUrl,
          responseId: response.getAttribute("data-rid"),
          author,
          publishedAt: response.querySelector(".posted[data-posted]")?.getAttribute("data-posted") || "",
          threadPosition: "",
          quotedPosts: [],
          captureValidation: validation
        });
        if (entry.text || entry.media.length || entry.videos.length || entry.longTextAttachments.length) authorReplies.push(entry);
      }

      const pasteFailures = [root, ...authorReplies].flatMap(entry => entry.pasteFailures ?? []);
      const capture = { ...root, authorReplies };
      if (pasteFailures.length) {
        capture.captureNotes = [S.t("有 {n} 篇 Plurk Paste 長文沒有讀到，已保存連結；可稍後再試一次。", { n: pasteFailures.length })];
      }
      if (!capture.text && !capture.media.length && !capture.longTextAttachments.length) {
        throw new Error(S.t("沒有讀到這則噗的正文、圖片或長文，本次已取消"));
      }
      return capture;
    }

    /**
     * Captures the selected text on a Plurk page with its links. Throws when nothing is selected.
     * @param {string} selectionText the context menu's copy of the selection, used when the page has none
     */
    function captureSelection(selectionText) {
      const selection = window.getSelection();
      // The page's own selection keeps line breaks; the context menu's selectionText flattens them.
      const text = S.cleanText(selection?.toString() || selectionText || "");
      if (!text) throw new Error(S.t("請先選取想保存的文字"));
      const anchors = selection?.rangeCount ? [...selection.getRangeAt(0).cloneContents().querySelectorAll("a[href]")] : [];
      return {
        platform: "plurk",
        captureType: "selection",
        text,
        sourceUrl: S.normalizeThreadsUrl(location.href),
        author: currentPlurkId() && permalinkRoot() ? authorOf(/** @type {Element} */ (permalinkRoot())) : "",
        publishedAt: "",
        links: S.normalizeLinks(anchors.map(anchor => ({ text: anchor.textContent, url: anchor.href }))),
        continuations: /** @type {any[]} */ ([]),
        titleHint: document.title
      };
    }

    return { captureCurrentPlurk, captureSelection, holderText, isAddressedReply };
  }

  return { createPlurkCapture };
});
