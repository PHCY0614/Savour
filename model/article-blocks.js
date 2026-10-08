/**
 * Sanitizes the block structure of a saved web article (headings, paragraphs, lists, tables, images)
 * before it becomes Notion blocks: unknown block types and non-http links are dropped, sizes capped.
 */
(function attachSavourArticleBlocks(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("../lib/shared.js")
    : root.SavourShared;
  const api = factory(shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourArticleBlocks = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createArticleBlocks(/** @type {typeof import("../lib/shared.js")} */ S) {
  "use strict";

  // The structure of a saved web article, as the content script reads it and before it becomes Notion
  // blocks. Everything a page sends is re-checked here: unknown block types and non-http links are dropped.
  //   { type: "heading", level: 1-3, spans }   { type: "paragraph" | "quote" | "bulleted" | "numbered", spans }
  //   { type: "code", text }   { type: "image", url, caption }   { type: "divider" }
  //   { type: "table", rows: [[spans, ...], ...], header }   { type: "video" | "bookmark", url }
  // spans: [{ text, href?, bold?, italic?, code?, strike?, underline? }]
  const TEXT_TYPES = new Set(["paragraph", "quote", "bulleted", "numbered"]);
  const ANNOTATIONS = ["bold", "italic", "code", "strike", "underline"];
  const MAX_BLOCKS = 1500;
  const MAX_TOTAL_TEXT = 400000;
  const MAX_SPANS = 400;
  const MAX_IMAGES = 60;
  const MAX_TABLE_ROWS = 100;
  const MAX_TABLE_COLUMNS = 20;

  function imageUrl(/** @type {any} */ value) {
    try {
      const url = new URL(String(value ?? "").trim());
      return /^https?:$/.test(url.protocol) && url.href.length <= 2000 ? url.href : "";
    } catch {
      return "";
    }
  }

  function sameFormat(/** @type {any} */ left, /** @type {any} */ right) {
    return left.href === right.href && ANNOTATIONS.every(name => Boolean(left[name]) === Boolean(right[name]));
  }

  function sanitizeSpans(/** @type {any} */ spans, /** @type {any} */ budget) {
    const result = /** @type {any[]} */ ([]);
    for (const span of Array.isArray(spans) ? spans : []) {
      let text = String(span?.text ?? "").replace(/\r\n?/g, "\n").replace(/[\t\f\v ]/g, " "); // eslint-disable-line no-irregular-whitespace -- the class deliberately holds a non-breaking space
      if (!text) continue;
      if (text.length > budget.remaining) text = text.slice(0, Math.max(0, budget.remaining));
      if (!text) break;
      budget.remaining -= text.length;
      /** @type {any} */ const clean = { text };
      const href = S.webLinkUrl(span?.href);
      if (href) clean.href = href;
      for (const name of ANNOTATIONS) if (span?.[name] === true) clean[name] = true;
      const last = result.at(-1);
      if (last && sameFormat(last, clean)) last.text += clean.text;
      else result.push(clean);
    }
    // Leading and trailing whitespace of a block carries no meaning.
    while (result.length && !(result[0].text = result[0].text.replace(/^\s+/, ""))) result.shift();
    while (result.length && !(result.at(-1).text = result.at(-1).text.replace(/\s+$/, ""))) result.pop();
    const kept = result.filter(span => span.text);
    if (kept.length <= MAX_SPANS) return kept;
    // Too many pieces for one block: keep the words, drop the formatting.
    return [{ text: kept.map(span => span.text).join("") }];
  }

  function spansText(/** @type {any} */ spans) {
    return (spans ?? []).map((/** @type {any} */ span) => span.text).join("");
  }

  // Returns { blocks, media }: image blocks point into media (by index) for uploading to Notion.
  function sanitizeArticleBlocks(/** @type {any} */ rawBlocks) {
    const budget = { remaining: MAX_TOTAL_TEXT };
    const blocks = [];
    const media = [];
    const mediaIndex = new Map();
    for (const raw of Array.isArray(rawBlocks) ? rawBlocks : []) {
      if (blocks.length >= MAX_BLOCKS || budget.remaining <= 0) break;
      const type = String(raw?.type ?? "");
      if (type === "heading") {
        const spans = sanitizeSpans(raw.spans, budget);
        const level = Math.min(3, Math.max(1, Number(raw.level) || 2));
        if (spans.length) blocks.push({ type, level, spans });
      } else if (TEXT_TYPES.has(type)) {
        const spans = sanitizeSpans(raw.spans, budget);
        if (spans.length) blocks.push({ type, spans });
      } else if (type === "code") {
        let text = String(raw.text ?? "").replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
        text = text.slice(0, Math.max(0, budget.remaining));
        budget.remaining -= text.length;
        if (text) blocks.push({ type, text });
      } else if (type === "image") {
        const url = imageUrl(raw.url);
        if (!url) continue;
        /** @type {any} */ const block = { type, url, caption: sanitizeSpans(raw.caption, budget) };
        if (mediaIndex.has(url)) {
          block.media = mediaIndex.get(url);
        } else if (media.length < MAX_IMAGES) {
          block.media = media.length;
          mediaIndex.set(url, media.length);
          media.push({ type: "image", url, thumbnailUrl: "", width: 0, height: 0 });
        }
        blocks.push(block);
      } else if (type === "divider") {
        if (blocks.length && blocks.at(-1).type !== "divider") blocks.push({ type });
      } else if (type === "table") {
        const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, MAX_TABLE_ROWS)
          .map((/** @type {any} */ row) => (Array.isArray(row) ? row : []).slice(0, MAX_TABLE_COLUMNS).map(cell => sanitizeSpans(cell, budget)))
          .filter((/** @type {any} */ row) => row.some((/** @type {any} */ cell) => cell.length));
        const width = Math.max(0, ...rows.map((/** @type {any} */ row) => row.length));
        if (!rows.length || !width) continue;
        // A one-column table reads better as plain paragraphs.
        if (width === 1) {
          for (const row of rows) if (row[0]?.length) blocks.push({ type: "paragraph", spans: row[0] });
          continue;
        }
        blocks.push({
          type,
          header: raw.header === true,
          rows: rows.map((/** @type {any} */ row) => Array.from({ length: width }, (_, index) => row[index] ?? []))
        });
      } else if (type === "video" || type === "bookmark") {
        const url = S.webLinkUrl(raw.url);
        if (url) blocks.push({ type, url });
      }
    }
    while (blocks.at(-1)?.type === "divider") blocks.pop();
    while (blocks[0]?.type === "divider") blocks.shift();
    return { blocks, media };
  }

  // Plain text of the article, paragraphs separated by blank lines.
  function articlePlainText(/** @type {any} */ blocks) {
    return S.cleanText((blocks ?? []).map((/** @type {any} */ block) => {
      if (block.type === "code") return block.text;
      if (block.type === "table") return block.rows.map((/** @type {any} */ row) => row.map(spansText).join(" | ")).join("\n");
      if (block.type === "image") return spansText(block.caption);
      return spansText(block.spans);
    }).filter(Boolean).join("\n\n"));
  }

  return {
    MAX_BLOCKS,
    MAX_IMAGES,
    articlePlainText,
    sanitizeArticleBlocks,
    sanitizeSpans: (/** @type {any} */ spans) => sanitizeSpans(spans, { remaining: MAX_TOTAL_TEXT })
  };
});
