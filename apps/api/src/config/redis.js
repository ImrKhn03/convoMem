'use strict';

/**
 * In-memory Redis-compatible client.
 * Replaces ioredis/Redis so the app needs no Redis server.
 * Supports the subset of commands used by this codebase.
 */
class MemoryRedis {
  constructor() {
    /** @type {Map<string, { value: string, expiresAt: number|null }>} */
    this._store = new Map();
    // Periodic eviction of expired keys (every 60s, non-blocking)
    setInterval(() => this._evict(), 60_000).unref();
  }

  _isExpired(entry) {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  _getEntry(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (this._isExpired(entry)) { this._store.delete(key); return null; }
    return entry;
  }

  _evict() {
    for (const [key, entry] of this._store) {
      if (this._isExpired(entry)) this._store.delete(key);
    }
  }

  async get(key) {
    const entry = this._getEntry(key);
    return entry ? entry.value : null;
  }

  async set(key, value, ...args) {
    // Supports: set(k,v), set(k,v,'EX',ttl), set(k,v,'EX',ttl,'NX')
    let expiresAt = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = typeof args[i] === 'string' ? args[i].toUpperCase() : args[i];
      if (a === 'EX') { expiresAt = Date.now() + parseInt(args[++i]) * 1000; }
      else if (a === 'NX') { nx = true; }
    }
    if (nx && this._getEntry(key)) return null;
    this._store.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async setex(key, ttlSec, value) {
    this._store.set(key, { value: String(value), expiresAt: Date.now() + ttlSec * 1000 });
    return 'OK';
  }

  async del(...keys) {
    let count = 0;
    for (const key of [].concat(...keys)) {
      if (this._store.delete(key)) count++;
    }
    return count;
  }

  async exists(key) {
    return this._getEntry(key) ? 1 : 0;
  }

  async incr(key) {
    const entry = this._getEntry(key);
    const next = (entry ? parseInt(entry.value) || 0 : 0) + 1;
    this._store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async incrbyfloat(key, amount) {
    const entry = this._getEntry(key);
    const next = (entry ? parseFloat(entry.value) || 0 : 0) + parseFloat(amount);
    this._store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return String(next);
  }

  async expire(key, ttlSec) {
    const entry = this._getEntry(key);
    if (!entry) return 0;
    this._store.set(key, { value: entry.value, expiresAt: Date.now() + ttlSec * 1000 });
    return 1;
  }

  async ttl(key) {
    const entry = this._getEntry(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async keys(pattern) {
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const result = [];
    for (const [key] of this._store) {
      if (this._getEntry(key) && regex.test(key)) result.push(key);
    }
    return result;
  }

  on() { return this; } // no-op event emitter shim
  async quit() { return 'OK'; }
}

let instance;

/**
 * Returns the in-memory Redis-compatible singleton.
 * @returns {MemoryRedis}
 */
function getRedis() {
  if (!instance) instance = new MemoryRedis();
  return instance;
}

module.exports = { getRedis };
