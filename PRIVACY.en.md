# Privacy Policy

[正體中文](PRIVACY.md)

Savour ("the extension") reads the web article, YouTube video, or Threads, Plurk, X, Instagram, Facebook or LinkedIn post you are viewing **only when you choose to save it**, and writes it into **your own** Notion workspace. The extension has no server of its own.

## What is read

Only when you press "Save current page", the keyboard shortcut or the right-click menu, the extension reads the following from that one page or post:

- The body text, long-text attachments, `1/N` thread parts and the author's own follow-ups
- Post images
- Links in the text and the addresses of link preview cards
- The author's account name, publish time, Threads topic and post address
- Plurk: the plurk's text, images, links, an attached Plurk Paste, and the author's own follow-ups in the replies
- X: the post's text, images, links, the address of a quoted post, and the author's own thread directly below it
- Instagram: the post caption, author, publish time and images (for videos, only the cover image)
- YouTube: the video's title, channel, publish date, length and description (read from the video data built into the page; when needed, the video's YouTube page is read again, the same as reloading it yourself)
- Facebook: on a single-post page, the text, images, link previews, author name and, where the page provides it, the publish time
- LinkedIn: on a single-post page, the text, images, links, author name and publish time (derived from the post ID), and for a repost, the original post's author, summary and address
- Web articles: the body text, images and links in the article, and the title, site name, author, publish time and summary that the page provides
- Text you highlight and choose to save

Not read: passwords, private messages, your follow lists, your browsing history, or any post you did not save. Readers' comments are not saved.

## Where data goes

- **Only to your Notion**: the content above is sent by your Chrome directly to `api.notion.com` and written into the database you chose.
- **Images**: images from Threads, Plurk, X, Instagram and Facebook are read by the current tab (the site's own page) when you save, kept temporarily in your Chrome, and then uploaded to your Notion, so the extension needs no access permission for those image sites. An image the tab could not read is downloaded once more, **without any login information**, when it is written to Notion. For web articles, YouTube and LinkedIn, only the public image address is given to your Notion, and Notion's servers download the image into your workspace; an image Notion cannot fetch is kept as a link to the original address.
- **Page icon**: a new page's icon is set to the source site's icon, using an address on Google's site icon service (`www.google.com/s2/favicons`, containing only the site's domain). Notion's servers fetch it; your Chrome does not connect to Google. No icon is set when the source is a local or private-network address.
- **Nowhere else**: no intermediary server, no analytics or tracking service, no advertising, and data is never sold or shared with anyone.

A Plurk Paste attached to a plurk is first read as a public page **without any login information**. Only if it requires login is it opened in a background tab, read with your own login session and closed immediately, the same as opening that Paste yourself.

When you choose which Notion page to add text to, the list is shown in the extension's own window; the website you are viewing cannot read those page titles. Images pointing to your computer or local network are not imported and leave no link.

The extension does not re-download web pages in the background, with one exception, YouTube: after you switch to another video within the site, the page's video data still belongs to the previous video, so the current video's YouTube page is read again. When you open a post from the Threads feed, the tab you are viewing is reloaded once before saving, the same as pressing F5 yourself.

The extension does not normally run code on any website (including Threads, Plurk and Instagram). Only at the moment you press save, use the right-click menu or the shortcut does it place its capture code into **the current tab** to read the content. The only resident code is a small script on Plurk Paste pages (`paste.plurk.com/show/…`): it returns the text only when the extension opened that Paste to read a plurk's long text, and does nothing otherwise.

## Data stored on your computer

The following is kept in Chrome's extension storage, only on your computer, and is never uploaded anywhere:

- **Notion Integration Token**: by default kept only until Chrome fully closes; kept long-term only if you tick "Remember the token on this computer". Chrome's local storage is not an encrypted vault, so tick it only on your own computer.
- **Settings**: the chosen Notion database, interface language, and the IDs and names of the database's columns (so columns are still found after you rename them).
- **Saved records**: which articles and posts have been saved (address, title, Notion page link), and notes such as "thread may be incomplete" or "text may be missing", used to avoid saving twice, to add missing thread parts and for "Update Notion page".
- **Save queue**: posts not yet written to Notion, or that failed and are waiting to retry.
- **Staged images**: images read from the page when saving that are not yet uploaded to Notion; deleted after upload, and unused ones are removed automatically after one day.

## Permissions

| Permission | Why it is needed |
|---|---|
| `activeTab` | When you press save, use the right-click menu or the shortcut, grants temporary access to the current tab only, to save web articles and Threads, Plurk, Instagram, X and other posts |
| `scripting` | Together with `activeTab`, places the capture code into the current tab, and reads that page's images inside the tab, only at the moment you save |
| `contextMenus` | Provides the right-click menu items "Save current page to Notion" and "Save selected text to Notion" (as a new page or added to an existing page in the database) |
| `storage` | Keeps the settings, token and saved records listed above |
| `unlimitedStorage` | Saved records grow as you save more; with long-term use they may exceed Chrome's default 10 MB limit, and losing them would cause duplicate saves |
| `alarms` | Retries writing to Notion later when the network fails temporarily |
| `api.notion.com` | Writes posts into your Notion |
| `paste.plurk.com` | Reads the Plurk Paste long text attached to a plurk you save |

## Private accounts and paid content

If you save posts from a non-public account you are allowed to view, or articles that require login or payment, that content and its images also become a copy in your Notion. Save only content you are allowed to view and that is suitable for personal use, and do not republish it.

## Stop using

1. Revoke or delete the integration at [Notion Integrations](https://www.notion.so/profile/integrations); the extension can then no longer write to your Notion.
2. Remove the extension at `chrome://extensions`; Chrome deletes all of its data on your computer.

Pages already saved in Notion belong to you and do not disappear when the extension is removed.

## Data use commitments

The extension's use of user data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements:

1. Data is used only to provide the extension's single purpose: writing content you choose to save into your own Notion.
2. User data is not sold.
3. User data is not used or transferred for purposes unrelated to that single purpose.
4. User data is not used or transferred to determine creditworthiness or for lending purposes.
5. The developer has no access to your data: it never passes through a developer server, and the developer does not have your Notion token.

## Changes to this policy

If this policy changes, this page is updated along with the "Last updated" date below; changes affecting how data is used are also noted in the extension's release notes.

Last updated: 2026-10-08

## Contact

For any privacy question, email phcy0614@gmail.com or use the developer contact on the Chrome Web Store listing.
