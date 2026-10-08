"use strict";

const { JSDOM } = require("jsdom");

const DOM_GLOBALS = [
  "window",
  "document",
  "location",
  "navigator",
  "Element",
  "Node",
  "Document",
  "HTMLElement",
  "HTMLImageElement",
  "MutationObserver",
  "KeyboardEvent"
];

function createChromeStub() {
  const listeners = [];
  return {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      },
      sendMessage: async () => ({ ok: true })
    },
    __listeners: listeners
  };
}

function installDom(html, options = {}) {
  const url = options.url || "https://www.threads.com/@sample/post/root001";
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const previous = new Map();

  for (const name of DOM_GLOBALS) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: dom.window[name]
    });
  }
  for (const [name, value] of [
    ["requestAnimationFrame", callback => setTimeout(callback, 0)],
    ["cancelAnimationFrame", clearTimeout],
    ["chrome", options.chrome || createChromeStub()]
  ]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  if (!Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "innerText")) {
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent;
      },
      set(value) {
        this.textContent = value;
      }
    });
  }
  dom.window.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 640, height: 40, top: 0, left: 0, right: 640, bottom: 40 }];
  };
  dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const width = Number(this.getAttribute?.("width")) || 640;
    const height = Number(this.getAttribute?.("height")) || 40;
    return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 };
  };

  return {
    dom,
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (!descriptor) delete globalThis[name];
        else Object.defineProperty(globalThis, name, descriptor);
      }
    }
  };
}

module.exports = { createChromeStub, installDom };
