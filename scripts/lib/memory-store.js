'use strict';
// In-memory (optionally file-backed) stand-in for a Netlify Blobs store, used by
// tests and the local dev server only. Implements the subset the functions use,
// including conditional writes (onlyIfMatch / onlyIfNew) with etags.

const crypto = require('crypto');
const fs = require('fs');

class MemoryStore {
  constructor(name, { file, failOn } = {}) {
    this.name = name;
    this.file = file;
    this.failOn = failOn || null; // optional (op, key) => boolean for fault injection
    this.map = new Map();
    this.ops = [];
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(saved)) this.map.set(k, v);
    }
  }

  persist() {
    if (!this.file) return;
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2));
  }

  check(op, key) {
    this.ops.push(`${op}:${key}`);
    if (this.failOn && this.failOn(op, key)) throw new Error(`injected ${op} failure`);
  }

  async get(key, { type } = {}) {
    this.check('get', key);
    const e = this.map.get(key);
    if (!e) return null;
    return type === 'json' ? JSON.parse(e.body) : e.body;
  }

  async getWithMetadata(key, { type } = {}) {
    this.check('get', key);
    const e = this.map.get(key);
    if (!e) return null;
    return { data: type === 'json' ? JSON.parse(e.body) : e.body, etag: e.etag, metadata: {} };
  }

  async setJSON(key, data, opts = {}) {
    return this.set(key, JSON.stringify(data), opts);
  }

  async set(key, body, opts = {}) {
    this.check('set', key);
    const cur = this.map.get(key);
    if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
    if (opts.onlyIfNew && cur) return { modified: false };
    const etag = '"' + crypto.createHash('md5').update(body + ':' + Date.now() + ':' + Math.random()).digest('hex') + '"';
    this.map.set(key, { body, etag });
    this.persist();
    return { modified: true, etag };
  }

  async delete(key) {
    this.check('delete', key);
    this.map.delete(key);
    this.persist();
  }

  async list({ prefix = '' } = {}) {
    return { blobs: [...this.map.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, etag: e.etag })), directories: [] };
  }

  // Test helper: raw stored JSON
  peek(key) {
    const e = this.map.get(key);
    return e ? JSON.parse(e.body) : undefined;
  }
}

function memoryStoreFactory(options = {}) {
  const stores = new Map();
  const factory = name => {
    if (!stores.has(name)) {
      const file = options.dir ? require('path').join(options.dir, `${name}.json`) : undefined;
      stores.set(name, new MemoryStore(name, { file, failOn: options.failOn }));
    }
    return stores.get(name);
  };
  factory.stores = stores;
  return factory;
}

module.exports = { MemoryStore, memoryStoreFactory };
