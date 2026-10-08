"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { installDom } = require("./helpers/dom-env");
const { showToast } = require("../content/toast.js");

test("toast 會保留原本的文字、tone 與自動顯示行為", async () => {
  const env = installDom("<!doctype html><html><body></body></html>");
  try {
    showToast("保存完成", "error");
    const toast = document.querySelector(".savour-toast");
    assert.equal(toast?.textContent, "保存完成");
    assert.equal(toast?.classList.contains("is-error"), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(toast?.classList.contains("is-visible"), true);
  } finally {
    env.restore();
  }
});

test("新的 toast 會取代畫面上的舊 toast", () => {
  const env = installDom("<!doctype html><html><body></body></html>");
  try {
    showToast("第一則");
    showToast("第二則");
    const toasts = [...document.querySelectorAll(".savour-toast")];
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].textContent, "第二則");
  } finally {
    env.restore();
  }
});
