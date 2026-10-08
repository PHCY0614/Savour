/**
 * Web article capture: Readability finds the article body, then it is turned into the sanitized block
 * structure that notion/page-builder.js writes (headings, lists, tables, images, code).
 */
(function initializeSavourWebArticle(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourWebArticle = api;
})(globalThis, function createSavourWebArticleModule() {
  "use strict";

  const CAPTURE_VALIDATION_VERSION = 2;
  const MIN_ARTICLE_TEXT = 140;
  const BLOCK_CONTAINERS = new Set([
    "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "CENTER", "DETAILS",
    "SUMMARY", "DL", "DD", "DT", "FORM", "FIELDSET", "ADDRESS", "HGROUP", "BODY"
  ]);
  const SKIPPED = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SVG", "CANVAS",
    "OBJECT", "EMBED", "AUDIO", "SOURCE", "TRACK", "MAP", "DIALOG", "LINK", "META"
  ]);
  /** @type {any} */ const HEADING_LEVEL = { H1: 1, H2: 2, H3: 3, H4: 3, H5: 3, H6: 3 };
  const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com)$/i;

  // Reads the article on the current page: its metadata from the page head, its body through
  // Mozilla Readability, then turns that body into the block list notion/page-builder.js writes.
  function createWebArticleCapture(/** @type {any} */ options) {
    const S = options.shared;
    const Readability = options.Readability;

    function meta(/** @type {Document} */ doc, /** @type {any[]} */ ...selectors) {
      for (const selector of selectors) {
        const value = S.cleanText(doc.querySelector(selector)?.getAttribute("content") ?? "");
        if (value) return value;
      }
      return "";
    }

    function jsonLdItems(/** @type {Document} */ doc) {
      const items = /** @type {any[]} */ ([]);
      const visit = (/** @type {any} */ value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 4) return;
        if (Array.isArray(value)) return value.forEach(item => visit(item, depth + 1));
        items.push(value);
        if (Array.isArray(value["@graph"])) visit(value["@graph"], depth + 1);
      };
      for (const script of doc.querySelectorAll("script[type='application/ld+json']")) {
        try {
          visit(JSON.parse(script.textContent ?? ""));
        } catch {
          // Malformed structured data is common; the page's other metadata still applies.
        }
      }
      const articleType = /(?:Article|BlogPosting|Report|NewsArticle|Posting)$/;
      return items.filter(item => [].concat(item["@type"] ?? []).some(type => articleType.test(String(type))));
    }

    function personName(/** @type {any} */ value) {
      const names = /** @type {any[]} */ ([]).concat(value ?? []).map(item => S.cleanText(typeof item === "string" ? item : item?.name ?? ""));
      return names.filter(name => name && !/^https?:\/\//i.test(name)).join("、");
    }

    /**
     * Reads title, site name, author, date and lead image from the page's meta tags and JSON-LD.
     * @param {Document} doc
     */
    function readMetadata(doc) {
      const ld = jsonLdItems(doc)[0] ?? {};
      const author = meta(doc, "meta[name='author']", "meta[property='article:author']:not([content^='http'])",
        "meta[name='parsely-author']", "meta[name='sailthru.author']") || personName(ld.author);
      return {
        title: meta(doc, "meta[property='og:title']", "meta[name='twitter:title']")
          || S.cleanText(ld.headline ?? "")
          || S.cleanText(doc.title ?? ""),
        siteName: meta(doc, "meta[property='og:site_name']", "meta[name='application-name']")
          || personName(ld.publisher),
        author: /^https?:\/\//i.test(author) ? "" : author,
        publishedAt: meta(doc, "meta[property='article:published_time']", "meta[name='pubdate']",
          "meta[name='publishdate']", "meta[name='date']", "meta[itemprop='datePublished']",
          "meta[name='parsely-pub-date']")
          || S.cleanText(ld.datePublished ?? "")
          || S.cleanText(doc.querySelector("article time[datetime], time[pubdate][datetime]")?.getAttribute("datetime") ?? ""),
        description: meta(doc, "meta[property='og:description']", "meta[name='description']", "meta[name='twitter:description']"),
        image: meta(doc, "meta[property='og:image']", "meta[name='twitter:image']")
      };
    }

    function absoluteUrl(/** @type {any} */ value, /** @type {any} */ baseUrl) {
      if (!String(value ?? "").trim()) return "";
      try {
        const url = new URL(String(value ?? "").trim(), baseUrl);
        return /^https?:$/.test(url.protocol) ? url.href : "";
      } catch {
        return "";
      }
    }

    // The largest candidate of a srcset ("a.jpg 640w, b.jpg 1280w").
    function largestSrcset(/** @type {any} */ value, /** @type {any} */ baseUrl) {
      let best = "";
      let bestSize = -1;
      if (!value) return "";
      for (const candidate of String(value ?? "").split(/,\s+(?=\S)/)) {
        const [url, descriptor = ""] = candidate.trim().split(/\s+/);
        const size = parseFloat(descriptor) * (/x$/i.test(descriptor) ? 1000 : 1) || 0;
        const absolute = absoluteUrl(url, baseUrl);
        if (absolute && size > bestSize) {
          best = absolute;
          bestSize = size;
        }
      }
      return best;
    }

    // Lazy-loading pages keep the real address in data-* attributes or in what the browser loaded;
    // the copy given to Readability gets that address in src so the image survives extraction.
    function prepareImages(/** @type {any} */ clone, /** @type {any} */ liveDoc, /** @type {any} */ baseUrl) {
      const liveImages = [...(liveDoc?.images ?? [])];
      [...clone.querySelectorAll("img")].forEach((image, index) => {
        const live = liveImages[index];
        const loaded = live && live.currentSrc && !/^data:/i.test(live.currentSrc) ? live.currentSrc : "";
        const lazy = ["data-src", "data-original", "data-lazy-src", "data-url", "data-actualsrc", "data-hi-res-src"]
          .map(name => image.getAttribute(name))
          .find(value => value && !/^data:/i.test(value));
        const srcset = largestSrcset(image.getAttribute("data-srcset") || image.getAttribute("srcset"), baseUrl);
        const best = absoluteUrl(srcset || lazy || loaded || image.getAttribute("src"), baseUrl);
        if (best) image.setAttribute("src", best);
        const width = Number(live?.naturalWidth || image.getAttribute("width") || 0);
        const height = Number(live?.naturalHeight || image.getAttribute("height") || 0);
        // Tracking pixels and icons are not part of the article.
        if ((width && width < 48) || (height && height < 48)) image.setAttribute("data-savour-skip", "1");
      });
    }

    // ---- HTML element -> article blocks ----

    function toBlocks(/** @type {any} */ rootNode, /** @type {any} */ baseUrl) {
      const blocks = /** @type {any[]} */ ([]);
      let spans = /** @type {any[]} */ ([]);

      function flush(type = "paragraph") {
        if (spans.some(span => span.text.trim())) blocks.push({ type, spans });
        spans = [];
      }

      function pushText(/** @type {string} */ text, /** @type {any} */ format) {
        if (!text) return;
        spans.push({ text, ...format });
      }

      function imageBlock(/** @type {any} */ image, /** @type {any} */ caption = []) {
        if (image.getAttribute("data-savour-skip")) return;
        const url = absoluteUrl(image.getAttribute("src"), baseUrl);
        if (!url || /\.svg(?:$|\?)/i.test(url)) return;
        flush();
        blocks.push({ type: "image", url, caption });
      }

      // Text inside one block: collapses HTML whitespace and keeps links and emphasis.
      function inline(/** @type {any} */ node, /** @type {any} */ format) {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            pushText(child.nodeValue.replace(/\s+/g, " "), format);
            continue;
          }
          if (child.nodeType !== 1 || SKIPPED.has(child.nodeName)) continue;
          const tag = child.nodeName;
          if (tag === "BR") {
            pushText("\n", format);
          } else if (tag === "IMG") {
            // Emoji and small icons inside text keep their meaning through alt text.
            const alt = S.cleanText(child.getAttribute("alt") ?? "");
            if (child.getAttribute("data-savour-skip") || /emoji/i.test(child.className)) pushText(alt, format);
            else imageBlock(child);
          } else if (tag === "A") {
            const href = absoluteUrl(child.getAttribute("href"), baseUrl);
            inline(child, href ? { ...format, href } : format);
          } else if (tag === "STRONG" || tag === "B") {
            inline(child, { ...format, bold: true });
          } else if (tag === "EM" || tag === "I" || tag === "CITE") {
            inline(child, { ...format, italic: true });
          } else if (tag === "CODE" || tag === "KBD" || tag === "SAMP" || tag === "TT") {
            inline(child, { ...format, code: true });
          } else if (tag === "S" || tag === "DEL" || tag === "STRIKE") {
            inline(child, { ...format, strike: true });
          } else if (tag === "U" || tag === "INS") {
            inline(child, { ...format, underline: true });
          } else if (isBlockElement(child)) {
            // A block inside running text (a <div> in a <p>) starts a new paragraph.
            flush();
            block(child);
          } else {
            inline(child, format);
          }
        }
      }

      function isBlockElement(/** @type {Element} */ node) {
        return BLOCK_CONTAINERS.has(node.nodeName)
          || /^(?:P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|FIGURE|TABLE|HR|IFRAME|VIDEO|PICTURE)$/.test(node.nodeName);
      }

      function spansOf(/** @type {Element} */ node) {
        const saved = spans;
        spans = [];
        inline(node, {});
        const result = spans;
        spans = saved;
        return result;
      }

      function list(/** @type {any} */ node, /** @type {any} */ ordered) {
        for (const item of node.children) {
          if (item.nodeName !== "LI") {
            block(item);
            continue;
          }
          // Nested lists are written as further items of the same list.
          const nested = [...item.children].filter(child => child.nodeName === "UL" || child.nodeName === "OL");
          const own = item.cloneNode(true);
          own.querySelectorAll(":scope > ul, :scope > ol").forEach((/** @type {any} */ child) => child.remove());
          const itemSpans = spansOf(own);
          if (itemSpans.some(span => span.text.trim())) blocks.push({ type: ordered ? "numbered" : "bulleted", spans: itemSpans });
          for (const child of nested) list(child, child.nodeName === "OL");
        }
      }

      function table(/** @type {Element} */ node) {
        const rows = [...node.querySelectorAll("tr")]
          .filter(row => row.closest("table") === node)
          .map(row => [...row.children].filter(cell => /^(?:TD|TH)$/.test(cell.nodeName)).map(spansOf));
        const header = Boolean(node.querySelector("thead th, tr:first-child th"));
        blocks.push({ type: "table", rows, header });
      }

      function figure(/** @type {Element} */ node) {
        const caption = node.querySelector("figcaption");
        const captionSpans = caption ? spansOf(caption) : [];
        const images = [...node.querySelectorAll("img")].filter(image => !caption?.contains(image));
        if (!images.length) {
          caption?.remove();
          block(node, true);
          if (captionSpans.length) blocks.push({ type: "paragraph", spans: captionSpans });
          return;
        }
        images.forEach((image, index) => imageBlock(image, index === images.length - 1 ? captionSpans : []));
      }

      function embed(/** @type {Element} */ node) {
        const url = absoluteUrl(node.getAttribute("src") || node.querySelector("source")?.getAttribute("src"), baseUrl);
        if (!url) return;
        try {
          if (VIDEO_HOSTS.test(new URL(url).hostname)) blocks.push({ type: "video", url });
        } catch {
          // Not a usable address.
        }
      }

      function block(/** @type {any} */ node, containerOnly = false) {
        const tag = node.nodeName;
        if (!containerOnly) {
          if (SKIPPED.has(tag)) return;
          if (HEADING_LEVEL[tag]) {
            flush();
            const headingSpans = spansOf(node).map(span => ({ ...span, bold: undefined }));
            blocks.push({ type: "heading", level: Math.max(2, HEADING_LEVEL[tag]), spans: headingSpans });
            return;
          }
          if (tag === "P") {
            flush();
            inline(node, {});
            flush();
            return;
          }
          if (tag === "UL" || tag === "OL") {
            flush();
            list(node, tag === "OL");
            return;
          }
          if (tag === "BLOCKQUOTE") {
            flush();
            const quoteSpans = [];
            const text = node.querySelectorAll("p, li");
            if (text.length > 1) {
              // Keep paragraph breaks inside the quote as line breaks.
              text.forEach((/** @type {any} */ part, /** @type {number} */ index) => quoteSpans.push(...(index ? [{ text: "\n" }] : []), ...spansOf(part)));
            } else {
              quoteSpans.push(...spansOf(node));
            }
            blocks.push({ type: "quote", spans: quoteSpans });
            node.querySelectorAll("img").forEach((/** @type {any} */ image) => imageBlock(image));
            return;
          }
          if (tag === "PRE") {
            flush();
            blocks.push({ type: "code", text: node.textContent ?? "" });
            return;
          }
          if (tag === "FIGURE") {
            flush();
            figure(node);
            return;
          }
          if (tag === "TABLE") {
            flush();
            table(node);
            return;
          }
          if (tag === "HR") {
            flush();
            blocks.push({ type: "divider" });
            return;
          }
          if (tag === "IFRAME" || tag === "VIDEO") {
            flush();
            embed(node);
            return;
          }
          if (tag === "IMG") {
            imageBlock(node);
            return;
          }
          if (!BLOCK_CONTAINERS.has(tag) && tag !== "PICTURE") {
            inline(wrap(node), {});
            return;
          }
        }
        // Containers: inline runs between child blocks become their own paragraphs.
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            pushText(child.nodeValue.replace(/\s+/g, " "), {});
          } else if (child.nodeType === 1) {
            if (isBlockElement(child) || HEADING_LEVEL[child.nodeName]) {
              flush();
              block(child);
            } else {
              inline(wrap(child), {});
            }
          }
        }
        flush();
      }

      // inline() reads a node's children; wrap lets it read the node itself.
      function wrap(/** @type {Element} */ node) {
        return { childNodes: [node] };
      }

      block(rootNode, true);
      flush();
      return blocks;
    }

    function blocksText(/** @type {any} */ blocks) {
      return blocks.map((/** @type {any} */ block) => (block.spans ?? []).map((/** @type {any} */ span) => span.text).join("") || block.text || "").join("\n");
    }

    function dropLeadingTitle(/** @type {any} */ blocks, /** @type {string} */ title) {
      const normalized = S.cleanText(title).replace(/\s+/g, " ");
      const first = blocks.findIndex((/** @type {any} */ block) => block.type !== "image");
      if (first !== -1 && blocks[first].type === "heading"
        && S.cleanText(blocksText([blocks[first]])).replace(/\s+/g, " ") === normalized) {
        blocks.splice(first, 1);
      }
      return blocks;
    }

    function pageTitle(/** @type {any} */ metadata, /** @type {any} */ article) {
      const candidates = [S.cleanText(article?.title ?? ""), metadata.title].filter(Boolean);
      return (candidates[0] || location.hostname).replace(/\s+/g, " ").slice(0, 300);
    }

    /**
     * Captures a web article: Readability picks the main content, which becomes sanitized article blocks.
     * Works on a copy of the document, so the page itself is not changed.
     * @param {Document} [doc]
     */
    function captureArticle(doc = document) {
      const baseUrl = doc.baseURI || location.href;
      const sourceUrl = S.normalizeThreadsUrl(location.href);
      const metadata = readMetadata(doc);
      const clone = /** @type {Document} */ (doc.cloneNode(true));
      prepareImages(clone, doc, baseUrl);
      // Wiki "[edit]" links beside section headings make Readability drop the headings themselves.
      clone.querySelectorAll(".mw-editsection, .editsection").forEach(node => node.remove());
      let article;
      try {
        article = new Readability(clone, { charThreshold: 300, serializer: (/** @type {Element} */ element) => element }).parse();
      } catch {
        article = null;
      }
      let blocks = article?.content ? toBlocks(article.content, baseUrl) : [];
      const title = pageTitle(metadata, article);
      blocks = dropLeadingTitle(blocks, title);
      const bodyText = S.cleanText(blocksText(blocks));
      const capture = {
        platform: "web",
        captureType: "post",
        sourceUrl,
        title,
        siteName: metadata.siteName || S.cleanText(article?.siteName ?? "") || location.hostname.replace(/^www\./, ""),
        author: S.cleanText(article?.byline ?? "") || metadata.author,
        publishedAt: S.validDate(metadata.publishedAt) ? metadata.publishedAt
          : S.validDate(article?.publishedTime) ? article.publishedTime : "",
        excerpt: metadata.description || S.cleanText(article?.excerpt ?? ""),
        text: "",
        captureValidation: { version: CAPTURE_VALIDATION_VERSION, source: "web-page", postId: "", validated: true },
        continuations: /** @type {any[]} */ ([]),
        authorReplies: /** @type {any[]} */ ([])
      };
      if (bodyText.length >= MIN_ARTICLE_TEXT || (bodyText && blocks.some(block => block.type === "image"))) {
        return { ...capture, articleBlocks: blocks };
      }
      // No readable article (a web app, a video page): keep what the page says about itself.
      const image = absoluteUrl(metadata.image, baseUrl);
      const fallback = {
        ...capture,
        // A few scraps of page text ("首頁") say less than the page's own description.
        text: metadata.description || bodyText,
        media: image ? [{ type: "image", url: image }] : [],
        reviewFlags: ["正文疑似遺漏"],
        captureNotes: [S.t("這個頁面讀不到完整文章，只保存了標題、簡介與代表圖片；可以改用反白文字保存需要的段落。")]
      };
      if (!fallback.text && !fallback.media.length) {
        throw new Error(S.t("這個頁面沒有可以保存的文章內容，可以改用反白文字保存需要的段落"));
      }
      return fallback;
    }

    return { captureArticle, readMetadata, toBlocks };
  }

  return { createWebArticleCapture };
});
