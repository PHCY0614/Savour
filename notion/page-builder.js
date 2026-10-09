/**
 * Builds Notion request bodies from a Capture: page properties, content blocks, continuation blocks,
 * the update payloads and the content-range markers used to replace only the original text.
 * Pure functions; nothing is sent from here.
 */
(function attachSavourNotionPageBuilder(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourNotionPageBuilder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNotionPageBuilderModule() {
  "use strict";

  function createNotionPageBuilder(/** @type {any} */ options) {
    const shared = options.shared;
    const { pageProperty } = options.schema;
    // The archive's column map (notion/schema.js), read on every call so it follows the archive in use.
    const columnMap = () => /** @type {import("../types").ColumnMap} */ (options.columns());
    const columnId = (/** @type {string} */ key) => columnMap().columns[key].id;

    function richText(/** @type {any} */ content) {
      return [{ type: "text", text: { content: String(content ?? "").slice(0, 1900) } }];
    }

    const AUTO_URL_PATTERN = /https?:\/\/[^\s<>"'「」『』（）()[\]{}]+/g;
    const MIN_LINK_TEXT_LENGTH = 4;

    // Finds the spans to make clickable: the post's own link texts first, then bare URLs typed in the text.
    function linkRanges(/** @type {any} */ content, /** @type {any} */ links) {
      const ranges = /** @type {any[]} */ ([]);
      const overlaps = (/** @type {any} */ start, /** @type {any} */ end) => ranges.some(range => start < range.end && end > range.start);
      for (const link of links ?? []) {
        const text = String(link?.text ?? "");
        if (text.length < MIN_LINK_TEXT_LENGTH || !link.url) continue;
        for (let index = content.indexOf(text); index !== -1; index = content.indexOf(text, index + text.length)) {
          if (!overlaps(index, index + text.length)) ranges.push({ start: index, end: index + text.length, url: link.url });
        }
      }
      for (const match of content.matchAll(AUTO_URL_PATTERN)) {
        const raw = match[0].replace(/[.,;:!?。，、；：！？]+$/, "");
        const url = shared.webLinkUrl(raw);
        if (url && !overlaps(match.index, match.index + raw.length)) {
          ranges.push({ start: match.index, end: match.index + raw.length, url });
        }
      }
      return ranges.sort((left, right) => left.start - right.start);
    }

    // Splits without trimming so spaces next to a link survive.
    function textItems(/** @type {any} */ content, url = "") {
      const parts = [];
      for (let index = 0; index < content.length; index += 1900) parts.push(content.slice(index, index + 1900));
      return parts.map(part => ({
        type: "text",
        text: url ? { content: part, link: { url } } : { content: part }
      }));
    }

    function linkedRichText(/** @type {any} */ content, /** @type {any} */ links) {
      const value = String(content ?? "");
      const ranges = linkRanges(value, links);
      if (!ranges.length) return richText(value);
      const items = [];
      let cursor = 0;
      for (const range of ranges) {
        if (range.start > cursor) items.push(...textItems(value.slice(cursor, range.start)));
        items.push(...textItems(value.slice(range.start, range.end), range.url));
        cursor = range.end;
      }
      if (cursor < value.length) items.push(...textItems(value.slice(cursor)));
      // Notion allows at most 100 rich text items per block.
      return items.length <= 100 ? items : richText(value);
    }

    function heading(/** @type {string} */ text, level = 2) {
      const type = `heading_${level}`;
      return {
        object: "block",
        type,
        [type]: { rich_text: richText(text) }
      };
    }

    function paragraph(/** @type {string} */ text, /** @type {any} */ links = []) {
      return {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: linkedRichText(text, links) }
      };
    }

    function bookmarkBlock(/** @type {string} */ url) {
      return {
        object: "block",
        type: "bookmark",
        bookmark: { url, caption: /** @type {any[]} */ ([]) }
      };
    }

    function addVideoBlocks(/** @type {any} */ children, /** @type {any} */ videos) {
      for (const value of videos ?? []) {
        const video = videoBlock(value);
        if (video) children.push(video);
      }
    }

    function addLinkCards(/** @type {any} */ children, /** @type {any} */ linkCards) {
      for (const card of linkCards ?? []) {
        const url = shared.webLinkUrl(card?.url);
        if (url) children.push(bookmarkBlock(url));
      }
    }

    function blankParagraph() {
      return {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: /** @type {any[]} */ ([]) }
      };
    }

    function divider() {
      return {
        object: "block",
        type: "divider",
        divider: {}
      };
    }

    function paragraphBlocks(/** @type {string} */ text, /** @type {any} */ links = []) {
      const paragraphs = shared.cleanText(text).split(/\n{2,}/).filter(Boolean);
      return paragraphs.flatMap((/** @type {any} */ value) => shared.chunkText(value, 1800).map((/** @type {any} */ part) => paragraph(part, links)));
    }

    function appendThreadPosition(/** @type {any} */ children, /** @type {any} */ threadPosition, startIndex = 0) {
      const position = shared.normalizeThreadPosition(threadPosition);
      if (!position) return;
      const last = children.slice(startIndex).reverse().find((/** @type {any} */ block) => block?.type === "paragraph");
      if (!last) {
        children.push(paragraph(position));
        return;
      }
      const items = last?.paragraph?.rich_text ?? [];
      const tail = items.at(-1)?.text;
      if (tail && !tail.link && `${tail.content}\n${position}`.length <= 1900) {
        tail.content = `${tail.content}\n${position}`;
      } else if (tail && items.length < 100) {
        // The paragraph ends with a link; keep the position as its own unlinked piece.
        items.push({ type: "text", text: { content: `\n${position}` } });
      } else {
        children.push(paragraph(position));
      }
    }

    // Reads back the N in "N/M" markers that appendThreadPosition leaves at the end of each section.
    function savedThreadPositions(/** @type {any} */ blocks) {
      const positions = new Set();
      for (const block of blocks ?? []) {
        if (block?.type !== "paragraph") continue;
        const text = (block.paragraph?.rich_text ?? [])
          .map((/** @type {any} */ item) => item?.plain_text ?? item?.text?.content ?? "")
          .join("");
        const parsed = shared.parseThreadPosition(text.split("\n").at(-1)?.trim() ?? "");
        if (parsed) positions.add(parsed.index);
      }
      return positions;
    }

    function linkedParagraph(/** @type {string} */ url) {
      const normalized = shared.normalizeThreadsUrl(url);
      return {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{
            type: "text",
            text: {
              content: normalized.slice(0, 1900),
              link: { url: normalized.slice(0, 2000) }
            }
          }]
        }
      };
    }

    // Long text (a Threads post's hidden text, a Plurk Paste) goes straight into the page, without a
    // heading of its own. An attachment with no text adds nothing.
    function addLongTextBlocks(/** @type {any} */ children, /** @type {any} */ attachments, /** @type {any} */ links = []) {
      for (const attachment of attachments ?? []) {
        children.push(...paragraphBlocks(attachment?.text ?? attachment, links));
      }
    }

    const PASTE_ADDRESS = /https:\/\/paste\.plurk\.com\/show\/[0-9a-z]+\/?/gi;

    // A plurk that links a Plurk Paste reads: its text up to the Paste's link, the Paste itself, then the text
    // that followed the link. The link shows as its own words ("長文的第一句話 (Plurk Paste)"), not as the address,
    // so it is found by the link's text; a bare address in the text counts as well. Other entries keep all their
    // text in front of their attachments.
    function splitAroundPaste(/** @type {any} */ text, /** @type {any} */ attachments, /** @type {any} */ links = []) {
      const value = String(text ?? "");
      if (!(attachments ?? []).some((/** @type {any} */ item) => item?.source === "plurk_paste")) return { head: value, tail: "" };
      let end = -1;
      for (const match of value.matchAll(PASTE_ADDRESS)) end = Math.max(end, match.index + match[0].length);
      for (const link of links ?? []) {
        const label = String(link?.text ?? "");
        if (!label || !shared.isPlurkPasteUrl(String(link?.url ?? ""))) continue;
        const at = value.lastIndexOf(label);
        if (at >= 0) end = Math.max(end, at + label.length);
      }
      return end < 0 ? { head: value, tail: "" } : { head: value.slice(0, end), tail: value.slice(end).trim() };
    }

    function addCaptureWarnings(/** @type {any} */ children, /** @type {any} */ diagnostics) {
      const warnings = diagnostics?.warnings ?? [];
      if (!warnings.length) return;
      children.push(heading(shared.t("擷取提醒"), 3));
      for (const warning of warnings) children.push(paragraph(`⚠️ ${warning}`));
    }

    // An uploaded copy when there is one; a web page's image that could not be copied links to the original.
    function imageBlock(/** @type {any} */ media, /** @type {any} */ caption = []) {
      if (media?.notionFileId) {
        return {
          object: "block",
          type: "image",
          image: { type: "file_upload", file_upload: { id: media.notionFileId }, caption }
        };
      }
      const url = media?.external ? shared.webLinkUrl(media.url) : "";
      if (!url) return null;
      return {
        object: "block",
        type: "image",
        image: { type: "external", external: { url }, caption }
      };
    }

    // ---- Web articles (model/article-blocks.js) ----

    const MAX_RICH_TEXT_ITEMS = 100;

    function spanItems(/** @type {any} */ spans) {
      const items = [];
      for (const span of spans ?? []) {
        const text = String(span?.text ?? "");
        const href = span?.href ? shared.webLinkUrl(span.href) : "";
        const annotations = {};
        if (span?.bold) annotations.bold = true;
        if (span?.italic) annotations.italic = true;
        if (span?.strike) annotations.strikethrough = true;
        if (span?.underline) annotations.underline = true;
        if (span?.code) annotations.code = true;
        for (let index = 0; index < text.length; index += 1900) {
          const content = text.slice(index, index + 1900);
          items.push({
            type: "text",
            text: href ? { content, link: { url: href } } : { content },
            ...(Object.keys(annotations).length ? { annotations } : {})
          });
        }
      }
      return items;
    }

    // One block per 100 rich text pieces (the Notion limit), so a very long paragraph becomes several.
    function richTextBlocks(/** @type {any} */ type, /** @type {any} */ spans) {
      const items = spanItems(spans);
      const blocks = [];
      for (let index = 0; index < items.length; index += MAX_RICH_TEXT_ITEMS) {
        blocks.push({ object: "block", type, [type]: { rich_text: items.slice(index, index + MAX_RICH_TEXT_ITEMS) } });
      }
      return blocks;
    }

    // Notion plays YouTube and Vimeo videos from their watch-page address; anything else is a bookmark.
    function videoBlock(/** @type {any} */ value) {
      let watchUrl = "";
      try {
        const url = new URL(value);
        const host = url.hostname.replace(/^(?:www|m)\./, "");
        const youtubeId = host === "youtu.be"
          ? url.pathname.slice(1)
          : /youtube(?:-nocookie)?\.com$/.test(host)
            ? url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1] || ""
            : "";
        const vimeoId = /(?:^|\.)vimeo\.com$/.test(host) ? url.pathname.match(/(\d{5,})/)?.[1] ?? "" : "";
        if (/^[\w-]{6,20}$/.test(youtubeId)) watchUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
        else if (vimeoId) watchUrl = `https://vimeo.com/${vimeoId}`;
      } catch {
        return null;
      }
      if (!watchUrl) return bookmarkBlock(value);
      return { object: "block", type: "video", video: { type: "external", external: { url: watchUrl } } };
    }

    function tableBlock(/** @type {any} */ block) {
      const width = block.rows?.[0]?.length ?? 0;
      if (!width) return null;
      return {
        object: "block",
        type: "table",
        table: {
          table_width: width,
          has_column_header: Boolean(block.header),
          has_row_header: false,
          children: block.rows.map((/** @type {any} */ row) => ({
            object: "block",
            type: "table_row",
            table_row: { cells: row.map((/** @type {any} */ cell) => spanItems(cell).slice(0, MAX_RICH_TEXT_ITEMS)) }
          }))
        }
      };
    }

    function codeBlocks(/** @type {string} */ text) {
      const items = [];
      for (let index = 0; index < text.length; index += 1900) {
        items.push({ type: "text", text: { content: text.slice(index, index + 1900) } });
      }
      const blocks = [];
      for (let index = 0; index < items.length; index += MAX_RICH_TEXT_ITEMS) {
        blocks.push({
          object: "block",
          type: "code",
          code: { rich_text: items.slice(index, index + MAX_RICH_TEXT_ITEMS), language: "plain text" }
        });
      }
      return blocks;
    }

    /** @type {any} */ const ARTICLE_TEXT_TYPES = {
      paragraph: "paragraph",
      quote: "quote",
      bulleted: "bulleted_list_item",
      numbered: "numbered_list_item"
    };

    function isPrivateImage(/** @type {any} */ imageUrl, /** @type {any} */ pageUrl) {
      try {
        const host = new URL(imageUrl).hostname.toLowerCase();
        return shared.isPrivateNetworkHost(host) && host !== new URL(pageUrl).hostname.toLowerCase();
      } catch {
        return true;
      }
    }

    function articleChildren(/** @type {any} */ capture) {
      const children = [];
      for (const block of capture.articleBlocks ?? []) {
        if (ARTICLE_TEXT_TYPES[block.type]) {
          children.push(...richTextBlocks(ARTICLE_TEXT_TYPES[block.type], block.spans));
        } else if (block.type === "heading") {
          children.push(...richTextBlocks(`heading_${Math.min(3, Math.max(1, Number(block.level) || 2))}`, block.spans));
        } else if (block.type === "code") {
          children.push(...codeBlocks(String(block.text ?? "")));
        } else if (block.type === "image") {
          const media = Number.isInteger(block.media) ? capture.media?.[block.media] : null;
          const caption = spanItems(block.caption).slice(0, MAX_RICH_TEXT_ITEMS);
          // Images past the upload limit are only linked; never to the user's own network.
          const linkable = media || !isPrivateImage(block.url, capture.sourceUrl);
          const image = linkable ? imageBlock(media ?? { url: block.url, external: true }, caption) : null;
          if (image) children.push(image);
        } else if (block.type === "divider") {
          children.push(divider());
        } else if (block.type === "table") {
          const table = tableBlock(block);
          if (table) children.push(table);
        } else if (block.type === "video") {
          const video = videoBlock(block.url);
          if (video) children.push(video);
        } else if (block.type === "bookmark") {
          const url = shared.webLinkUrl(block.url);
          if (url) children.push(bookmarkBlock(url));
        }
      }
      return children;
    }

    // Groups top-level blocks into requests Notion accepts: at most 100 blocks, and a bounded
    // number of nested blocks (table rows) and bytes per request.
    function chunkBlocks(/** @type {any} */ blocks, /** @type {any} */ limits = {}) {
      const maxCount = limits.maxCount ?? 100;
      const maxWeight = limits.maxWeight ?? 800;
      const maxBytes = limits.maxBytes ?? 350000;
      const chunks = [];
      let current = [];
      let weight = 0;
      let bytes = 0;
      for (const block of blocks ?? []) {
        const blockWeight = 1 + (block?.[block?.type]?.children?.length ?? 0);
        const blockBytes = JSON.stringify(block).length;
        if (current.length && (current.length >= maxCount || weight + blockWeight > maxWeight || bytes + blockBytes > maxBytes)) {
          chunks.push(current);
          current = [];
          weight = 0;
          bytes = 0;
        }
        current.push(block);
        weight += blockWeight;
        bytes += blockBytes;
      }
      if (current.length) chunks.push(current);
      return chunks;
    }

    function addMediaBlocks(/** @type {any} */ children, /** @type {any} */ media) {
      const blocks = (media ?? []).map((/** @type {any} */ item) => imageBlock(item)).filter(Boolean);
      if (!blocks.length) return;
      children.push(...blocks);
    }

    function addQuotedPostLinks(/** @type {any} */ children, /** @type {any} */ quotedPosts) {
      const seen = new Set();
      const links = [];
      for (const item of quotedPosts ?? []) {
        const sourceUrl = shared.normalizeThreadsUrl(item?.sourceUrl ?? item ?? "");
        const postId = shared.parseThreadsUrl(sourceUrl).postId;
        if (!postId || seen.has(postId)) continue;
        seen.add(postId);
        links.push(sourceUrl);
      }
      if (!links.length) return;
      const previous = children.at(-1);
      const previousIsBlank = previous?.type === "paragraph" && !previous.paragraph?.rich_text?.length;
      if (previous && !previousIsBlank) children.push(blankParagraph());
      children.push(paragraph(shared.t("引用：")));
      for (const sourceUrl of links) children.push(linkedParagraph(sourceUrl));
    }

    function buildPageChildren(/** @type {import("../types").Capture} */ capture) {
      const children = [];

      if (capture.articleBlocks?.length) {
        children.push(...articleChildren(capture));
        addCaptureWarnings(children, capture.mediaDiagnostics);
        return children;
      }
      const mainStart = children.length;
      const around = splitAroundPaste(capture.text, capture.longTextAttachments, capture.links);
      const mainBlocks = paragraphBlocks(around.head, capture.links);
      children.push(...mainBlocks);
      addLongTextBlocks(children, capture.longTextAttachments, capture.links);
      if (around.tail) children.push(...paragraphBlocks(around.tail, capture.links));
      appendThreadPosition(children, capture.threadPosition, mainStart);
      addMediaBlocks(children, capture.media);
      addVideoBlocks(children, capture.videos);
      addLinkCards(children, capture.linkCards);
      addQuotedPostLinks(children, capture.quotedPosts);
      // A web page without a readable article keeps a preview card of the page itself.
      const pageBookmark = capture.platform === "web" && capture.captureType !== "selection"
        ? shared.webLinkUrl(capture.sourceUrl)
        : "";
      if (pageBookmark) children.push(bookmarkBlock(pageBookmark));
      if (!mainBlocks.length && !capture.longTextAttachments?.length && !capture.media?.length && !capture.videos?.length && !capture.quotedPosts?.length && !capture.linkCards?.length && !pageBookmark) {
        children.push(paragraph(shared.t("此貼文沒有可擷取的內容。")));
      }
      addCaptureWarnings(children, capture.mediaDiagnostics);

      children.push(...buildContinuationBlocks([
        ...(capture.continuations ?? []),
        ...(capture.authorReplies ?? [])
      ]));
      return children;
    }

    // Each continuation starts with a divider, so the same blocks can be appended to an existing page.
    function buildContinuationBlocks(/** @type {any} */ continuations) {
      const children = [];
      for (const continuation of continuations ?? []) {
        children.push(blankParagraph());
        children.push(divider());
        children.push(blankParagraph());
        const continuationStart = children.length;
        const around = splitAroundPaste(continuation.text, continuation.longTextAttachments, continuation.links);
        const continuationBlocks = paragraphBlocks(around.head, continuation.links);
        children.push(...continuationBlocks);
        addLongTextBlocks(children, continuation.longTextAttachments, continuation.links);
        if (around.tail) children.push(...paragraphBlocks(around.tail, continuation.links));
        appendThreadPosition(children, continuation.threadPosition, continuationStart);
        addMediaBlocks(children, continuation.media);
        addVideoBlocks(children, continuation.videos);
        addLinkCards(children, continuation.linkCards);
        addQuotedPostLinks(children, continuation.quotedPosts);
        if (!continuationBlocks.length && !continuation.longTextAttachments?.length && !continuation.media?.length && !continuation.videos?.length && !continuation.quotedPosts?.length && !continuation.linkCards?.length) {
          children.push(paragraph(shared.t("此則回覆沒有可擷取的內容。")));
        }
        addCaptureWarnings(children, continuation.mediaDiagnostics);
      }
      return children;
    }

    // A selection added to an existing page: a divider, then only the selected text.
    function buildSelectionAppendBlocks(/** @type {import("../types").Capture} */ capture) {
      const blocks = paragraphBlocks(capture?.text, capture?.links);
      if (!blocks.length) return [];
      return [blankParagraph(), divider(), blankParagraph(), ...blocks];
    }

    // Plain text of a page's top-level blocks, used to tell whether a selection is already there.
    function blocksPlainText(/** @type {any} */ blocks) {
      return (blocks ?? [])
        .map((/** @type {any} */ block) => (block?.[block?.type]?.rich_text ?? [])
          .map((/** @type {any} */ item) => item?.plain_text ?? item?.text?.content ?? "")
          .join(""))
        .filter(Boolean)
        .join("\n");
    }

    function isWebArticle(/** @type {import("../types").Capture} */ capture) {
      return capture.platform === "web" && capture.captureType !== "selection";
    }

    function captureTitleText(/** @type {import("../types").Capture} */ capture) {
      if (isWebArticle(capture) && shared.cleanText(capture.title)) return shared.cleanText(capture.title);
      const mainText = shared.cleanText(capture.text);
      if (mainText) return mainText;
      const mainAttachment = capture.longTextAttachments?.find((/** @type {any} */ item) => shared.cleanText(item?.text ?? item));
      if (mainAttachment) return shared.cleanText(mainAttachment?.text ?? mainAttachment);
      const followup = [...(capture.continuations ?? []), ...(capture.authorReplies ?? [])]
        .find(item => shared.cleanText(item?.text));
      return shared.cleanText(followup?.text) || shared.t("無文字貼文");
    }

    // The 來源 option of a capture: a key of PLATFORM_OPTIONS in notion/schema.js.
    function platformKey(/** @type {import("../types").Capture} */ capture) {
      const platform = capture.platform || shared.parseThreadsUrl(capture.sourceUrl).platform;
      if (platform === "web" && shared.youtubeVideoId(capture.sourceUrl)) return "youtube";
      if (platform === "web" && shared.linkedInPostInfo(capture.sourceUrl).id) return "linkedin";
      if (platform === "web" && shared.facebookPostInfo(capture.sourceUrl).token) return "facebook";
      return ["plurk", "x", "instagram", "web"].includes(platform) ? platform : "threads";
    }

    function platformSelect(/** @type {import("../types").Capture} */ capture) {
      const option = columnMap().platformOptions[platformKey(capture)];
      return option.id ? { id: option.id } : { name: option.name };
    }

    // A web article keeps its headline (up to 200 characters); posts are titled by their opening words.
    function pageTitle(/** @type {import("../types").Capture} */ capture) {
      const text = captureTitleText(capture);
      if (isWebArticle(capture) && shared.cleanText(capture.title)) return text.replace(/\s+/g, " ").slice(0, 200);
      return shared.buildTitle(text, capture.publishedAt, 30);
    }

    // A web article without a byline is credited to its site.
    function authorText(/** @type {import("../types").Capture} */ capture) {
      if (isWebArticle(capture)) return shared.cleanText(capture.author) || shared.cleanText(capture.siteName);
      return capture.author;
    }

    function buildPageProperties(/** @type {import("../types").Capture} */ capture) {
      const parsed = shared.parseThreadsUrl(capture.sourceUrl);
      const title = pageTitle(capture);
      const author = authorText(capture);
      /** @type {Record<string, any>} */
      const properties = {
        [columnId("title")]: {
          type: "title",
          title: [{ type: "text", text: { content: title } }]
        },
        [columnId("savedAt")]: {
          type: "date",
          date: { start: capture.savedAt }
        },
        [columnId("captureKey")]: {
          type: "rich_text",
          rich_text: richText(capture.dedupeKey)
        },
        [columnId("platform")]: {
          type: "select",
          select: platformSelect(capture)
        }
      };

      if (capture.sourceUrl) {
        properties[columnId("sourceUrl")] = { type: "url", url: capture.sourceUrl.slice(0, 2000) };
      }
      if (author) {
        properties[columnId("author")] = { type: "rich_text", rich_text: richText(author) };
      }
      if (capture.publishedAt && shared.validDate(capture.publishedAt)) {
        properties[columnId("publishedAt")] = {
          type: "date",
          date: { start: new Date(capture.publishedAt).toISOString() }
        };
      }
      if (parsed.postId) {
        properties[columnId("postId")] = { type: "rich_text", rich_text: richText(parsed.postId) };
      }
      if (capture.topicTag) {
        properties[columnId("topicTag")] = {
          type: "select",
          select: { name: shared.cleanText(capture.topicTag).slice(0, 100) }
        };
      }
      return properties;
    }

    // The page icon is the favicon of the site the capture came from, so the source shows at a glance.
    // Notion fetches it from Google's favicon service; a local or private address has none.
    function sourceIcon(/** @type {import("../types").Capture} */ capture) {
      let host;
      try {
        host = new URL(capture.sourceUrl).hostname;
      } catch {
        return null;
      }
      if (!host || shared.isPrivateNetworkHost(host)) return null;
      return {
        type: "external",
        external: { url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` }
      };
    }

    function createPagePayload(/** @type {import("../types").Capture} */ capture, /** @type {string} */ dataSourceId, /** @type {any} */ payloadOptions = {}) {
      /** @type {any} */
      const payload = {
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: buildPageProperties(capture),
        children: payloadOptions.children ?? chunkBlocks(buildPageChildren(capture))[0] ?? []
      };
      const icon = sourceIcon(capture);
      if (icon) payload.icon = icon;
      return payload;
    }

    function updatePagePayload(/** @type {import("../types").Capture} */ capture) {
      const properties = buildPageProperties(capture);
      return {
        properties,
        erase_content: true
      };
    }

    // The first and last top-level block this tool wrote, so the original can later be replaced
    // without touching notes the user added before or after it.
    function contentRangePayload(/** @type {any} */ firstBlockId, /** @type {any} */ lastBlockId) {
      const first = shared.extractNotionId(firstBlockId);
      const last = shared.extractNotionId(lastBlockId);
      return {
        properties: {
          [columnId("contentRange")]: {
            type: "rich_text",
            rich_text: first && last ? richText(`${first}..${last}`) : []
          }
        }
      };
    }

    function contentRangeFromPage(/** @type {any} */ page) {
      const text = (pageProperty(page?.properties, columnMap().columns.contentRange)?.rich_text ?? [])
        .map((/** @type {any} */ item) => item?.plain_text ?? item?.text?.content ?? "")
        .join("");
      const [first, last] = text.split("..").map((/** @type {any} */ value) => shared.extractNotionId(value));
      return first && last ? { first, last } : null;
    }

    // Properties refreshed when the original is re-captured; 保存時間 and 已核對 stay as they were.
    function refreshPagePropertiesPayload(/** @type {import("../types").Capture} */ capture) {
      const properties = buildPageProperties(capture);
      delete properties[columnId("savedAt")];
      return { properties };
    }

    // Shown above the earlier version of a page saved before 原文範圍 existed; nothing is deleted.
    function previousVersionNoticeBlocks() {
      return [
        blankParagraph(),
        divider(),
        {
          object: "block",
          type: "callout",
          callout: {
            rich_text: richText(shared.t("以下是更新前的內容，以及你在這頁寫的筆記。工具找不到這頁原文的位置（可能被移動或刪除過），所以沒有刪除任何東西；確認不需要後可以自己刪掉。")),
            icon: { type: "emoji", emoji: "🗂️" },
            color: "gray_background"
          }
        }
      ];
    }

    return {
      blocksPlainText,
      buildContinuationBlocks,
      buildPageChildren,
      chunkBlocks,
      contentRangeFromPage,
      contentRangePayload,
      previousVersionNoticeBlocks,
      refreshPagePropertiesPayload,
      buildSelectionAppendBlocks,
      captureTitleText,
      createPagePayload,
      savedThreadPositions,
      updatePagePayload
    };
  }

  return { createNotionPageBuilder };
});
