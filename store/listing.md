# Chrome 線上應用程式商店上架文案（正式版）

貼到商店後台的文字，內容以此為準。程式裡實際使用的簡短說明在 `_locales/*/messages.json`，兩邊要保持一致。

## English

**簡短說明 / Summary**

Save now. Savour later. One click saves it to your own Notion, to digest when you have time.

**完整說明 / Description**

Too much to read now. Too good to lose.

What we find online ends up scattered across websites, bookmarks, likes and screenshots. By the time we have a moment to read, we're stuck hunting for it all over again.

Savour was built to handle the saving and the organising.

With one click, what you're viewing is saved into your own Notion database, with the author, source, publish date and save date filled in automatically. Everything sits in one place, searchable and filterable. Read when you have time, and digest the information at your own pace.

What you can save

Web articles: headings, links, lists, tables and images stay in place
Social media posts, discussions, and video pages
Just a highlighted passage, or add it to an existing page
Save from the toolbar button, the right-click menu or Alt+S

Made for "reading later"

If the original is deleted or edited, you still have a copy in your Notion
If the content changes, press Update to replace it with the latest version; the notes you wrote stay

In your language

The interface is in English or Traditional Chinese
A new database gets its column names in your interface language, and you can rename the columns as you like

Your database belongs to you

Works only when you click save
Content goes straight from your browser to your own Notion, with no server in between and no tracking
Requires a Notion account; the settings page walks you through connecting it once

Savour is an independent open-source tool, not affiliated with or endorsed by Notion or any supported third-party platforms. All trademarks belong to their respective owners.

## 正體中文

**簡短說明**

先存再說、之後要讀卻找不到？按一下存進自己的 Notion，有空再慢慢消化資訊。

**完整說明**

收藏從未停止，行動從未開始。

網路上看到的資訊常常四散在各個網站、書籤、按讚或截圖裡，等到有空想閱讀資訊時，又要先大海撈針找資訊。

因此做了 Savour，負責保存、整理。

點一下，就把正在看的內容存進自己的 Notion 資料庫，作者、來源、發布時間、保存時間自動填好，全部放在同一個地方，可以搜尋、篩選。等有空再讀，慢慢消化資訊。

可以保存

網頁文章：標題、連結、清單、表格、圖片都留在原位
社群動態、討論串與影片頁面
只保存反白的一段文字，或將它加到現有頁面
按工具列按鈕、右鍵選單或 Alt+S 都能保存

為了「之後再讀」

原文被刪或被改，你的 Notion 裡還有一份
內容更新了，按「更新」就換成最新版，你寫的筆記會保留

中英文都能用

介面有正體中文與英文
新建的資料庫欄位名稱跟著介面語言，欄位也可以自己改名

資料庫只屬於你

只在你按下保存時運作
內容由你的瀏覽器直接送到你自己的 Notion，沒有中間伺服器，也沒有追蹤
需要 Notion 帳號；第一次使用時，設定頁有教學帶你完成連線

Savour 是獨立的開源工具，與 Notion 或任何支援之第三方平台沒有關聯，各名稱與商標屬於其所有人。

## Developer Dashboard 欄位（英文，貼到後台）

以下欄位只給審核人員看，不會公開顯示。權限理由與 `PRIVACY.en.md` 的 Permissions 表保持一致。

### Category

Productivity › Workflow & Planning

### Single purpose

Saves the web page or social media post the user is viewing into the user's own Notion database.

### Permission justification

- `activeTab`: Grants temporary access to the current tab only when the user presses Save, uses the right-click menu or the shortcut, so the extension can read the page being saved.
- `scripting`: Injects the capture script into the current tab at the moment of saving, and reads that page's images inside the tab. Nothing is injected at any other time.
- `contextMenus`: Adds the right-click items "Save current page to Notion" and "Save selected text to Notion".
- `storage`: Keeps the user's settings (chosen Notion database, language, column IDs), the Notion token, and records of what has been saved (to avoid saving twice).
- `unlimitedStorage`: The saved-records list and staged images (images read from the page, waiting to be uploaded to Notion) grow with long-term use and may pass the default 10 MB quota. Losing the records would cause duplicate saves.
- `alarms`: Retries writing to Notion later when the network fails temporarily.
- Host permission `https://api.notion.com/*`: Writes the saved content directly to the user's Notion workspace through the Notion API.
- Host permission `https://paste.plurk.com/*`: Reads the long-form Plurk Paste attached to a plurk the user saves.

### Remote code

No. All code is bundled in the package; no remote scripts are loaded or evaluated.

### Data usage (privacy practices tab)

Check:
- Authentication information: the Notion Integration Token, kept in the browser's extension storage on the user's computer and sent only to api.notion.com.
- Website content: the text, images, links and author of the page or post the user chooses to save.
- Web history: the address and title of pages the user has saved, kept locally to avoid duplicate saves. The extension does not read the user's browsing history.

Certify all three: data is not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending.

Privacy policy URL: https://github.com/PHCY0614/Savour/blob/main/PRIVACY.en.md

### Instructions for the reviewer

Notion token: provided in the password field of the account credential

Blank parent page: [url]

Two empty test databases have already been created.

1. Right-click the icon > Options.
2. Paste the token, press Save settings.
3. Load available databases, select the test database, Use this database.
4. Open any public article, press Save this page (or Alt+S).
5. Check the test database in Notion for the new page.

<!-- 後台限 500 字元。Token 填在後台「測試帳號」的密碼欄，不寫在這段文字裡；[url] 換成測試用空白頁面的網址，只填在後台，不要提交到 repo。 -->


## 截圖與宣傳圖

- 截圖：`store/screenshots/zh-TW` 與 `store/screenshots/en`，各 4 張，1280x800。介面有變動時執行 `npm run screenshots` 重拍；工具在 `scripts/store-screenshots/`，用真正的 popup 與設定頁配上示範資料拍攝，標語與示範內容也寫在那裡。
- 小型宣傳圖：`store/promo`，不由上面的指令產生。
