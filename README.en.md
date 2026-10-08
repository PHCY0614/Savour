# Savour

[正體中文](README.md)

**Save now. Savour later.**

> Too much to read now. Too good to lose.

What we find online ends up scattered across bookmarks, likes and screenshots, and by the time we have a moment to read, we're hunting for it all over again. Savour handles the saving and the organising: one click saves what you're viewing into your own Notion database, with the author, source, publish date and save date filled in automatically. Everything sits in one place, searchable and filterable, to digest at your own pace.

It saves web articles (news, blogs, Wikipedia…), YouTube videos, and posts from Threads, Plurk, X, Instagram, Facebook and LinkedIn. It works only when you press save, and your data goes straight from your Chrome to your Notion, with no server in between.

## What gets saved

### YouTube videos

- **Saved**: the video embed (plays inside Notion), channel name and length, the full description (URLs become links), and the publish date. Timecodes in the description such as `0:00 Intro` are turned into a chapter list, and clicking one jumps to that point in the video. The "Source" column is YouTube.
- **Not saved**: the video file itself, captions/transcripts, comments.
- Different URL forms of the same video (`youtu.be`, links with time or playlist parameters, Shorts) count as the same item and are not saved twice.
- For live streams, only the current video information is saved.

### Facebook posts

- **Saved**: the text of personal, Page and group posts (emoji and links kept), post images, link previews, author and publish time. The "Source" column is Facebook. Images are downloaded by your Chrome and uploaded to your Notion, so they do not break when Facebook's image addresses expire.
- Open the single post page first (click the post's timestamp), then save; posts in the feed cannot be saved directly.
- **Limits**: images are the size shown on screen, not the original; Facebook does not always provide the publish time on the page, and when it is missing the "Published" column is left empty; comments, reaction counts and videos are not saved; for a shared post, only the sharer's own text and the preview image on screen are saved, and the original shared post is not processed.
- The same post opened through different URL forms (`m.facebook.com`, tracking parameters) counts as the same item.

### LinkedIn posts

- **Saved**: the text (links and @mentions kept), images and every page of PDF carousels, link cards in the post, the author and the publish time (derived from the post ID, so a relative date such as "2 weeks ago" does not matter). The "Source" column is LinkedIn.
- **Reposts**: the reposter's own comment is saved. The original post gets only its author, a short summary and a bookmark link to it; the original's images and full text are not saved.
- Open the single post page first (click the post's timestamp), then save; text in the feed is collapsed, so posts there cannot be saved directly.
- **Not saved**: comments and reaction counts; for videos, only the text and images. Different URL forms (`/posts/…`, `/feed/update/…`) of the same post count as the same item.

### Web articles

- **Body text only**: Mozilla Readability (the same method Firefox Reader View uses) finds the article itself, so navigation bars, "trending" sidebars, ads and footers are left out.
- **Layout kept**: heading levels, paragraphs, bold/italic, in-text links, lists, quotes, tables and code blocks become the matching Notion blocks. YouTube and Vimeo videos become videos Notion can play.
- **Images**: kept where they are in the article, with captions. Notion imports them from the site's public address into your workspace, so they remain even if the site later removes them; images Notion cannot fetch (sites that require login or block hotlinking) are kept as a link to the original.
- **Title, site, author, publish time**: taken from what the page provides. When no author is given, the "Author" column holds the site name.
- On pages where no article can be found (for example web tools or video pages), only the title, description, lead image and a web bookmark are saved, and "Recent saves" in the extension shows "Text may be missing"; you can save the passages you need by highlighting them instead.
- Tracking parameters (`utm_*`, `fbclid`, etc.) and the `#` part are removed from the address, so the same article is not saved twice because you arrived from different places.
- Images pointing to your computer or local network (such as `localhost`, `192.168.x.x`, a router or a NAS) are not downloaded and not linked in Notion; they are processed only when the article itself is on that local site.

### X (Twitter)

- **Post text** (emoji and links included), original-size images, and link preview cards (saved as Notion bookmarks).
- **The author's own thread**: posts by the same author directly below the post on its page are added to the same Notion page, stopping at anyone else's reply. The author's replies to readers, and readers' replies, are not saved.
- **Quotes**: a quoted post is kept as one line, "Quote:" plus the address.
- For posts X collapses behind "Show more", "Recent saves" shows "Text may be missing"; open the post itself and save again to get the full text. Videos are not saved.

### Instagram

- **The full caption** (including the part folded behind "… more"), author and publish time.
- **All images**: every photo in a carousel in order, at the largest size. For Reels and videos the cover image is saved, not the video.
- Only the post itself is saved; comments and the "more posts" section below are not.
- When you open another post from within Instagram, the page data still belongs to the previous one, so before saving the extension **reloads the page once automatically**, the same as for Threads.
- Save from the post page (`instagram.com/p/…` or `/reel/…`); open a post from the feed first.

### Threads

- **The main post text**, including the full text of long-text attachments that Threads folds away.
- **`1/N` threads**: continuations by the same author clearly marked `1/N`, `2/N` are ordered by number and placed on the same Notion page, even if pinning shuffles the on-screen order.
- **The author's own follow-ups**: unnumbered follow-ups where the author replies directly to their own main post are placed after the thread. Readers' comments and the author's replies to readers are not saved.
- **Images**: downloaded and uploaded to Notion in their original order. Avatars, emoji stickers and link-preview thumbnails are not treated as post images.
- **Links**: URLs in the text are clickable in Notion, and point to the full address even when Threads shortened them to "…". Full URLs written out are linked automatically. Links that appear only in a preview card are saved as Notion bookmarks.
- **Quotes**: a quoted post is kept as one line, "Quote:" plus the address, so nobody else's content is mixed into the text.
- The **Threads topic**, author, publish time and source address are stored in database columns.

### Plurk

- **The plurk text**, original-size images, links (shortened addresses are clickable too) and link preview cards (saved as Notion bookmarks).
- **Plurk Paste long text**: a Paste attached to a plurk is read in full and placed directly below the Paste link; any text that originally came after the Paste link (such as tags) goes below the Paste text. The extension first reads the public Paste as a logged-out visitor; only if that fails does it open a background tab, read with your own login and close it. If neither works, the plurk is still saved and "Recent saves" shows "Text may be missing".
- **The plurk owner's own follow-ups**: content the owner continues in the responses is added after the plurk; replies that begin with a reader's name and a colon, and other people's responses are not saved. Only responses already loaded on screen are saved.
- Friends-only plurks: you can save only what you can see, and once in Notion it is your private copy, so please do not leak it.

## What it does not do

- It never reads any web page unless you press save.
- An existing Notion page is not changed unless you press "Update Notion page", complete missing thread parts, or add selected text to that page.
- It does not re-download pages in the background (the one exception is YouTube: after you switch to another video within the site, that video's page is read again), does not log in, and does not bypass paywalls or private-account restrictions.
- There is no analytics or tracking, and no data goes anywhere other than the sites you save from and Notion.

## Install

1. Install from the Chrome Web Store; or download the ZIP, unzip it, turn on "Developer mode" at `chrome://extensions`, press "Load unpacked" and choose the folder that contains `manifest.json`.
2. Pinning the extension to the toolbar is recommended.

## First-time setup

### 1. Connect to Notion

1. Create an Internal Integration at [Notion Integrations](https://www.notion.so/profile/integrations) with the "Read content, Insert content, Update content" capabilities turned on.
2. Copy the Integration token (do not paste it in chats or public places).
3. Open the extension's settings page, paste the token under "Notion connection", and press "Save settings" or "Test Notion access".

By default the token is kept only until Chrome fully closes. Tick "Remember the token on this computer" to avoid pasting it every time, but only on your own computer.

### 2. Choose a database

**Use an existing database**

1. Open the database in Notion, press "⋯" at the top right → "Connections", and add the Integration you just made.
2. Back on the settings page, press "Load available databases" (it loads automatically when a token is already set), pick one from the list, then press "Use this database".
3. An empty database works too; missing columns are added automatically.

If it is not in the list, expand "Advanced: paste a database URL".

**Let the extension create a new database**

Create a blank page in Notion and add the Integration to it, paste its address under "Create a new database", and press "Create Notion database".

**Switch databases**

You can pick another database on the settings page at any time. You are asked to confirm first; afterwards the extension clears its local "saved" records and reads the new database instead. Articles in neither database are deleted or modified. You cannot switch while items are still pending.

### 3. Interface language

Savour's screens, messages and right-click menu come in Traditional Chinese and English. It follows the browser's language by default; press "中／EN" at the top right of the settings page to fix it to Chinese or English, and the settings page reloads.

The column names and "Source" options of a new database follow the interface language at the time: an English interface creates English columns such as Name, Source URL and Source (options Plurk, Web…). Once created, the database's language is fixed and switching the interface language later does not change it. The extension recognises columns by ID, so you can rename them as you like. Text the extension writes inside pages ("Quote:", capture notes, etc.) follows the interface language at the moment of saving.

## Usage

| To do this | How |
|---|---|
| Save the current article or post | Open a web article, YouTube video (`youtube.com/watch?v=…`), a single Threads post, a single plurk (`plurk.com/p/…`), an X post (`x.com/account/status/…`), an Instagram post (`instagram.com/p/…`), or the single-post page of Facebook or LinkedIn, then press "Save this page" in the extension, press `Alt+S`, or right-click the page and choose "Save the current page to Notion" |
| Update a saved page with the latest content | Open the article or post you already saved, press "Update Notion page" in the extension, then press again to confirm |
| Save just a passage | Highlight text and right-click → "Save selected text to Notion" → "Save as a new page"; or open the extension and press "Save as a new page" next to "Save selected text" |
| Add a passage to a saved page | Highlight, right-click → "Save selected text to Notion" → "Add to this post's Notion page", or "Add to another page…" to pick a page from your database in the menu that opens under the extension icon; the "Add to an existing page" button in the extension opens the same menu; you can also assign it a shortcut (see below) |
| Save one post from a feed | Open that post first (click its timestamp), then press "Save this page" or the shortcut |

**Shortcuts**: "Save this page" defaults to `Alt+S`. "Save selected text" (which opens the page picker) has no default, to avoid clashing with other programs. Both can be changed at `chrome://extensions/shortcuts`.

**When you open a post from a feed**: Threads has not yet put the post's full thread data into the page, so when you press save the extension **reloads the page once automatically**, waits for the post to load, then saves. The effect is the same as pressing F5 yourself.

**Adding selected text to an existing page**: useful for adding context, for example highlighting readers' comments together with the plurk owner's responses on Plurk and adding them to that plurk's Notion page. The text is separated by a divider and appended to the end of the page; only the text you selected is added, and existing content and notes are untouched. The page picker (opening under the extension icon) lists this post's page and recently used pages, and you can search by title, but only within the current database. The picker is the extension's own screen, not part of the web page, so the website you are viewing cannot read your Notion page titles or press an option for you; the notice on the page only says "Add to this post's Notion page" and never shows the page title. Text already on that page is not added twice; if you deleted the added text in Notion and want to add it again, press "Sync Notion" once first.

**Duplicate saves**: an article you already saved shows "Already saved"; no second page is created and the original page is not changed.

**Updating a saved page**: when the article changes (a news update, a blog revision, more posts added to a thread), open it and press "Update Notion page". The extension re-reads the page and replaces the **original text** in the Notion page with the latest, updating the title, author and other columns too.

- Notes you wrote **above or below** the original text, and text added with "Add to this post's Notion page", stay where they are.
- Words you edited inside the original paragraphs, or content inserted between them, are replaced along with the original; write notes above or below it.
- "Saved" time does not change.

**Missing thread parts**: if a `1/N` thread was not fully loaded when saved, "Recent saves" shows "Thread may be incomplete" and lists it under "Threads to complete". Later, open it and press "Save this page" once more: the extension **appends only the missing parts to the end of the original page**, and existing content and your notes are untouched. Once complete, the notice disappears.

## Notion pages and columns

Page content starts with the original: web articles keep their paragraphs, headings and image positions; for posts, the main post, each thread part and the author's follow-ups are separated by dividers, the `1/N` number goes on the last line of each part, and images follow the text they belong to.

A newly saved page gets the source site's icon as its Notion page icon, so you can see at a glance where it came from. Updating an existing page does not change its icon.

The database has 10 columns. Web, Threads, Plurk, X, Instagram, YouTube, LinkedIn and Facebook all go in one database, told apart by the "Source" column. You can rename columns but please do not delete them or change their type; a deleted column is added back the next time the extension connects. "Capture key", "Post ID" and "Original range" are internal columns, hidden in table views automatically when a database is first created or connected; if you want to see them, turn them on in the Notion view's "Properties" menu, and the extension will not hide them again.

| Column (English database) | Description |
|---|---|
| Name | The article title for web articles; for posts, the beginning of the text, up to 30 characters |
| Source | Web, Threads, Plurk, X, Instagram, YouTube, LinkedIn or Facebook |
| Source URL, Author, Published | Information about the original (the site name when a web page gives no author) |
| Saved | When you saved it |
| Threads topic | The topic tag the author chose |
| Capture key, Post ID | Used to decide "already saved" (a plurk's Post ID is the last part of the address, for X the number after status, for Instagram the code after /p/; web pages have no Post ID). Hidden by default; please do not delete |
| Original range | Records which part of the page is the saved original; "Update Notion page" replaces only this part. Hidden by default; please do not delete or edit |

**Hiding internal columns when you open a page too**: Notion does not let the extension set property visibility inside pages, so you need to set it once yourself; it then applies to every page in the database:

1. Open any saved page and click the column name to the left of "Capture key" in the properties area at the top.
2. Choose "Property visibility" → "Always hide".
3. Do the same for "Post ID" and "Original range".

Once hidden, an "N hidden properties" line appears under the properties area; click it to see them whenever needed.

## Recent saves and sync

- **Sync Notion**: re-reads the whole database so the local records match Notion. After deleting an article directly in Notion, press Sync once to save it again.
- **Clear**: empties only the recent list shown in the extension; Notion is not affected and articles do not become "never saved".
- **Retry failed**: when the network or Notion has a temporary error, failed articles are kept and you can retry them manually.
- **Export list**: exports JSON so you can check saved, pending and failed items.

## Known limits

- Only content already loaded on the page and that you are allowed to view can be saved. For articles that need login or payment, save while logged in and with the article displayed.
- Chrome's built-in pages, the Chrome Web Store and PDF files cannot be saved.
- Web layouts vary endlessly: on a few sites the extension may pick up extra paragraphs (for example an app-download notice at the end) or miss some content; when that happens, save highlighted text instead.
- X has an old and a new page layout and the extension handles both; an X redesign may affect recognition, and when it cannot read a post it cancels the save instead of saving something wrong.
- When an Instagram redesign makes the page data unreadable, the extension saves the caption and first image from the page summary instead, and "Recent saves" shows "Text may be missing".
- Videos are not downloaded, only images. Images take up Notion workspace space; an image over 20 MB or one that cannot finish downloading in 30 seconds is skipped, the text is still saved, and "Recent saves" shows "Images incomplete".
- Shortened URLs inside the long-text attachment window cannot currently be restored to full links; full URLs written out in the long text can.
- The publish time is read only as the exact time shown on the page, never inferred from text such as "3 days ago"; it is left empty when unavailable.
- A Threads redesign may affect recognition of text, images, thread numbering or the extent of a quote. When the extension cannot read something, it leaves it empty, shows a notice in "Recent saves", or cancels the save; it does not guess. In that case, save highlighted text for now.

## Third-party code

- [Mozilla Readability](https://github.com/mozilla/readability) 0.6.0 (Apache License 2.0), in `vendor/readability/`, used to find the body text of web articles.

## Privacy and security

- Data flow and permissions: [PRIVACY.en.md](PRIVACY.en.md)
- How the token is stored and how to report issues: [SECURITY.en.md](SECURITY.en.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md) (Traditional Chinese)

## Development

Requires Node.js 18 or later.

```bash
npm install
npm test
npm run check
```
`npm run lint` checks all code with ESLint; `npm run typecheck` checks JSDoc types with TypeScript (configured in `jsconfig.json`, check only, no output).

### Project structure

```
manifest.json        Extension configuration
background.js        Background service: builds shared services, handles events and messages
background/          Parts of the background service (tabs, database, saving from the current tab, page picker, state and sync, Plurk Paste)
content/             Per-site content code: Threads, X, Instagram, Plurk, YouTube, LinkedIn, Facebook, generic web pages (with content.css and notices)
pages/               The extension's own pages: popup/, options/, picker/, and the shared colour tokens tokens.css
model/               Turns data sent from the page into trusted capture data, with validation
notion/              Notion column definitions, page content building, API requests and read/write flows
queue/               Save queue and retries
storage/             Settings, local state and image staging before saving
lib/                 Shared pure functions (text cleaning, URL parsing, dedupe keys)
i18n/                Interface language: index.js does the translating, en.js is the English dictionary
_locales/            Name and description shown in the store (English, Traditional Chinese)
vendor/              Third-party code (Mozilla Readability)
icons/               Icons: 16 and 32 px are generated by scripts/build-icons.js (npm run icons); 48 and 128 px are hand-drawn
scripts/             Scripts for the toolbar icons and the store package
store/               Chrome Web Store listing text
tests/               Tests and test page fixtures
types.d.ts           Type declarations for data shapes (for editors and checks only)
```
