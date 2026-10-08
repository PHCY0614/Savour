"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDomExtract } = require("../content/dom-extract.js");

test("DOM extract 工廠只建立明確的抽取器介面", () => {
  const api = createDomExtract({
    shared: {},
    scope: {},
    semanticPostSelector: "article, [role='article']",
    longTextControlPattern: /read more/i,
    topicLabelPattern: /^topic:\s*(.+)$/i,
    avatarAltPattern: /avatar/i,
    profileInfoSelector: ".profile",
    profileTimelineSelector: ".timeline",
    captureValidationVersion: 2,
    getHelpers: () => ({})
  });

  for (const name of [
    "extractPost",
    "extractPostText",
    "extractPostMedia",
    "extractTopicTag",
    "extractThreadPosition",
    "extractHiddenLongTexts"
  ]) {
    assert.equal(typeof api[name], "function", `${name} 應為函式`);
  }
});
