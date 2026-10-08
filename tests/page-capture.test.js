"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPageCapture } = require("../content/page-capture.js");

test("page capture 工廠只建立使用者主動擷取介面", () => {
  const api = createPageCapture({
    shared: {},
    scope: {},
    extract: {},
    getHelpers: () => ({})
  });

  assert.deepEqual(Object.keys(api).sort(), [
    "captureCurrentThread",
    "captureSelection",
    "createManualCaptureGuard"
  ]);
});
