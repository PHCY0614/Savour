/**
 * Queue, saved-page index and recent list in chrome.storage.local, behind a lock so two writers
 * cannot overwrite each other.
 */
(function attachSavourStorageState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourStorageState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStorageStateModule() {
  "use strict";

  const STATE_KEY = "savourState";
  const DEFAULT_STATE = Object.freeze({
    queue: [],
    saved: {},
    recent: [],
    lastSyncedAt: "",
    // Selections added to existing pages ("pageId:textHash"), and pages recently picked as targets.
    selectionAppends: {},
    appendTargets: []
  });

  /**
   * @typedef {object} StateStorageOptions
   * @property {typeof chrome} chromeApi
   * @property {(state: import("../types").State) => import("../types").State} cloneState
   */

  /**
   * @param {StateStorageOptions} options
   */
  function createStateStorage(options) {
    const { chromeApi, cloneState } = options;
    /** @type {Promise<any>} */
    let stateMutex = Promise.resolve();

    /**
     * Runs `task` after every earlier locked task has finished. Wrap each read-modify-write of the state in this.
     * @template T
     * @param {() => Promise<T>} task
     * @returns {Promise<T>}
     */
    function withStateLock(task) {
      const result = stateMutex.then(task, task);
      stateMutex = result.catch(() => {});
      return result;
    }

    /**
     * Stored state over the defaults.
     * @returns {Promise<import("../types").State>}
     */
    async function readState() {
      const result = await chromeApi.storage.local.get(STATE_KEY);
      return { ...cloneState(DEFAULT_STATE), .../** @type {Partial<import("../types").State>} */ (result[STATE_KEY] ?? {}) };
    }

    /**
     * Replaces the stored state. Call inside `withStateLock` after `readState`.
     * @param {import("../types").State} state
     * @returns {Promise<void>}
     */
    async function writeState(state) {
      await chromeApi.storage.local.set({ [STATE_KEY]: state });
    }

    async function clearRecentItems() {
      return withStateLock(async () => {
        const state = await readState();
        const cleared = state.recent.length;
        state.recent = [];
        await writeState(state);
        return { cleared };
      });
    }

    return {
      clearRecentItems,
      readState,
      withStateLock,
      writeState
    };
  }

  return { STATE_KEY, DEFAULT_STATE, createStateStorage };
});
