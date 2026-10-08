/**
 * Pure helpers used by every other module: text cleaning, URL parsing per site, capture keys,
 * titles, Notion id extraction and the review-flag names.
 *
 * No Chrome APIs and no DOM except where a function takes a document as an argument, so it loads in
 * the service worker, content scripts, extension pages and Node tests alike.
 * Exposed as `SavourShared` (or `module.exports` under Node).
 */
(function attachSavourShared(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SavourShared = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createShared() {
  "use strict";

  const THREADS_HOSTS = new Set([
    "threads.com",
    "www.threads.com",
    "threads.net",
    "www.threads.net"
  ]);
  const PLURK_HOSTS = new Set(["plurk.com", "www.plurk.com", "m.plurk.com"]);
  const PLURK_POST_PATH = /^\/(?:m\/)?p\/([0-9a-z]+)\/?$/i;
  const X_HOSTS = new Set([
    "x.com",
    "www.x.com",
    "mobile.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com"
  ]);
  const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
  const INSTAGRAM_POST_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})\/?/;
  const X_STATUS_PATH = /^\/(?:([A-Za-z0-9_]{1,15})|i\/web|i)\/status(?:es)?\/(\d{1,25})(?:\/.*)?$/;
  const X_RESERVED_PATHS = /^(?:i|home|search|explore|settings|messages|notifications|compose|intent|share)$/i;
  // Query parameters that only record where a visit came from; they never change what a page shows.
  const TRACKING_PARAM_PATTERN = /^(?:utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|igsh|mc_cid|mc_eid|_ga|_gl|_hsenc|_hsmi|mkt_tok|oly_anon_id|oly_enc_id|vero_id|share_source|ref_src|ref_url|s_cid|cmpid|at_medium|at_campaign)$/i;
  // X post ids carry their creation time since late 2010 (snowflake ids).
  const X_SNOWFLAKE_EPOCH = 1288834974657;
  const X_SNOWFLAKE_MIN_ID = 2n ** 22n * 1000n;
  const RELATIVE_TIME_PATTERN =/^\d+(?:\.\d+)?\s*(?:s|m|h|d|w|秒|分|分鐘|小時|天|週)$/i;
  const COUNT_PATTERN = /^\d+(?:[.,]\d+)?\s*[kmb萬千]?$/i;
  const THREAD_POSITION_PATTERN = /^(\d{1,4})\s*\/\s*(\d{1,4})$/;
  const THREAD_TOPIC_METADATA_PATTERN = /^(?:threads\s*)?(?:topic(?:\s*tag)?|主題(?:標籤)?)\s*[：:]\s*.+$/i;
  const REVIEW_FLAGS = Object.freeze([
    "串文未完整",
    "正文疑似遺漏",
    "圖片未完整"
  ]);

  // Interface text: see i18n/index.js. Without it (a mocked test) the Chinese text is returned as is.
  /**
   * @param {string} text
   * @param {Record<string, string | number>} [params]
   * @returns {string}
   */
  function t(text, params) {
    const i18n = typeof module === "object" && module.exports ? require("../i18n/index.js") : globalThis.SavourI18n;
    if (i18n) return i18n.t(text, params);
    return params ? String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : String(text);
  }

  /**
   * Normalizes line endings and tabs, trims spaces around line breaks, allows at most one blank line, trims the ends.
   * @param {unknown} value
   * @returns {string}
   */
  function cleanText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t\f\v]+/g, " ")
      .replace(/[ \u00a0]+\n/g, "\n")
      .replace(/\n[ \u00a0]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Lower-case account handle: leading @ and anything after / ? # removed.
   * @param {unknown} value
   * @returns {string}
   */
  function cleanHandle(value) {
    return String(value ?? "")
      .trim()
      .replace(/^@+/, "")
      .split(/[/?#]/)[0]
      .toLowerCase();
  }

  function parseThreadPosition(/** @type {any} */ value) {
    const singleLine = cleanText(value).replace(/\s+/g, " ");
    const match = singleLine.match(THREAD_POSITION_PATTERN);
    if (!match) return null;
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 2 || index < 1 || index > total) {
      return null;
    }
    return { index, total };
  }

  function stripThreadsMetadataLines(/** @type {any} */ value, topicTag = "") {
    const normalizedTopic = cleanText(topicTag).replace(/^#+/, "").trim();
    const kept = cleanText(value)
      .split("\n")
      .map(line => cleanText(line))
      .map(line => {
        if (!line) return "";
        if (line === "/" || THREAD_TOPIC_METADATA_PATTERN.test(line)) return null;
        const normalizedLine = line.replace(/^#+/, "").trim();
        if (normalizedTopic && normalizedLine === normalizedTopic) return null;
        return line;
      })
      .filter(line => line !== null);
    return cleanText(kept.join("\n"));
  }

  function hiddenLongTextCandidate(/** @type {any} */ visibleValue, /** @type {any} */ rawValue, postText = "") {
    const visibleText = cleanText(visibleValue);
    const rawText = cleanText(rawValue);
    if (rawText.length < 160 || rawText.length < visibleText.length + 80) return "";
    if (rawText.length > 100000 || rawText === cleanText(postText)) return "";
    return rawText;
  }

  function isThreadsUiText(/** @type {any} */ value, author = "") {
    const singleLine = cleanText(value).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    if (!singleLine) return true;
    if (singleLine === "/" || THREAD_TOPIC_METADATA_PATTERN.test(singleLine)) return true;
    const normalizedAuthor = cleanHandle(singleLine);
    if (author && normalizedAuthor === cleanHandle(author)) return true;
    if (RELATIVE_TIME_PATTERN.test(singleLine) || COUNT_PATTERN.test(singleLine)) return true;
    if (/^\d{4}(?:[-/.]\d{1,2}){2}$/.test(singleLine) || /^\d{4}年\d{1,2}月\d{1,2}日$/.test(singleLine)) return true;
    if (/^(?:like|reply|repost|quote|share|follow|following|translate|see translation|more|view activity|views?|likes?|replies|reposts?|引用|分享|追蹤|追蹤中|翻譯|查看翻譯|更多|查看動態|瀏覽次數|讚|回覆|轉發)$/i.test(singleLine)) return true;
    if (/^(?:串文|thread)(?:\s+\d+(?:[.,]\d+)?\s*[kmb萬千]?\s*(?:次)?(?:瀏覽|views?))?$/i.test(singleLine)) return true;
    if (/^\d+(?:[.,]\d+)?\s*[kmb萬千]?\s*(?:次)?(?:瀏覽|views?)$/i.test(singleLine)) return true;
    if (/^(?:熱門|推薦(?:貼文|內容)?|top|most relevant|suggested(?: posts?)?|閱讀全文|read (?:the )?full text|無地點資料|no location data|新帳號)$/i.test(singleLine)) return true;
    if (/^(?:已釘選|置頂|pinned(?: post)?|作者|author|[·•](?:\s*(?:作者|author))?)$/i.test(singleLine)) return true;
    if (/^回覆已無法顯示的貼文$/.test(singleLine)) return true;
    if (/^(?:回覆|replying to)\s*@?[\w.]+(?:…+|\.{3,})?$/i.test(singleLine)) return true;
    if (/^@?[\w.]+\s+(?:follow|following|追蹤|追蹤中)$/i.test(singleLine)) return true;
    return false;
  }

  function choosePostCandidate(/** @type {any} */ candidates, /** @type {any} */ targetPostId) {
    const target = String(targetPostId ?? "");
    const eligible = (candidates ?? []).filter((/** @type {any} */ candidate) => {
      const postIds = [...new Set((candidate?.postIds ?? []).filter(Boolean))];
      if (!candidate || candidate.connected === false || candidate.visible === false) return false;
      if (candidate.directPostId !== target || !postIds.includes(target)) return false;
      if (!candidate.semantic && Number(candidate.nestedPostCount) > 0) return false;
      if (!candidate.semantic && postIds.length > 1 && !candidate.embeddedPostsContained) return false;
      return true;
    });
    eligible.sort((/** @type {any} */ left, /** @type {any} */ right) => {
      if (Boolean(left.hasTextEvidence) !== Boolean(right.hasTextEvidence)) return left.hasTextEvidence ? -1 : 1;
      // A post's own card beats larger ancestors that may also hold a neighbouring post's text.
      const leftOwn = Boolean(left.ownCard && left.hasTextEvidence);
      const rightOwn = Boolean(right.ownCard && right.hasTextEvidence);
      if (leftOwn !== rightOwn) return leftOwn ? -1 : 1;
      const textDifference = (Number(right.textEvidenceLength) || 0) - (Number(left.textEvidenceLength) || 0);
      if (textDifference) return textDifference;
      const mediaDifference = (Number(right.mediaEvidenceCount) || 0) - (Number(left.mediaEvidenceCount) || 0);
      if (mediaDifference) return mediaDifference;
      if (Boolean(left.semantic) !== Boolean(right.semantic)) return left.semantic ? -1 : 1;
      const nodeDifference = (Number(left.nodeCount) || Number.MAX_SAFE_INTEGER)
        - (Number(right.nodeCount) || Number.MAX_SAFE_INTEGER);
      if (nodeDifference) return nodeDifference;
      return (Number(left.documentOrder) || 0) - (Number(right.documentOrder) || 0);
    });
    return eligible[0] ?? null;
  }

  function normalizeThreadPosition(/** @type {any} */ value) {
    if (value && typeof value === "object") {
      const parsed = parseThreadPosition(`${value.index ?? ""}/${value.total ?? ""}`);
      return parsed ? `${parsed.index}/${parsed.total}` : "";
    }
    const parsed = parseThreadPosition(value);
    return parsed ? `${parsed.index}/${parsed.total}` : "";
  }

  function orderThreadEntries(/** @type {any} */ entries, /** @type {any} */ rootPosition) {
    const root = parseThreadPosition(normalizeThreadPosition(rootPosition));
    if (!root) {
      return { ordered: [], complete: !(entries ?? []).length, missingIndex: 0 };
    }

    const byIndex = new Map();
    for (const entry of entries ?? []) {
      const position = parseThreadPosition(entry?.threadPosition ?? entry?.entry?.threadPosition);
      if (
        !position
        || position.total !== root.total
        || position.index <= root.index
        || byIndex.has(position.index)
      ) {
        continue;
      }
      byIndex.set(position.index, entry);
    }

    const ordered = [];
    let missingIndex = 0;
    for (let index = root.index + 1; index <= root.total; index += 1) {
      if (!byIndex.has(index)) {
        missingIndex = index;
        break;
      }
      ordered.push(byIndex.get(index));
    }
    return { ordered, complete: missingIndex === 0, missingIndex };
  }

  function splitTrailingThreadPosition(/** @type {any} */ value) {
    const lines = cleanText(value).split("\n");
    const position = parseThreadPosition(lines.at(-1));
    if (!position) {
      return { text: cleanText(value), threadPosition: "" };
    }
    lines.pop();
    return {
      text: cleanText(lines.join("\n")),
      threadPosition: `${position.index}/${position.total}`
    };
  }

  function extractStructuredPostText(/** @type {any} */ post) {
    const caption = cleanText(post?.caption?.text);
    const fragments = post?.text_post_app_info
      ?.snippet_attachment_info
      ?.text_fragments
      ?.fragments;
    const attachmentText = Array.isArray(fragments) ? cleanText(fragments
      .map(fragment => cleanText(fragment?.plaintext))
      .filter(Boolean)
      .join("\n\n")) : "";
    return attachmentText.length > caption.length ? attachmentText : caption;
  }

  // Collects outbound links from a structured post: inline link fragments and link preview attachments.
  // Unknown shapes are ignored, so a format change only means fewer links, never wrong text.
  function extractStructuredLinks(/** @type {any} */ post) {
    const links = /** @type {any[]} */ ([]);
    const linkCards = /** @type {any[]} */ ([]);
    const visited = new Set();
    const visit = (/** @type {any} */ value, depth = 0) => {
      if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        value.forEach(item => visit(item, depth + 1));
        return;
      }
      const fragment = value.link_fragment;
      if (fragment && typeof fragment === "object") {
        links.push({
          text: fragment.display_text ?? value.plaintext ?? fragment.uri ?? "",
          url: fragment.uri ?? fragment.url ?? ""
        });
      }
      const preview = value.link_preview_attachment;
      if (preview && typeof preview === "object") {
        linkCards.push({ text: preview.title ?? preview.display_url ?? "", url: preview.url ?? "" });
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "link_fragment" && key !== "link_preview_attachment") visit(child, depth + 1);
      }
    };
    visit(post?.text_post_app_info);
    const inline = normalizeLinks(links);
    const inlineUrls = new Set(inline.map(link => link.url));
    return {
      links: inline,
      linkCards: normalizeLinks(linkCards, 10).filter(card => !inlineUrls.has(card.url))
    };
  }

  function extractStructuredThreadPosition(/** @type {any} */ post) {
    const info = post?.text_post_app_info?.self_thread_info;
    return normalizeThreadPosition({
      index: Number(info?.post_position_in_self_thread),
      total: Number(info?.self_thread_length)
    });
  }

  function extractStructuredQuotedPosts(/** @type {any} */ post) {
    const ownerPostId = cleanText(post?.code);
    const quotedPosts = /** @type {any[]} */ ([]);
    const seenPostIds = new Set();
    const visited = new Set();

    const visit = (/** @type {any} */ value, /** @type {any} */ path = [], depth = 0) => {
      if (!value || typeof value !== "object" || depth > 12 || visited.has(value)) return;
      visited.add(value);

      const postId = cleanText(value.code);
      const author = cleanHandle(value.user?.username);
      const quotePath = path.some((/** @type {string} */ key) => /(?:^|_)(?:quote|quoted|repost|share)(?:_|$)/i.test(key));
      if (quotePath && postId && postId !== ownerPostId && author && !seenPostIds.has(postId)) {
        seenPostIds.add(postId);
        quotedPosts.push({
          postId,
          sourceUrl: normalizeThreadsUrl(`https://www.threads.com/@${author}/post/${postId}`)
        });
      }

      for (const [key, child] of Object.entries(value)) {
        visit(child, [...path, key], depth + 1);
      }
    };

    visit(post?.text_post_app_info, ["text_post_app_info"]);
    for (const [key, value] of Object.entries(post ?? {})) {
      if (key === "text_post_app_info") continue;
      if (/(?:^|_)(?:quote|quoted|repost|share)(?:_|$)/i.test(key)) visit(value, [key]);
    }
    return quotedPosts;
  }

  function structuredThreadEntries(/** @type {any} */ entries, /** @type {any} */ author, /** @type {any} */ rootPosition) {
    const root = parseThreadPosition(normalizeThreadPosition(rootPosition));
    const targetAuthor = cleanHandle(author);
    if (!root || !targetAuthor) return [];
    return (entries ?? []).map((/** @type {any} */ entry) => {
      const split = splitTrailingThreadPosition(entry?.text);
      return {
        ...entry,
        text: split.text,
        threadPosition: normalizeThreadPosition(entry?.threadPosition) || split.threadPosition,
        author: cleanHandle(entry?.author)
      };
    }).filter((/** @type {any} */ entry) => {
      const position = parseThreadPosition(entry.threadPosition);
      return Boolean(
        entry.postId
        && entry.text
        && entry.author === targetAuthor
        && position
        && position.total === root.total
        && position.index > root.index
      );
    });
  }

  function isDirectAuthorSupplement(/** @type {any} */ entry, /** @type {any} */ rootAuthor) {
    const author = cleanHandle(rootAuthor);
    if (!author) return false;
    return Boolean(
      cleanHandle(entry?.author) === author
      && entry?.isReply === true
      && cleanHandle(entry?.replyToAuthor) === author
      && (!entry?.rootAuthor || cleanHandle(entry.rootAuthor) === author)
    );
  }

  function missingPostIds(/** @type {any} */ previousIds, /** @type {any} */ currentIds) {
    const current = new Set((currentIds ?? []).map(String).filter(Boolean));
    return [...new Set((previousIds ?? []).map(String).filter(Boolean))]
      .filter(postId => !current.has(postId));
  }

  function normalizeReviewFlags(/** @type {any} */ values) {
    const allowed = new Set(REVIEW_FLAGS);
    return [...new Set((values ?? []).map(cleanText).filter((/** @type {any} */ value) => allowed.has(value)))];
  }

  function isThreadsUrl(/** @type {any} */ value) {
    try {
      return THREADS_HOSTS.has(new URL(value).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  const LINK_SHIM_HOST_PATTERN = /^l\.(?:threads|instagram|facebook)\.(?:com|net)$/i;

  // Threads wraps outbound links as l.threads.com/?u=<target>; returns the real http(s) target,
  // or "" for Threads-internal, unsafe or malformed links.
  function webLinkUrl(/** @type {any} */ value) {
    let url;
    try {
      url = new URL(String(value ?? "").trim());
      if (LINK_SHIM_HOST_PATTERN.test(url.hostname) && url.searchParams.get("u")) {
        url = new URL(/** @type {string} */ (url.searchParams.get("u")));
      }
    } catch {
      return "";
    }
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.href.length <= 2000 ? url.href : "";
  }

  /**
   * An href read from a page, resolved against the page's address.
   * @param {string} href
   * @param {string} base
   * @returns {URL | null} null when it is not an address
   */
  function resolveUrl(href, base) {
    try {
      return new URL(href, base);
    } catch {
      // An href that is not an address cannot be a link worth keeping.
      return null;
    }
  }

  function externalLinkUrl(/** @type {any} */ value) {
    const href = webLinkUrl(value);
    return href && !isThreadsUrl(href) ? href : "";
  }

  // Keeps text/url pairs for inline links; text is what the post displays (often a shortened URL).
  /**
   * Keeps http(s) links with text, drops duplicates, caps the count.
   * @param {unknown} items
   * @param {number} [limit]
   * @returns {import("../types").LinkRef[]}
   */
  function normalizeLinks(items, limit = 50) {
    const seen = new Set();
    const links = [];
    for (const item of Array.isArray(items) ? items : []) {
      const url = externalLinkUrl(item?.url);
      const text = cleanText(item?.text ?? "").slice(0, 500);
      const key = `${text}\u0000${url}`;
      if (!url || seen.has(key)) continue;
      seen.add(key);
      links.push({ text, url });
      if (links.length >= limit) break;
    }
    return links;
  }

  function plurkPostId(/** @type {any} */ value) {
    try {
      const parsed = new URL(value);
      if (!PLURK_HOSTS.has(parsed.hostname.toLowerCase())) return "";
      return parsed.pathname.match(PLURK_POST_PATH)?.[1]?.toLowerCase() ?? "";
    } catch {
      return "";
    }
  }

  function isPlurkUrl(/** @type {any} */ value) {
    try {
      return PLURK_HOSTS.has(new URL(value).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function isPlurkPasteUrl(/** @type {any} */ value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:"
        && parsed.hostname.toLowerCase() === "paste.plurk.com"
        && /^\/show\/[0-9a-z]+\/?$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function isXUrl(/** @type {any} */ value) {
    try {
      return X_HOSTS.has(new URL(value).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  // { handle, statusId } of an X / Twitter post address; both empty for any other address.
  function xStatusInfo(/** @type {any} */ value) {
    try {
      const parsed = new URL(value);
      if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return { handle: "", statusId: "" };
      const match = parsed.pathname.match(X_STATUS_PATH);
      if (!match) return { handle: "", statusId: "" };
      const handle = match[1] && !X_RESERVED_PATHS.test(match[1]) ? match[1].toLowerCase() : "";
      return { handle, statusId: match[2].replace(/^0+(?=\d)/, "") };
    } catch {
      return { handle: "", statusId: "" };
    }
  }

  function isInstagramUrl(/** @type {any} */ value) {
    try {
      return INSTAGRAM_HOSTS.has(new URL(value).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  // The shortcode of an Instagram post or reel (instagram.com/[user/]p|reel/<code>/); "" otherwise.
  function instagramPostCode(/** @type {any} */ value) {
    try {
      const parsed = new URL(value);
      if (!INSTAGRAM_HOSTS.has(parsed.hostname.toLowerCase())) return "";
      return parsed.pathname.match(INSTAGRAM_POST_PATH)?.[1] ?? "";
    } catch {
      return "";
    }
  }

  // Publication time encoded in an X post id; "" for ids older than the snowflake format.
  function xStatusTime(/** @type {any} */ statusId) {
    try {
      const id = BigInt(String(statusId ?? ""));
      if (id < X_SNOWFLAKE_MIN_ID) return "";
      return new Date(Number(id >> 22n) + X_SNOWFLAKE_EPOCH).toISOString();
    } catch {
      return "";
    }
  }

  function isWebPageUrl(/** @type {any} */ value) {
    try {
      return /^https?:$/.test(new URL(value).protocol);
    } catch {
      return false;
    }
  }

  // Hosts on the user's own machine or local network (localhost, 192.168.x.x, printer.local, ...).
  // A website can point images at them; the extension does not fetch those for it.
  function isPrivateNetworkHost(/** @type {any} */ value) {
    const host = String(value ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host) return true;
    if (host === "localhost" || /\.(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/.test(host)) return true;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [a, b] = ipv4.slice(1, 3).map(Number);
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (host.includes(":")) {
      const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      if (mapped) return isPrivateNetworkHost(mapped[1]);
      return host === "::" || host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
    }
    // A name without a dot ("intranet", "nas") only resolves inside a local network.
    return !host.includes(".");
  }

  // Pages this extension can save from: Threads, Plurk and X posts, and any other web page.
  /**
   * Whether a tab URL can be saved: any http(s) page.
   * @param {string} value
   * @returns {boolean}
   */
  function isSupportedSourceUrl(value) {
    return isWebPageUrl(value);
  }

  // The 11-character id of a YouTube video from a watch, youtu.be, shorts, live or embed address; "" for anything else.
  function youtubeVideoId(/** @type {any} */ value) {
    try {
      const url = new URL(String(value ?? "").trim());
      const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, "");
      let id = "";
      if (host === "youtu.be") id = url.pathname.split("/")[1] ?? "";
      else if (host === "youtube.com") {
        id = url.pathname === "/watch"
          ? url.searchParams.get("v") ?? ""
          : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] ?? "";
      }
      return /^[\w-]{11}$/.test(id) ? id : "";
    } catch {
      return "";
    }
  }

  // The kind ("activity", "share" or "ugcPost") and id of a LinkedIn post from its /feed/update/ or /posts/ address.
  function linkedInPostInfo(/** @type {any} */ value) {
    try {
      const url = new URL(String(value ?? "").trim());
      if (!/^(?:www\.)?linkedin\.com$/i.test(url.hostname)) return { type: "", id: "" };
      const match = decodeURIComponent(url.pathname).match(/^\/feed\/update\/urn:li:(activity|share|ugcPost):(\d{15,25})/)
        ?? url.pathname.match(/^\/posts\/[^/]*?-(activity|share|ugcPost)-(\d{15,25})(?:-|\/|$)/);
      return match ? { type: match[1], id: match[2] } : { type: "", id: "" };
    } catch {
      return { type: "", id: "" };
    }
  }

  function isLinkedInUrl(/** @type {any} */ value) {
    try {
      return /^(?:www\.)?linkedin\.com$/i.test(new URL(String(value ?? "").trim()).hostname);
    } catch {
      return false;
    }
  }

  function isFacebookUrl(/** @type {any} */ value) {
    try {
      return /^(?:(?:www|m|web|mbasic)\.)?facebook\.com$/i.test(new URL(String(value ?? "").trim()).hostname);
    } catch {
      return false;
    }
  }

  // The post token of a Facebook post page: /<page>/posts/<token>, /groups/<id>/posts|permalink/<token>,
  // permalink.php?story_fbid=<token>&id=<page>. Other Facebook addresses (the feed, photos, profiles) give "".
  function facebookPostInfo(/** @type {any} */ value) {
    try {
      const url = new URL(String(value ?? "").trim());
      if (!isFacebookUrl(url.href)) return { token: "", path: "" };
      const group = url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([^/]+)/);
      if (group) return { token: group[2], path: `/groups/${group[1]}/posts/${group[2]}` };
      const page = url.pathname.match(/^\/([^/]+)\/posts\/([^/]+)/);
      if (page && page[1] !== "groups") return { token: page[2], path: `/${page[1]}/posts/${page[2]}` };
      const story = url.searchParams.get("story_fbid");
      if (story && /^\/(?:permalink|story)\.php$/.test(url.pathname)) {
        const owner = url.searchParams.get("id");
        return { token: story, path: `/permalink.php?story_fbid=${story}${owner ? `&id=${owner}` : ""}` };
      }
      return { token: "", path: "" };
    } catch {
      return { token: "", path: "" };
    }
  }

  // LinkedIn post ids start with the creation time in milliseconds (id >> 22).
  function linkedInPostTime(/** @type {any} */ id) {
    try {
      const time = Number(BigInt(String(id)) >> 22n);
      return time > 1.2e12 && time < 4e12 ? new Date(time).toISOString() : "";
    } catch {
      return "";
    }
  }

  // A web page address without its #fragment and tracking parameters; other parameters can
  // select the page (news.php?id=1), so they are kept.
  function normalizeWebUrl(/** @type {any} */ value) {
    try {
      const parsed = new URL(String(value ?? "").trim());
      if (!/^https?:$/.test(parsed.protocol)) return cleanText(value);
      // One video, one address: time, playlist and share parameters would make the same video look new.
      const videoId = youtubeVideoId(parsed.href);
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      // One Facebook post, one address: the host variants and every tracking parameter go.
      const facebook = facebookPostInfo(parsed.href);
      if (facebook.token) return `https://www.facebook.com${facebook.path}`;
      // One LinkedIn post, one address, whichever form it was opened from.
      const linkedIn = linkedInPostInfo(parsed.href);
      if (linkedIn.id) return `https://www.linkedin.com/feed/update/urn:li:${linkedIn.type}:${linkedIn.id}/`;
      // Gmail keeps the open message in the fragment (#inbox/<id>); dropping it would make every mail one page.
      if (parsed.hostname.toLowerCase() !== "mail.google.com") parsed.hash = "";
      parsed.username = "";
      parsed.password = "";
      for (const name of [...new Set(parsed.searchParams.keys())]) {
        if (TRACKING_PARAM_PATTERN.test(name)) parsed.searchParams.delete(name);
      }
      if (![...parsed.searchParams.keys()].length) parsed.search = "";
      return parsed.toString();
    } catch {
      return cleanText(value);
    }
  }

  // Plurk Paste shows line numbers in a separate column; only the text column is kept.
  function extractPlurkPasteFromDocument(/** @type {Document} */ doc) {
    const body = doc?.querySelector?.("#paste td.code .syntax, #paste td.code, #paste .syntax");
    if (!body) return { title: "", text: "" };
    const lines = [];
    let line = "";
    const walk = (/** @type {any} */ node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) line += child.nodeValue;
        else if (child.nodeName === "BR") {
          lines.push(line);
          line = "";
        } else walk(child);
      }
    };
    walk(body);
    lines.push(line);
    const title = cleanText(String(doc.title ?? "").replace(/\s*\(Plurk Paste\)\s*$/i, ""));
    return { title, text: cleanText(lines.join("\n")) };
  }

  /**
   * Canonical URL of a post or page. Plurk, X, Instagram and Threads posts are rewritten to one address form; web pages lose the # part and tracking parameters.
   * @param {string} value
   * @returns {string}
   */
  function normalizeThreadsUrl(value) {
    const plurkId = plurkPostId(value);
    if (plurkId) return `https://www.plurk.com/p/${plurkId}`;
    const xStatus = xStatusInfo(value);
    if (xStatus.statusId) return `https://x.com/${xStatus.handle || "i/web"}/status/${xStatus.statusId}`;
    // Posts and reels share one address form; the optional /<user>/ prefix is left out.
    const instagramCode = instagramPostCode(value);
    if (instagramCode) return `https://www.instagram.com/p/${instagramCode}/`;
    if (isWebPageUrl(value) && !isThreadsUrl(value) && !isPlurkUrl(value) && !isXUrl(value)) {
      return normalizeWebUrl(value);
    }
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      parsed.search = "";
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
      if (THREADS_HOSTS.has(parsed.hostname.toLowerCase())) {
        parsed.protocol = "https:";
        parsed.hostname = "www.threads.com";
        parsed.port = "";
        const postPath = parsed.pathname.match(/^(\/@[^/]+\/(?:post|t)\/[^/]+|\/(?:post|t)\/[^/]+)(?:\/.*)?$/i);
        if (postPath) {
          parsed.pathname = postPath[1]
            .replace(/^(\/@[^/]+)\/t\//i, "$1/post/")
            .replace(/^\/post\//i, "/t/");
        }
      }
      return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
    } catch {
      return cleanText(value);
    }
  }

  /**
   * Reads a post URL into its site, handle and post id. Empty fields when it is not a recognised post.
   * @param {string} value
   * @returns {{ platform: string, handle: string, postId: string, normalized: string }}
   */
  function parseThreadsUrl(value) {
    const normalized = normalizeThreadsUrl(value);
    const plurkId = plurkPostId(normalized);
    // A plurk has no @handle in its URL; its id plays the role of the Threads post code.
    if (plurkId) return { normalized, handle: "", postId: plurkId, platform: "plurk" };
    const xStatus = xStatusInfo(normalized);
    if (xStatus.statusId) return { normalized, handle: xStatus.handle, postId: xStatus.statusId, platform: "x" };
    if (isXUrl(normalized)) return { normalized, handle: "", postId: "", platform: "x" };
    const instagramCode = instagramPostCode(normalized);
    if (instagramCode || isInstagramUrl(normalized)) {
      return { normalized, handle: "", postId: instagramCode, platform: "instagram" };
    }
    if (isPlurkUrl(normalized)) return { normalized, handle: "", postId: "", platform: "plurk" };
    // Only Threads addresses carry an @handle and post code; another site's /post/... path is not a post.
    if (!isThreadsUrl(normalized)) {
      return { normalized, handle: "", postId: "", platform: isWebPageUrl(normalized) ? "web" : "" };
    }
    try {
      const parsed = new URL(normalized);
      const handleMatch = parsed.pathname.match(/\/@([^/]+)/i);
      const postMatch = parsed.pathname.match(/\/(?:post|t)\/([^/]+)/i);
      return {
        normalized,
        handle: cleanHandle(handleMatch?.[1] ?? ""),
        postId: postMatch?.[1] ?? "",
        platform: "threads"
      };
    } catch {
      return { normalized, handle: "", postId: "", platform: "" };
    }
  }

  // "platform:postId" of a Threads, Plurk or X post; "" for other pages, which have no post id.
  function postIdentity(/** @type {any} */ value) {
    const parsed = parseThreadsUrl(value);
    return parsed.postId ? `${parsed.platform || "threads"}:${parsed.postId}` : "";
  }

  // Dedupe key of a web page (not a Threads, Plurk or X post), from its address.
  function webPageKey(/** @type {string} */ sourceUrl) {
    const normalized = normalizeThreadsUrl(sourceUrl);
    if (!normalized) return "";
    return normalized.length <= 1500
      ? `web:${normalized}`
      : `web:#${hashString(normalized)}-${normalized.length}`;
  }

  function normalizeNotionId(/** @type {any} */ value) {
    const raw = String(value ?? "").replace(/-/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(raw)) return "";
    return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join("-");
  }

  /**
   * Finds a Notion page or database id in a URL or id string.
   * @param {unknown} value
   * @returns {string} the id, or ""
   */
  function extractNotionId(value) {
    const input = String(value ?? "").trim();
    const matches = input.match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
    if (!matches?.length) return "";
    return normalizeNotionId(matches[matches.length - 1]);
  }

  function extractNotionDatabaseId(/** @type {any} */ value) {
    const input = String(value ?? "").trim();
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      return "";
    }
    const hostname = parsed.hostname.toLowerCase();
    const isNotionHost = hostname === "notion.so"
      || hostname.endsWith(".notion.so")
      || hostname === "notion.com"
      || hostname.endsWith(".notion.com")
      || hostname === "notion.site"
      || hostname.endsWith(".notion.site");
    if (!isNotionHost) return "";
    const matches = parsed.pathname.match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
    if (!matches?.length) return "";
    return normalizeNotionId(matches[matches.length - 1]);
  }

  /**
   * Page title: the text on one line, cut to at most 30 characters (`maxLength` can only lower that), at a sentence mark when one falls late enough. "無文字貼文" (in the interface language) when there is no text.
   * @param {string} text
   * @param {string} publishedAt not used
   * @param {number} [maxLength]
   * @returns {string}
   */
  function buildTitle(text, publishedAt, maxLength = 30) {
    const body = cleanText(text).replace(/\n+/g, " ");
    const excerpt = body || t("無文字貼文");
    const limit = Math.max(1, Math.min(30, Number(maxLength) || 30));
    if (excerpt.length <= limit) return excerpt;

    const window = excerpt.slice(0, limit);
    const preferredBoundary = Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf("!"),
      window.lastIndexOf("?"),
      window.lastIndexOf("；"),
      window.lastIndexOf(";")
    );
    if (preferredBoundary >= Math.min(19, limit - 1)) {
      return window.slice(0, preferredBoundary + 1).trim();
    }
    return window.trim();
  }

  function hashString(/** @type {any} */ value) {
    const input = String(value ?? "");
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  /**
   * Key built from the URL and, for a selection, a hash of its text. The capture model uses model/dedupe-key.js, which also knows each site's own ids.
   * @param {any} capture
   * @returns {string}
   */
  function captureKey(capture) {
    const url = normalizeThreadsUrl(capture?.sourceUrl ?? "");
    const type = capture?.captureType ?? "post";
    if (type === "selection") {
      return `selection:${url}:${hashString(cleanText(capture?.text))}`;
    }
    const parsed = parseThreadsUrl(url);
    if (parsed.platform === "plurk" && parsed.postId) return `plurk:${parsed.postId}`;
    if (parsed.platform === "x" && parsed.postId) return `x:${parsed.postId}`;
    if (parsed.platform === "instagram" && parsed.postId) return `ig:${parsed.postId}`;
    if (parsed.platform === "web" || parsed.platform === "instagram") return webPageKey(url);
    const shortcode = cleanText(capture?.shortcode || parsed.postId);
    if (shortcode) return `tsc:${shortcode}`;
    if (url) return `post:${url}`;
    return `${type}:${hashString(`${capture?.author ?? ""}|${capture?.publishedAt ?? ""}|${capture?.text ?? ""}`)}`;
  }

  function localPostCaptureStatus(/** @type {any} */ state, /** @type {string} */ sourceUrl) {
    const normalized = normalizeThreadsUrl(sourceUrl);
    const identity = postIdentity(normalized);
    const targetKey = captureKey({ captureType: "post", sourceUrl: normalized });
    const samePost = (/** @type {any} */ key, /** @type {any} */ candidateUrl, captureType = "") => {
      if (String(key ?? "").startsWith("selection:") || captureType === "selection") return false;
      if (key === targetKey) return true;
      if (identity) return postIdentity(candidateUrl) === identity;
      return Boolean(candidateUrl) && normalizeThreadsUrl(candidateUrl) === normalized;
    };

    const queued = (state?.queue ?? []).find((/** @type {any} */ item) => samePost(
      item?.capture?.dedupeKey,
      item?.capture?.sourceUrl,
      item?.capture?.captureType
    ));
    if (queued) {
      return {
        status: queued.status === "failed" ? "failed" : "pending",
        key: queued.capture?.dedupeKey || targetKey,
        queueId: queued.id || ""
      };
    }

    for (const [key, record] of Object.entries(state?.saved ?? {})) {
      if (!samePost(key, record?.sourceUrl)) continue;
      return { status: "saved", key, record };
    }
    return { status: "new", key: targetKey, record: null };
  }

  function validDate(/** @type {any} */ value) {
    if (!value) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime());
  }

  /**
   * Paragraphs of a run of spans: a blank line starts a new one, a single line break stays inside.
   * @param {any[]} spans
   * @returns {any[][]} the spans of each paragraph; paragraphs of only blank text are dropped
   */
  function splitParagraphs(spans) {
    const paragraphs = [];
    let current = /** @type {any[]} */ ([]);
    // Two line breaks arrive as two spans; joined first, they read as the blank line they are.
    const merged = /** @type {any[]} */ ([]);
    for (const span of spans) {
      if (merged.length && merged.at(-1).href === span.href) merged.at(-1).text += span.text;
      else merged.push({ ...span });
    }
    for (const span of merged) {
      const parts = String(span.text).split(/\n{2,}/);
      parts.forEach((part, index) => {
        if (index > 0) {
          paragraphs.push(current);
          current = [];
        }
        if (part) current.push({ ...span, text: part });
      });
    }
    paragraphs.push(current);
    return paragraphs.filter(paragraph => paragraph.some(span => span.text.trim()));
  }

  /**
   * Splits text into pieces Notion accepts in one rich-text block.
   * @param {string} value
   * @param {number} [maxLength]
   * @returns {string[]}
   */
  function chunkText(value, maxLength = 1800) {
    const text = cleanText(value);
    if (!text) return [];
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLength) {
      const window = remaining.slice(0, maxLength + 1);
      const newlineAt = window.lastIndexOf("\n");
      const spaceAt = window.lastIndexOf(" ");
      const cutAt = Math.max(newlineAt, spaceAt, Math.floor(maxLength * 0.65));
      chunks.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  /**
   * Current time as an ISO string.
   * @returns {string}
   */
  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * @param {number} milliseconds
   * @returns {Promise<void>}
   */
  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  return {
    INSTAGRAM_HOSTS,
    THREADS_HOSTS,
    X_HOSTS,
    REVIEW_FLAGS,
    buildTitle,
    captureKey,
    chunkText,
    cleanHandle,
    cleanText,
    extractStructuredLinks,
    extractStructuredPostText,
    extractStructuredQuotedPosts,
    extractStructuredThreadPosition,
    extractNotionDatabaseId,
    extractNotionId,
    hashString,
    externalLinkUrl,
    extractPlurkPasteFromDocument,
    isPlurkPasteUrl,
    isPrivateNetworkHost,
    isPlurkUrl,
    isSupportedSourceUrl,
    isThreadsUrl,
    instagramPostCode,
    isInstagramUrl,
    isWebPageUrl,
    isXUrl,
    normalizeWebUrl,
    youtubeVideoId,
    linkedInPostInfo,
    linkedInPostTime,
    isLinkedInUrl,
    isFacebookUrl,
    facebookPostInfo,
    postIdentity,
    resolveUrl,
    webPageKey,
    xStatusInfo,
    xStatusTime,
    normalizeLinks,
    webLinkUrl,
    isThreadsUiText,
    hiddenLongTextCandidate,
    isDirectAuthorSupplement,
    localPostCaptureStatus,
    missingPostIds,
    normalizeThreadsUrl,
    normalizeReviewFlags,
    normalizeThreadPosition,
    nowIso,
    orderThreadEntries,
    parseThreadPosition,
    parseThreadsUrl,
    stripThreadsMetadataLines,
    t,
    choosePostCandidate,
    sleep,
    splitParagraphs,
    splitTrailingThreadPosition,
    structuredThreadEntries,
    validDate
  };
});
