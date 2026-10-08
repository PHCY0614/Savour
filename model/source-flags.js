/**
 * Vocabulary for how complete a capture is (source type, completeness, relationship method) and
 * the reasons a page may be partial. Normalizers fall back to a safe default for unknown values.
 */
(function attachSavourSourceFlags(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SavourSourceFlags = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createSourceFlags() {
  "use strict";

  const SOURCE_TYPES = Object.freeze(["api", "page", "selection", "manual"]);
  const COMPLETENESS_VALUES = Object.freeze(["complete", "partial", "user-confirmed"]);
  const RELATIONSHIP_METHODS = Object.freeze(["api", "numbered-text", "page-inference", "manual"]);

  /** @type {any} */ const REVIEW_REASON_MAP = Object.freeze({
    "串文未完整": "thread-incomplete",
    "正文疑似遺漏": "body-missing",
    "圖片未完整": "media-incomplete"
  });

  function enumValue(/** @type {any} */ value, /** @type {any} */ allowed, /** @type {any} */ fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  /**
   * @param {unknown} value
   * @param {import("../types").SourceType} [fallback]
   * @returns {import("../types").SourceType}
   */
  function normalizeSourceType(value, fallback = "page") {
    return enumValue(value, SOURCE_TYPES, fallback);
  }

  /**
   * @param {unknown} value
   * @param {import("../types").Completeness} [fallback]
   * @returns {import("../types").Completeness}
   */
  function normalizeCompleteness(value, fallback = "partial") {
    return enumValue(value, COMPLETENESS_VALUES, fallback);
  }

  function normalizeRelationshipMethod(/** @type {any} */ value, fallback = "page-inference") {
    return enumValue(value, RELATIONSHIP_METHODS, fallback);
  }

  function reviewFlagsFromCapture(/** @type {any} */ raw) {
    return [raw, ...(raw?.continuations ?? []), ...(raw?.authorReplies ?? [])]
      .flatMap(entry => entry?.reviewFlags ?? []);
  }

  /**
   * Reasons a capture may be partial, from its own list plus its review flags. Partial with no reason gets a placeholder.
   * @param {any} raw
   * @param {import("../types").Completeness} [completeness]
   * @returns {string[]}
   */
  function incompleteReasonsFromCapture(raw, completeness = "partial") {
    const reasons = [
      ...(raw?.incompleteReasons ?? []),
      ...reviewFlagsFromCapture(raw).map(flag => REVIEW_REASON_MAP[flag]).filter(Boolean)
    ].map(String).map(value => value.trim()).filter(Boolean);
    if (completeness === "partial" && !reasons.length) reasons.push("page-completeness-unverified");
    return [...new Set(reasons)].slice(0, 50);
  }

  function derivePageCompleteness(/** @type {any} */ raw) {
    void raw;
    return "partial";
  }

  return {
    COMPLETENESS_VALUES,
    RELATIONSHIP_METHODS,
    REVIEW_REASON_MAP,
    SOURCE_TYPES,
    derivePageCompleteness,
    incompleteReasonsFromCapture,
    normalizeCompleteness,
    normalizeRelationshipMethod,
    normalizeSourceType
  };
});
