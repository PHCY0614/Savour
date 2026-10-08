"use strict";

const js = require("@eslint/js");
const globals = require("globals");

// Extension pages and content scripts are plain browser scripts that share globals through
// `globalThis.Savour*`; the modules also export through CommonJS so Node tests can load them.
module.exports = [
  { ignores: ["node_modules/**", "vendor/**", "coverage/**", "dist/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node, ...globals.serviceworker }
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      eqeqeq: ["warn", "always", { null: "ignore" }],
      "prefer-const": "warn"
    }
  },
  {
    // importScripts() in the service worker attaches these modules to the global scope.
    files: ["background.js"],
    languageOptions: {
      globals: Object.fromEntries(
        ["I18n", "Shared", "Notion", "NotionHttp", "NotionRepository", "StorageConfig", "DedupeKey", "AliasIndex",
          "BackgroundTabs", "BackgroundPlurkPaste", "BackgroundArchive", "BackgroundCaptureFlow", "BackgroundAppendPicker", "BackgroundStatusSync",
          "StorageState", "MediaStage", "SourceFlags", "CaptureModel", "QueueRetry"].map(name => [`Savour${name}`, "readonly"])
      )
    }
  },
  {
    // Regexes in tests spell out whitespace on purpose to match rendered text.
    files: ["tests/**"],
    rules: { "no-regex-spaces": "off" }
  }
];
