/**
 * The small message bubble shown on a web page after a save. Styled by content.css.
 */
(function initializeSavourToast(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourToast = api;
})(globalThis, function createSavourToast() {
  "use strict";

  /**
   * Shows a short message at the bottom of the page for about three seconds, replacing any earlier one.
   * @param {unknown} message shown as text; "完成" when empty
   * @param {"normal" | "error"} [tone]
   */
  function showToast(message, tone = "normal") {
    document.querySelectorAll(".savour-toast").forEach(node => node.remove());
    const toast = document.createElement("div");
    toast.className = `savour-toast ${tone === "error" ? "is-error" : ""}`;
    toast.textContent = String(message || globalThis.SavourI18n?.t("完成") || "完成");
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    setTimeout(() => {
      toast.classList.remove("is-visible");
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  return { showToast };
});
