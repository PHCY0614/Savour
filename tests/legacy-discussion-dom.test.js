"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLegacyDiscussionDom
} = require("../content/legacy-discussion-dom.js");

test("legacy discussion DOM 工廠隔離頁面解析介面", () => {
  const api = createLegacyDiscussionDom({
    shared: {},
    scope: {},
    extract: {},
    profileInfoSelector: ".profile"
  });

  for (const name of [
    "compareDocumentNodes",
    "discussionEntryFromCapture",
    "extractDiscussionBodyAnchor",
    "extractLooseDiscussionEntry",
    "findDiscussionPermalinkByPostId",
    "findLooseDiscussionCard",
    "putDiscussionEntry"
  ]) {
    assert.equal(typeof api[name], "function", `${name} 應為函式`);
  }
});
