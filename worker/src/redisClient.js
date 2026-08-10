'use strict';

const Redis = require('ioredis');
const { EventEmitter } = require('events');

let _redis = null;
let _memoryRedis = null;
const _memoryStrings = new Map();
const _memoryLists = new Map();
const _memorySets = new Map();
const _memoryHashes = new Map();
const _memoryExpiry = new Map();

function isRedisDisabled() {
  return process.env.DISABLE_REDIS === '1';
}

function purgeExpiredKey(key) {
  const expiresAt = _memoryExpiry.get(key);
  if (!expiresAt) return;
  if (Date.now() < expiresAt) return;
  _memoryExpiry.delete(key);
  _memoryStrings.delete(key);
  _memoryLists.delete(key);
  _memorySets.delete(key);
  _memoryHashes.delete(key);
}

function getStringValue(key) {
  purgeExpiredKey(key);
  return _memoryStrings.has(key) ? _memoryStrings.get(key) : null;
}

function setStringValue(key, value, ttlSeconds) {
  _memoryStrings.set(key, String(value));
  _memoryLists.delete(key);
  _memorySets.delete(key);
  _memoryHashes.delete(key);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    _memoryExpiry.set(key, Date.now() + (ttlSeconds * 1000));
  } else {
    _memoryExpiry.delete(key);
  }
}

function getListValue(key) {
  purgeExpiredKey(key);
  const existing = _memoryLists.get(key);
  if (existing) return existing;
  const list = [];
  _memoryLists.set(key, list);
  _memoryStrings.delete(key);
  _memorySets.delete(key);
  _memoryHashes.delete(key);
  return list;
}

function getSetValue(key) {
  purgeExpiredKey(key);
  const existing = _memorySets.get(key);
  if (existing) return existing;
  const set = new Set();
  _memorySets.set(key, set);
  _memoryStrings.delete(key);
  _memoryLists.delete(key);
  _memoryHashes.delete(key);
  return set;
}

function getHashValue(key) {
  purgeExpiredKey(key);
  const existing = _memoryHashes.get(key);
  if (existing) return existing;
  const hash = new Map();
  _memoryHashes.set(key, hash);
  _memoryStrings.delete(key);
  _memoryLists.delete(key);
  _memorySets.delete(key);
  return hash;
}

function createInMemoryRedis() {
  if (_memoryRedis) return _memoryRedis;

  const events = new EventEmitter();
  let client;

  const normalizeIndex = (idx, length, fallback) => {
    const parsed = Number.parseInt(String(idx), 10);
    if (Number.isNaN(parsed)) return fallback;
    return parsed >= 0 ? parsed : length + parsed;
  };

  client = {
    on(eventName, listener) {
      events.on(eventName, listener);
      return client;
    },
    once(eventName, listener) {
      events.once(eventName, listener);
      return client;
    },
    async get(key) {
      return getStringValue(key);
    },
    async mget(...keys) {
      return keys.map((key) => getStringValue(key));
    },
    async set(key, value, mode, ttlSeconds) {
      const hasExpiry = typeof mode === 'string' && mode.toUpperCase() === 'EX';
      const ttl = hasExpiry ? Number.parseInt(String(ttlSeconds), 10) : null;
      setStringValue(key, value, ttl);
      return 'OK';
    },
    async setex(key, ttlSeconds, value) {
      const ttl = Number.parseInt(String(ttlSeconds), 10);
      setStringValue(key, value, ttl);
      return 'OK';
    },
    async del(...keys) {
      let deleted = 0;
      for (const key of keys) {
        purgeExpiredKey(key);
        const hadKey = _memoryStrings.has(key) || _memoryLists.has(key) || _memorySets.has(key) || _memoryHashes.has(key);
        _memoryStrings.delete(key);
        _memoryLists.delete(key);
        _memorySets.delete(key);
        _memoryHashes.delete(key);
        _memoryExpiry.delete(key);
        if (hadKey) deleted += 1;
      }
      return deleted;
    },
    async incr(key) {
      const current = Number.parseInt(getStringValue(key) || '0', 10) || 0;
      const next = current + 1;
      setStringValue(key, String(next), null);
      return next;
    },
    async eval(_script, _numKeys, key, ttlSeconds) {
      const current = await client.incr(key);
      if (current === 1) {
        const ttl = Number.parseInt(String(ttlSeconds), 10);
        if (Number.isFinite(ttl) && ttl > 0) {
          _memoryExpiry.set(key, Date.now() + (ttl * 1000));
        }
      }
      return current;
    },
    async lpush(key, ...values) {
      const list = getListValue(key);
      for (const value of values) {
        list.unshift(String(value));
      }
      return list.length;
    },
    async ltrim(key, start, stop) {
      const list = getListValue(key);
      const len = list.length;
      if (len === 0) return 'OK';

      const normalizedStart = normalizeIndex(start, len, 0);
      const normalizedStop = normalizeIndex(stop, len, len - 1);

      const from = Math.max(0, normalizedStart);
      const to = Math.min(len - 1, normalizedStop);

      if (to < from) {
        _memoryLists.set(key, []);
        return 'OK';
      }

      _memoryLists.set(key, list.slice(from, to + 1));
      return 'OK';
    },
    async llen(key) {
      return getListValue(key).length;
    },
    async lrange(key, start, stop) {
      const list = getListValue(key);
      const len = list.length;
      if (len === 0) return [];

      const normalizedStart = normalizeIndex(start, len, 0);
      const normalizedStop = normalizeIndex(stop, len, len - 1);

      const from = Math.max(0, normalizedStart);
      const to = Math.min(len - 1, normalizedStop);
      if (to < from) return [];
      return list.slice(from, to + 1);
    },
    async sadd(key, ...members) {
      const set = getSetValue(key);
      let added = 0;
      for (const member of members) {
        const normalized = String(member);
        if (!set.has(normalized)) {
          set.add(normalized);
          added += 1;
        }
      }
      return added;
    },
    async srem(key, ...members) {
      const set = getSetValue(key);
      let removed = 0;
      for (const member of members) {
        const normalized = String(member);
        if (set.delete(normalized)) {
          removed += 1;
        }
      }
      return removed;
    },
    async smembers(key) {
      return Array.from(getSetValue(key));
    },
    async hset(key, field, value) {
      const hash = getHashValue(key);
      hash.set(String(field), String(value));
      return 1;
    },
    async hvals(key) {
      const hash = getHashValue(key);
      return Array.from(hash.values());
    },
    async xadd(key, _id, ...pairs) {
      const list = getListValue(key);
      const entry = {
        id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        values: [],
      };
      for (let i = 0; i < pairs.length; i += 2) {
        entry.values.push(String(pairs[i]), String(pairs[i + 1] ?? ''));
      }
      list.push(JSON.stringify(entry));
      return entry.id;
    },
    async ping() {
      return 'PONG';
    },
    async quit() {
      return 'OK';
    },
    disconnect() {
      return;
    },
  };

  _memoryRedis = client;
  console.log('[Redis] DISABLE_REDIS=1 enabled, using in-memory fallback store');
  return _memoryRedis;
}

/**
 * Returns the shared Redis connection.
 * Lazy-initialised so tests can set env vars before first use.
 */
function getRedis() {
  if (isRedisDisabled()) {
    return createInMemoryRedis();
  }

  if (_redis) return _redis;

  _redis = new Redis({
    host:     process.env.REDIS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    // API routes should fail fast when Redis is unavailable so HTTP handlers
    // can degrade gracefully instead of hanging until frontend timeout.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    // FIX: previously `() => null`, which permanently killed the connection on
    // the FIRST disconnect (Redis restart, idle drop, network blip) — every
    // later command then threw "Connection is closed." forever. Reconnect with
    // capped backoff; per-command fail-fast is still enforced by
    // maxRetriesPerRequest + commandTimeout.
    retryStrategy: (times) => Math.min(times * 200, 5000),
    reconnectOnError: (err) => /READONLY|ECONNRESET|EPIPE/i.test(err.message),
    lazyConnect: false,
    enableReadyCheck: false,
  });

  _redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
  });
  _redis.on('reconnecting', (ms) => {
    console.warn(`[Redis] reconnecting in ${ms}ms`);
  });

  return _redis;
}

/**
 * Returns a new discrete Redis connection, required by BullMQ workers.
 */
function createRedisClient() {
  if (isRedisDisabled()) {
    throw new Error('Redis is disabled by DISABLE_REDIS=1. Set DISABLE_QUEUE=1 for local mode, or enable Redis for queue workers.');
  }

  const client = new Redis({
    host:     process.env.REDIS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    // BullMQ requires maxRetriesPerRequest to be null.
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectTimeout: 3000,
    // FIX: BullMQ connections MUST reconnect. `() => null` made the queue/worker
    // connection die on the first disconnect, after which scheduleAdaptiveSync
    // and every job op threw "Connection is closed." indefinitely. Reconnect
    // with capped backoff (BullMQ's recommended posture).
    retryStrategy: (times) => Math.min(times * 200, 5000),
    reconnectOnError: (err) => /READONLY|ECONNRESET|EPIPE/i.test(err.message),
    lazyConnect: false,
    enableReadyCheck: false,
  });

  client.on('error', (err) => {
    console.error('[Redis Client] Connection error:', err.message);
  });

  return client;
}

module.exports = { getRedis, createRedisClient };
