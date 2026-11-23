/**
 * Tiny JSON-file database (users, downloads, library).
 *
 * Writes are atomic (write to temp file, then rename) and debounced, so a crash never leaves a
 * half-written file. Everything lives in STORAGE_DIR/db/*.json.
 *
 * NOTE: On Render Free the disk is wiped on every restart/redeploy. The admin account is
 * re-created from the seed on boot, but registered users and history do not survive.
 * Swap this module for a real database (e.g. a free Postgres) to keep data permanently —
 * every other file only talks to the functions exported here.
 */
const fs = require('fs');
const path = require('path');

function createStore(storageDir) {
  const dbDir = path.join(storageDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });

  const collections = {};
  const timers = {};

  function fileOf(name) {
    return path.join(dbDir, `${name}.json`);
  }

  function load(name) {
    if (collections[name]) return collections[name];
    let data = [];
    try {
      const raw = fs.readFileSync(fileOf(name), 'utf8');
      const parsed = JSON.parse(raw.replace(/^﻿/, '') || '[]');
      if (Array.isArray(parsed)) data = parsed;
    } catch {}
    collections[name] = data;
    return data;
  }

  function flush(name) {
    const target = fileOf(name);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(collections[name] || [], null, 2));
      fs.renameSync(tmp, target);
    } catch (err) {
      console.error(`[store] could not save ${name}:`, err.message);
    }
  }

  function save(name) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(() => flush(name), 150);
  }

  function flushAll() {
    for (const name of Object.keys(collections)) {
      clearTimeout(timers[name]);
      flush(name);
    }
  }
  process.on('exit', flushAll);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      flushAll();
      process.exit(0);
    });
  }

  const api = (name) => ({
    all: () => load(name),
    find: (pred) => load(name).find(pred) || null,
    filter: (pred) => load(name).filter(pred),
    insert(doc) {
      load(name).unshift(doc);
      save(name);
      return doc;
    },
    update(id, patch) {
      const doc = load(name).find((d) => d.id === id);
      if (!doc) return null;
      Object.assign(doc, typeof patch === 'function' ? patch(doc) || {} : patch);
      save(name);
      return doc;
    },
    remove(id) {
      const list = load(name);
      const idx = list.findIndex((d) => d.id === id);
      if (idx === -1) return false;
      list.splice(idx, 1);
      save(name);
      return true;
    },
    save: () => save(name),
  });

  return {
    users: api('users'),
    downloads: api('downloads'),
    library: api('library'),
    flushAll,
    dbDir,
  };
}

module.exports = { createStore };
