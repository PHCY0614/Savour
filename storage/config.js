/**
 * Settings in chrome.storage.local, and the Notion token (session storage unless the user chose
 * to remember it). `getPublicConfig` is what pages may see; the token itself stays in the worker.
 */
(function attachSavourStorageConfig(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourStorageConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStorageConfigModule() {
  "use strict";

  const CONFIG_KEY = "savourConfig";
  const TOKEN_KEY = "notionToken";
  const DEFAULT_CONFIG = Object.freeze({
    archiveName: "留己看",
    parentPageUrl: "",
    targetHandle: "",
    archiveTarget: "",
    dataSourceId: "",
    databaseId: "",
    databaseUrl: "",
    rememberToken: false,
    // Interface language: "auto" follows the browser, or "zh" / "en".
    uiLanguage: "auto",
    // Data source whose views already had the internal columns hidden (see background.js).
    internalColumnsHiddenFor: "",
    // Which Notion column holds what in the archive (notion/schema.js); set by background/archive.js.
    columnMap: null
  });

  /**
   * @typedef {object} ConfigStorageOptions
   * @property {typeof chrome} chromeApi
   * @property {typeof import("../lib/shared.js")} shared
   * @property {(target: string, token: string) => Promise<{ dataSourceId: string, databaseId: string, databaseUrl: string }>} resolveArchiveTarget
   * @property {(current: string, next: string) => Promise<void>} [assertDataSourceChangeAllowed] throw to block a database switch
   * @property {(previous: string, next: string) => Promise<void>} [onDataSourceChanged] clears local saved state after a switch
   */

  /**
   * @param {ConfigStorageOptions} options
   */
  function createConfigStorage(options) {
    /**
     * @param {string} text
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    const t = (text, params) => (shared.t ? shared.t(text, params) : String(text).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match)));
    const {
      chromeApi,
      shared,
      resolveArchiveTarget,
      assertDataSourceChangeAllowed = async () => {},
      onDataSourceChanged = async () => {}
    } = options;

    /**
     * Stored settings over the defaults.
     * @returns {Promise<import("../types").Config>}
     */
    async function readConfig() {
      const result = await chromeApi.storage.local.get(CONFIG_KEY);
      /** @type {import("../types").Config} */
      const config = { ...DEFAULT_CONFIG, .../** @type {Partial<import("../types").Config>} */ (result[CONFIG_KEY] ?? {}) };
      return config;
    }

    /**
     * The Notion token from session storage, else local storage, else "".
     * @returns {Promise<string>}
     */
    async function readToken() {
      const [session, local] = await Promise.all([
        chromeApi.storage.session.get(TOKEN_KEY),
        chromeApi.storage.local.get(TOKEN_KEY)
      ]);
      return /** @type {string} */ (session[TOKEN_KEY] || local[TOKEN_KEY] || "");
    }

    /**
     * Settings plus `hasToken`. Safe to send to a page.
     * @returns {Promise<import("../types").PublicConfig>}
     */
    async function getPublicConfig() {
      const config = await readConfig();
      return { ...config, hasToken: Boolean(await readToken()) };
    }

    /**
     * Validates and stores settings. A changed archive target is resolved to a data source (needs a token); when the data source changes, `assertDataSourceChangeAllowed` runs first and `onDataSourceChanged` after. The token goes to session storage, or to local storage when `rememberToken` is set.
     * @param {Partial<import("../types").Config> & { token?: string }} settings
     * @returns {Promise<import("../types").PublicConfig & { dataSourceChanged: boolean }>}
     */
    async function saveSettings(settings) {
      const current = await readConfig();
      const currentArchiveTarget = String(current.archiveTarget || current.databaseUrl || current.dataSourceId || "").trim();
      const hasArchiveTargetSetting = Object.prototype.hasOwnProperty.call(settings, "archiveTarget");
      const archiveTarget = hasArchiveTargetSetting
        ? String(settings.archiveTarget ?? "").trim()
        : currentArchiveTarget;
      let next = {
        ...current,
        archiveName: shared.cleanText(settings.archiveName ?? current.archiveName) || DEFAULT_CONFIG.archiveName,
        parentPageUrl: String(settings.parentPageUrl ?? current.parentPageUrl).trim(),
        targetHandle: shared.cleanHandle(settings.targetHandle ?? current.targetHandle),
        archiveTarget,
        rememberToken: Boolean(settings.rememberToken),
        uiLanguage: settings.uiLanguage && ["auto", "zh", "en"].includes(settings.uiLanguage) ? settings.uiLanguage : current.uiLanguage || "auto"
      };

      const suppliedToken = String(settings.token ?? "").trim();
      const existingToken = suppliedToken || await readToken();
      const archiveTargetChanged = archiveTarget !== currentArchiveTarget;

      if (!archiveTarget) {
        next = { ...next, dataSourceId: "", databaseId: "", databaseUrl: "" };
      } else if (archiveTargetChanged || !next.dataSourceId) {
        if (existingToken) {
          next = { ...next, ...(await resolveArchiveTarget(archiveTarget, existingToken)) };
        } else {
          next = { ...next, dataSourceId: "", databaseId: "", databaseUrl: "" };
        }
      }

      const dataSourceChanged = next.dataSourceId !== current.dataSourceId;
      if (dataSourceChanged) await assertDataSourceChangeAllowed(current.dataSourceId, next.dataSourceId);
      await chromeApi.storage.local.set({ [CONFIG_KEY]: next });
      if (dataSourceChanged) await onDataSourceChanged(current.dataSourceId, next.dataSourceId);

      if (next.rememberToken) {
        if (existingToken) await chromeApi.storage.local.set({ [TOKEN_KEY]: existingToken });
        await chromeApi.storage.session.remove(TOKEN_KEY);
      } else {
        if (existingToken) await chromeApi.storage.session.set({ [TOKEN_KEY]: existingToken });
        await chromeApi.storage.local.remove(TOKEN_KEY);
      }
      return { ...next, hasToken: Boolean(existingToken), dataSourceChanged };
    }

    /**
     * @returns {Promise<string>} the token; throws a user-readable error when none is set
     */
    async function requireToken() {
      const token = await readToken();
      if (!token) throw new Error(t("尚未設定 Notion Token"));
      return token;
    }

    return {
      getPublicConfig,
      readConfig,
      readToken,
      requireToken,
      saveSettings
    };
  }

  return { CONFIG_KEY, TOKEN_KEY, DEFAULT_CONFIG, createConfigStorage };
});
