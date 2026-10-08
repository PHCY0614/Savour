/**
 * A small holding place for images between "the user pressed save" and "the post is written to Notion".
 *
 * A page's images can only be read from that page (the image sites allow their own site, not the extension),
 * so they are read when the user saves and kept here until the queue uploads them to Notion. They live in
 * IndexedDB of the extension, not in the saved queue, so large pictures never travel with every state write.
 *
 * It does not read or upload images and does not know which queue item an image belongs to.
 * Created by background.js; background/capture-flow.js puts images in, and background.js prunes the ones
 * the queue no longer refers to.
 */
(function attachSavourMediaStage(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourMediaStage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMediaStageModule() {
  "use strict";

  const DB_NAME = "savour-media";
  const STORE = "images";
  const KEY_PATTERN = /^[\w-]{8,64}$/;

  /**
   * Whether a value has the shape of a stage key; anything else is never looked up or deleted.
   * @param {string} value
   */
  function isStageKey(value) {
    return KEY_PATTERN.test(String(value ?? ""));
  }

  // Images kept in memory only: tests, and any place without IndexedDB.
  function createMemoryBackend() {
    const records = new Map();
    return {
      async put(/** @type {string} */ key, /** @type {any} */ record) {
        records.set(key, record);
      },
      async get(/** @type {string} */ key) {
        return records.get(key) ?? null;
      },
      async remove(/** @type {string} */ key) {
        records.delete(key);
      },
      async entries() {
        return [...records].map(([key, record]) => ({ key, at: record.at }));
      }
    };
  }

  function createIndexedDbBackend(/** @type {IDBFactory} */ idb) {
    let opened = /** @type {Promise<IDBDatabase> | null} */ (null);
    const open = () => {
      opened ??= new Promise((resolve, reject) => {
        const request = idb.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return opened;
    };
    const run = async (/** @type {IDBTransactionMode} */ mode, /** @type {(store: IDBObjectStore) => IDBRequest} */ action) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = action(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    };
    return {
      async put(/** @type {string} */ key, /** @type {any} */ record) {
        await run("readwrite", store => store.put(record, key));
      },
      async get(/** @type {string} */ key) {
        return (await run("readonly", store => store.get(key))) ?? null;
      },
      async remove(/** @type {string} */ key) {
        await run("readwrite", store => store.delete(key));
      },
      async entries() {
        const db = await open();
        return new Promise((resolve, reject) => {
          const found = /** @type {any[]} */ ([]);
          const request = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return resolve(found);
            found.push({ key: String(cursor.key), at: cursor.value?.at ?? 0 });
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      }
    };
  }

  /**
   * Opens the image stage: IndexedDB when there is one, otherwise memory.
   * @param {{ indexedDB?: IDBFactory | null, now?: () => number }} [options] `indexedDB: null` keeps it in memory
   */
  function createMediaStage(options = {}) {
    const idb = "indexedDB" in options ? options.indexedDB : globalThis.indexedDB;
    const backend = idb ? createIndexedDbBackend(idb) : createMemoryBackend();
    const now = options.now ?? Date.now;

    return {
      /** Keeps an image and returns the key that finds it again. */
      async put(/** @type {Blob} */ blob) {
        const key = crypto.randomUUID();
        await backend.put(key, { blob, at: now() });
        return key;
      },
      /** @returns {Promise<Blob | null>} */
      async get(/** @type {string} */ key) {
        if (!isStageKey(key)) return null;
        return (await backend.get(key))?.blob ?? null;
      },
      async remove(/** @type {string} */ key) {
        if (isStageKey(key)) await backend.remove(key);
      },
      async removeMany(/** @type {Iterable<string>} */ keys) {
        for (const key of keys) await this.remove(key);
      },
      /** Drops images nothing refers to any more: not in `keep` and older than `maxAgeMs`. */
      async prune(/** @type {Set<string>} */ keep, maxAgeMs = 24 * 60 * 60 * 1000) {
        let removed = 0;
        for (const entry of await backend.entries()) {
          if (keep.has(entry.key) || now() - entry.at < maxAgeMs) continue;
          await backend.remove(entry.key);
          removed += 1;
        }
        return removed;
      }
    };
  }

  return { createMediaStage, isStageKey };
});
