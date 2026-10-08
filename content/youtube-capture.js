/**
 * YouTube capture: reads one video page - title, channel, publish date, description and chapters - from
 * the player data YouTube ships with the page, and saves it as a web article with the video embedded.
 *
 * It does not save subtitles, comments or the video file; Notion plays the video from YouTube.
 * Created by content/web-content.js on youtube.com/watch pages.
 */
(function initializeSavourYouTubeCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourYouTubeCapture = api;
})(globalThis, function createSavourYouTubeCaptureModule() {
  "use strict";

  const CAPTURE_VALIDATION_VERSION = 2;
  const MAX_DESCRIPTION = 20000;
  const MAX_CHAPTERS = 100;
  const CHAPTER_LINE = /^\s*(?:[-•·▶►]\s*)?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[-–—:|]?\s*(.+?)\s*$/;
  const URL_PATTERN = /https?:\/\/[^\s<>"'「」『』（）()[\]{}]+/g;

  // The JSON object that starts at text[start] (a "{"), found by matching braces outside of strings.
  function jsonObjectAt(/** @type {string} */ text, /** @type {number} */ start) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === "\\") index += 1;
        else if (char === "\"") inString = false;
      } else if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return "";
  }

  /**
   * Finds the player data (`ytInitialPlayerResponse`) inside a page's HTML or script text.
   * @returns {any} the parsed object, or null when the text has none or it does not parse
   */
  function parsePlayerResponse(/** @type {string} */ text) {
    const marker = /ytInitialPlayerResponse\s*=\s*\{/.exec(String(text ?? ""));
    if (!marker) return null;
    try {
      return JSON.parse(jsonObjectAt(text, marker.index + marker[0].length - 1));
    } catch {
      // A cut-off or changed script counts as no player data; buildCapture then reports it.
      return null;
    }
  }

  function toSeconds(/** @type {string} */ clock) {
    return clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  }

  function clock(/** @type {number} */ seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
  }

  /**
   * Chapters the creator wrote into the description as "0:00 Intro" lines. YouTube treats them as chapters
   * only when there are at least three, the first at 0:00, each later than the one before.
   * @returns {{ seconds: number, label: string, title: string }[]} empty when the lines are not chapters
   */
  function parseChapters(/** @type {string} */ description) {
    const chapters = [];
    for (const line of String(description ?? "").split("\n")) {
      const match = line.match(CHAPTER_LINE);
      if (!match) continue;
      const seconds = toSeconds(match[1]);
      if (seconds <= (chapters.at(-1)?.seconds ?? -1)) continue;
      chapters.push({ seconds, label: clock(seconds), title: match[2].replace(/\s+/g, " ").slice(0, 200) });
      if (chapters.length >= MAX_CHAPTERS) break;
    }
    return chapters.length >= 3 && chapters[0].seconds === 0 ? chapters : [];
  }

  /**
   * Plain text as spans, with web addresses turned into links.
   * @returns {{ text: string, href?: string }[]}
   */
  function linkSpans(/** @type {string} */ text) {
    const spans = [];
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      if (match.index > last) spans.push({ text: text.slice(last, match.index) });
      spans.push({ text: url, href: url });
      last = match.index + url.length;
    }
    if (last < text.length) spans.push({ text: text.slice(last) });
    return spans;
  }

  /**
   * Creates the YouTube reader for the current page.
   * @param {any} options `shared`: lib/shared.js
   * @returns captureVideo, which throws when the page is not a video or its data cannot be read
   */
  function createYouTubeCapture(/** @type {any} */ options) {
    const S = options.shared;

    // Builds the capture from the player data of one video; throws when the data is not that video's.
    function buildCapture(/** @type {any} */ player, /** @type {string} */ videoId) {
      const details = player?.videoDetails;
      if (!details || details.videoId !== videoId) {
        throw new Error(S.t("沒有讀到這支影片的資料，請重新整理頁面後再試一次"));
      }
      const micro = player.microformat?.playerMicroformatRenderer ?? {};
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const title = S.cleanText(details.title ?? micro.title?.simpleText ?? "").replace(/\s+/g, " ").slice(0, 300);
      const channel = S.cleanText(details.author ?? micro.ownerChannelName ?? "").replace(/\s+/g, " ").slice(0, 200);
      const description = String(details.shortDescription ?? micro.description?.simpleText ?? "")
        .replace(/\r\n?/g, "\n").trim().slice(0, MAX_DESCRIPTION);
      const published = micro.publishDate || micro.uploadDate || "";
      const length = Number(details.lengthSeconds) || 0;

      /** @type {any[]} */
      const blocks = [{ type: "video", url: watchUrl }];
      const info = [];
      if (channel) {
        const channelUrl = S.webLinkUrl(micro.ownerProfileUrl)
          || (details.channelId ? `https://www.youtube.com/channel/${details.channelId}` : "");
        info.push({ text: S.t("頻道："), bold: true }, channelUrl ? { text: channel, href: channelUrl } : { text: channel });
      }
      if (length) info.push({ text: `${info.length ? "  " : ""}${S.t("長度：")}${clock(length)}` });
      if (info.length) blocks.push({ type: "paragraph", spans: info });

      const chapters = parseChapters(description);
      if (chapters.length) {
        blocks.push({ type: "heading", level: 2, spans: [{ text: S.t("章節") }] });
        for (const chapter of chapters) {
          blocks.push({
            type: "bulleted",
            spans: [{ text: chapter.label, href: `${watchUrl}&t=${chapter.seconds}s` }, { text: ` ${chapter.title}` }]
          });
        }
      }
      if (description) {
        blocks.push({ type: "heading", level: 2, spans: [{ text: S.t("資訊") }] });
        for (const paragraph of description.split(/\n{2,}/)) {
          if (paragraph.trim()) blocks.push({ type: "paragraph", spans: linkSpans(paragraph.trim()) });
        }
      }

      return {
        platform: "web",
        captureType: "post",
        sourceUrl: watchUrl,
        title,
        siteName: "YouTube",
        author: channel,
        publishedAt: S.validDate(published) ? published : "",
        excerpt: description.replace(/\s+/g, " ").slice(0, 300),
        text: "",
        articleBlocks: blocks,
        captureValidation: { version: CAPTURE_VALIDATION_VERSION, source: "web-page", postId: "", validated: true },
        continuations: /** @type {any[]} */ ([]),
        authorReplies: /** @type {any[]} */ ([]),
        ...(details.isLive ? { reviewFlags: ["正文疑似遺漏"], captureNotes: [S.t("這是直播，只保存了目前的影片資訊。")] } : {})
      };
    }

    // The player data for the video on screen. The copy embedded in the page belongs to the page that was
    // loaded first, so after YouTube switches videos in place it is checked against the address and, if it
    // is another video's, the watch page is fetched again.
    async function readPlayer(/** @type {string} */ videoId) {
      for (const script of document.scripts) {
        if (!script.textContent?.includes("ytInitialPlayerResponse")) continue;
        const player = parsePlayerResponse(script.textContent);
        if (player?.videoDetails?.videoId === videoId) return player;
      }
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(S.t("沒有讀到這支影片的資料，請重新整理頁面後再試一次"));
      return parsePlayerResponse(await response.text());
    }

    async function captureVideo() {
      const videoId = S.youtubeVideoId(location.href);
      if (!videoId) throw new Error(S.t("請先點開一支 YouTube 影片（網址是 youtube.com/watch?v=…）再保存"));
      return buildCapture(await readPlayer(videoId), videoId);
    }

    return { buildCapture, captureVideo };
  }

  return { createYouTubeCapture, parsePlayerResponse, parseChapters, linkSpans };
});
