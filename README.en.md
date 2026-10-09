# Savour

[正體中文](README.md)

**Save now. Savour later.**

> We keep collecting, but never get around to reading.

Content ends up scattered across bookmarks, likes and screenshots. When we finally have time to read, we find ourselves searching for it all over again. Savour was made to help save it: one click puts something that interests you into your own Notion database, keeping it together and easy to manage, ready to digest when you have time.

## Supported sources

| Source | Saved content |
|---|---|
| Web articles | Article text, available images and formatting |
| Social media posts | Post content, available images and source information |
| YouTube | Video embeds, description information and chapters |

Currently supported social media platforms include Threads, Plurk, X, Instagram, Facebook and LinkedIn.

You can also save just a highlighted passage, or add it to an existing Notion page.

## How saving works

- Content is read only when you choose to save it. Data goes directly from Chrome to your own Notion, with no server in between.
- For social media posts, open the individual post page before saving.
- Savour checks whether content has already been saved to avoid creating duplicate pages.
- What gets saved depends on the website and the content loaded at the time. Details such as the author and publish date are filled in where available. Comments and reaction counts are not collected automatically, and video files are not downloaded.

## Installation

Requires Chrome 102 or later and a Notion account.

Savour is coming soon to the Chrome Web Store. To try it now, load it manually:

1. Download or clone this repository and keep it somewhere it will not be deleted; if the folder is removed, the extension disappears too.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the folder that contains `manifest.json`.
3. Pin Savour to the Chrome toolbar for easy access.

A manually loaded copy does not update itself. To update, download the new version and reload the extension.

## First-time setup

### 1. Connect to Notion

1. Go to [Notion Integrations](https://www.notion.so/profile/integrations), create an Internal Integration, and enable **Read content**, **Insert content** and **Update content**.
2. Copy the Integration Token.
3. Open Savour's settings, paste the token under **Notion connection**, and click **Save settings**. You can also click **Test Notion access** to check the connection.

Do not share your token in chats or public places. By default, it is kept only until Chrome closes completely. Selecting **Remember the token on this computer** saves you from entering it again next time; use this option only on your own computer.

### 2. Choose a database

**Use an existing database**

Open the database in Notion and add your Integration through **⋯** → **Connections** in the top-right corner. Return to Savour's settings, click **Load available databases**, select the database, and click **Use this database**.

An empty database works too. Savour adds the columns needed for saving. If your database is missing from the list, expand **Advanced: paste a database URL** to enter its URL manually.

**Create a new database**

Create an empty page in Notion and add your Integration. Paste the page URL under **Create a new database**, then click **Create Notion database**.

The default name is **留己看**, or **For Later Me** in the English interface.

You can switch databases later. Switching rebuilds the local saved-content records without deleting or changing content in either database. If items are still waiting to be saved, let them finish first.

### 3. Choose your interface language

The interface supports Traditional Chinese and English. It follows your browser language by default, or you can switch using **中／EN** in the top-right corner of the settings page.

A new database's column names follow the interface language at the time it is created. Changing the language later does not rename existing columns, and you can rename them yourself.

## Usage

| What you want to do | How |
|---|---|
| Save the current page | Click **Save this page**, press `Alt+S`, or use the right-click menu |
| Update saved content | Open the original page, click **Update Notion page**, and confirm |
| Save a passage | Highlight text and choose **Save as a new page** from the right-click menu or the extension |
| Add text to an existing page | Highlight text and choose **Add to this post's Notion page** or **Add to another page…** |

Updating a Notion page replaces only the saved original content, preserving your notes above and below it and any highlighted passages you have added. If a thread has missing sections, you can save it again to fill them in.

Highlighted text added to an existing page is appended at the end, separated by a divider. It does not replace the existing content.

The default shortcut for saving the current page is `Alt+S`. You can assign a shortcut for saving selected text. Both can be adjusted at `chrome://extensions/shortcuts`.

## Notion pages and columns

All sources are saved in one database and distinguished by the **Source** column. Pages contain the original content, while database columns record details such as the name, source URL, author, publish date and save date. New pages also use the source website's icon.

You can rename columns, but keep the columns and their original types. **Capture key**, **Post ID** and **Original range** are used to identify saved content and locate the content to update. Do not delete them or change their values.

These internal columns are hidden in database views during initial setup. To hide them on individual pages as well, set their **Property visibility** to **Always hide** in Notion.

## Saved records and synchronisation

The extension shows recent save results and warnings about potentially incomplete content or images. You can manually retry failed items or export a list to check them.

**Sync Notion** reads the database again and updates the local saved-content records. For example, after deleting an article in Notion, sync before saving it again.

Clearing recent records only clears the list shown in the extension. It does not delete Notion content or reset whether an item has already been saved.

## Known limitations

- Only content you are authorised to view and that has loaded on the page can be saved. Savour does not bypass sign-in requirements, paywalls or access restrictions. Content from friends-only posts, private accounts or paid sources becomes your private copy in Notion, so do not share it, and respect the original creator and any restrictions on using it.
- Website layouts and updates can affect content recognition. Saved content may not reproduce the original page in full. If something is missing, try saving the relevant highlighted text.
- Videos are represented by embeds, links or cover images; video files are not downloaded. YouTube subtitles and transcripts are not currently saved.
- Saved images use space in your Notion workspace. Images that are unavailable, exceed size limits or take too long to download may be skipped. Check the save result.
- Chrome's internal pages, the Chrome Web Store and PDF files cannot be saved.

## Privacy and security

Savour has no analytics tracking. Content is saved directly from your browser to the Notion database you choose.

- [Privacy policy and permissions](PRIVACY.en.md)
- [Token storage and reporting security issues](SECURITY.en.md)
- [Changelog](CHANGELOG.md) (Traditional Chinese)

## Development

Requires Node.js 18 or later.

```bash
npm install
npm test
npm run check
```

You can also run `npm run lint` to check the code, or `npm run typecheck` to check types.

Web article extraction uses [Mozilla Readability](https://github.com/mozilla/readability), licensed under Apache License 2.0.
