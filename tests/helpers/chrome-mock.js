"use strict";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    async dispatch(...args) {
      return Promise.all(listeners.map(listener => listener(...args)));
    },
    get listeners() {
      return [...listeners];
    }
  };
}

function createStorageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    async get(keys) {
      if (keys == null) return structuredClone(values);
      const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const result = {};
      for (const name of names) {
        if (Object.hasOwn(values, name)) result[name] = structuredClone(values[name]);
        else if (!Array.isArray(keys) && typeof keys === "object") result[name] = structuredClone(keys[name]);
      }
      return result;
    },
    async set(entries) {
      Object.assign(values, structuredClone(entries));
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
    async setAccessLevel() {},
    snapshot() {
      return structuredClone(values);
    }
  };
}

function createChromeMock(initial = {}) {
  const createdMenus = [];
  const alarms = [];
  const local = createStorageArea(initial.local);
  const session = createStorageArea(initial.session);
  return {
    runtime: {
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent()
    },
    alarms: {
      onAlarm: createEvent(),
      create(name, details) {
        alarms.push({ name, details });
      }
    },
    contextMenus: {
      onClicked: createEvent(),
      removeAll(callback) {
        createdMenus.length = 0;
        callback?.();
      },
      create(details) {
        createdMenus.push(structuredClone(details));
      }
    },
    commands: { onCommand: createEvent() },
    tabs: {
      async query() {
        return initial.tabs || [];
      },
      async sendMessage() {
        return { ok: true };
      }
    },
    storage: { local, session },
    __createdMenus: createdMenus,
    __alarms: alarms
  };
}

module.exports = { createChromeMock, createEvent, createStorageArea };
