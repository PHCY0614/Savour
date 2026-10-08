"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLegacyDiscussionData
} = require("../content/legacy-discussion-data.js");

test("legacy discussion data 工廠隔離結構化資料介面", () => {
  const api = createLegacyDiscussionData({
    shared: {},
    getHelpers: () => ({})
  });

  for (const name of [
    "collectCurrentThreadRelationshipEntries",
    "collectDiscussionEntriesFromJsonRoot",
    "collectDiscussionEntriesFromLivePageJson",
    "discussionEntryFromJsonThreadItem",
    "mergeStructuredRootEntry"
  ]) {
    assert.equal(typeof api[name], "function", `${name} 應為函式`);
  }
});
