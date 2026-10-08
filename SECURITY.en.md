# Security

[正體中文](SECURITY.md)

## How the Notion token is stored

- The token is typed in by you on the settings page. It never appears on web pages, in source code or in any log.
- **By default** it is kept only in Chrome's session storage and is cleared when Chrome fully closes.
- Only if you tick "Remember the token on this computer" is it kept in Chrome's local storage. This is not an encrypted vault: anyone who can use your computer account could in theory read it, so tick it only on your own computer.
- The storage is open only to the extension's own background code and pages. Scripts on websites, including the capture code the extension places into a tab, cannot read the token.
- The token is sent only to `api.notion.com`.

## What it can change in your Notion

The extension can only reach the pages and databases **you have explicitly shared with the Integration** in Notion. It will:

- Add pages to the database you chose, and set each page's icon to the source site's icon.
- When connecting or creating a database, add any missing columns; on first connection, hide the three internal columns (Capture key, Post ID, Original range) in table, list and gallery views. It never deletes or renames a column.
- When a thread has missing parts, **append** the missing parts after the original text of the existing page, without touching anything else.
- When you add selected text to a page, append it to the end of that page, separated by a divider.
- When you press "Update Notion page", delete the blocks the page records as the original text, replace them with the latest content, and update the title, author and other columns. Notes you wrote above or below the original text are not affected. If the position of the original text cannot be found, nothing is deleted and the new content is placed at the top.

Apart from "Update Notion page", it never clears, overwrites or deletes the content of an existing page. The one other exception is a page the extension itself just created but failed halfway through writing: a retry writes its full content again.

## Least privilege

- It reads the current tab only when you press save. While you browse any website, it does nothing in the background.
- It does not re-download Threads pages in the background, and never uses your Threads login to reach other content.
- For Plurk Paste, it accepts only addresses like `paste.plurk.com/show/…`, reads them first without any login information, opens a tab only if that fails, and closes it right after reading.
- The background code accepts commands only from the extension's own pages. The code placed into website tabs can only ask to read a Plurk Paste; it cannot save, update or delete anything, and cannot read your Notion page titles.
- What each permission is used for is listed in [PRIVACY.en.md](PRIVACY.en.md).

## If you suspect the token has leaked

1. Go to [Notion Integrations](https://www.notion.so/profile/integrations) and refresh the token, or delete the Integration.
2. Paste the new token on the extension's settings page.

## Reporting a security issue

If you find a vulnerability, please **do not** post the details publicly. Report it privately through the developer contact on the Chrome Web Store listing. Please include, where possible:

- Steps to reproduce
- The affected version (shown on `chrome://extensions`)
- The possible impact

Once confirmed, we will fix it as soon as possible and note it in [CHANGELOG.md](CHANGELOG.md) (written in Traditional Chinese).
