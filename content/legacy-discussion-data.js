/**
 * Finds a Threads thread's related posts in the JSON the page embeds. "Legacy" because saving replies as
 * separate pages is disabled; threads-content.js still uses it to read the thread.
 */
(function initializeSavourLegacyDiscussionData(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourLegacyDiscussionData = api;
})(globalThis, function createSavourLegacyDiscussionDataModule() {
  "use strict";

  /**
   * Reads thread posts from the page's embedded JSON. `options.getHelpers()` supplies helpers from threads-content.js.
   */
  function createLegacyDiscussionData(/** @type {any} */ options) {
    const S = options.shared;

    /**
     * Finds the JSON script that lists the thread containing `currentPostId` and returns its posts in order.
     * When several scripts qualify, the one with the most posts wins.
     * @param {ParentNode} rootNode where to look for <script type="application/json">
     * @param {string} currentPostId
     * @param {string} sourceLabel recorded on each entry as `discussionSource`
     */
    function collectDiscussionEntriesFromJsonRoot(rootNode, currentPostId, sourceLabel) {
      if (!rootNode || !currentPostId) return [];

      const scripts = [...rootNode.querySelectorAll('script[type="application/json"]')];
      let best = /** @type {any[]} */ ([]);

      for (const script of scripts) {
        const raw = script.textContent || "";
        if (!raw.includes(currentPostId)) continue;
        if (!raw.includes('"thread_items"')) continue;

        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }

        const arrays = /** @type {any[]} */ ([]);
        collectThreadItemArrays(data, arrays);
        if (!arrays.length) continue;

        const seen = new Set();
        const entries = [];

        for (const items of arrays) {
          for (const item of items) {
            /** @type {any} */
            const entry = discussionEntryFromJsonThreadItem(item);
            if (!entry?.postId || seen.has(entry.postId)) continue;
            seen.add(entry.postId);
            entry.discussionOrder = entries.length;
            entry.discussionSource = sourceLabel;
            entries.push(entry);
          }
        }

        if (!entries.some(entry => entry.postId === currentPostId)) continue;
        if (entries.length > best.length) best = entries;
      }

      return best;
    }

    /**
     * The posts of the thread open in this tab, read from the page's own JSON; [] when the URL is not a post.
     */
    function collectDiscussionEntriesFromLivePageJson() {
      const current = S.parseThreadsUrl(location.href);
      if (!current.postId) return [];
      return collectDiscussionEntriesFromJsonRoot(document, current.postId, "LIVE-JSON");
    }

    /**
     * Collects every `thread_items` array anywhere inside `value` into `output`.
     * @param {any} value parsed JSON, walked without a schema
     * @param {unknown[][]} output
     */
    function collectThreadItemArrays(value, output) {
      if (!value) return;

      if (Array.isArray(value)) {
        for (const item of value) collectThreadItemArrays(item, output);
        return;
      }

      if (typeof value !== "object") return;

      if (Array.isArray(value.thread_items)) {
        output.push(value.thread_items);
      }

      for (const child of Object.values(value)) {
        collectThreadItemArrays(child, output);
      }
    }

    /**
     * Turns one `thread_items` entry into a post entry (author, text, URL, date, thread position, links), or null
     * when it has no post id or author.
     * @param {any} item untrusted JSON
     */
    function discussionEntryFromJsonThreadItem(item) {
      const post = item?.post;
      if (!post || typeof post !== "object") return null;

      const postId = S.cleanText(post.code || "");
      const author = S.cleanHandle(post.user?.username || "");
      const text = S.extractStructuredPostText(post);
      const appInfo = post.text_post_app_info ?? {};
      const threadPosition = S.extractStructuredThreadPosition(post);
      const { links, linkCards } = S.extractStructuredLinks(post);

      if (!postId || !author) return null;

      let publishedAt = "";
      const takenAt = Number(post.taken_at);
      if (Number.isFinite(takenAt) && takenAt > 0) {
        publishedAt = new Date(takenAt * 1000).toISOString();
      }

      return {
        author,
        text,
        sourceUrl: `${location.origin}/@${author}/post/${postId}`,
        postId,
        publishedAt,
        isReply: appInfo.is_reply === true,
        replyToAuthor: S.cleanHandle(appInfo.reply_to_author?.username || ""),
        rootAuthor: S.cleanHandle(appInfo.root_post_author?.username || ""),
        threadPosition,
        quotedPosts: S.extractStructuredQuotedPosts(post),
        links,
        linkCards,
        orderNode: options.getHelpers().findDiscussionPermalinkByPostId(postId),
        quality: 700,
        discussionSource: "page-json"
      };
    }

    // Reads only the data already on the open page; the extension never re-downloads Threads pages.
    function collectCurrentThreadRelationshipEntries() {
      return collectDiscussionEntriesFromLivePageJson().filter(entry => entry?.postId);
    }

    /**
     * Fills the root post's text, thread position, quoted posts and links from the matching JSON entry, which is
     * often more complete than the DOM. Mutates and returns `root`.
     * @param {any} root the post read from the DOM
     * @param {any[]} entries from collectCurrentThreadRelationshipEntries
     */
    function mergeStructuredRootEntry(root, entries) {
      const rootPostId = S.parseThreadsUrl(root?.sourceUrl).postId;
      const structured = (entries ?? []).find((/** @type {any} */ entry) => entry?.postId === rootPostId);
      if (!structured) return root;

      const split = S.splitTrailingThreadPosition(structured.text);
      if (split.text.length > S.cleanText(root.text).length) root.text = split.text;
      root.threadPosition = S.normalizeThreadPosition(structured.threadPosition)
        || split.threadPosition
        || root.threadPosition;
      root.quotedPosts = options.getHelpers().mergeQuotedPosts(root.quotedPosts, structured.quotedPosts);
      root.links = S.normalizeLinks([...(root.links ?? []), ...(structured.links ?? [])]);
      root.linkCards = S.normalizeLinks([...(root.linkCards ?? []), ...(structured.linkCards ?? [])], 10)
        .filter((/** @type {any} */ card) => !root.links.some((/** @type {any} */ link) => link.url === card.url));
      root.publishedAt ||= structured.publishedAt || "";
      return root;
    }

    return {
      collectCurrentThreadRelationshipEntries,
      collectDiscussionEntriesFromJsonRoot,
      collectDiscussionEntriesFromLivePageJson,
      collectThreadItemArrays,
      discussionEntryFromJsonThreadItem,
      mergeStructuredRootEntry
    };
  }

  return { createLegacyDiscussionData };
});
