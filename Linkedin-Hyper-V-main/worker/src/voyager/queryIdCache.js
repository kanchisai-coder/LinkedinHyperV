'use strict';

// GraphQL queryId cache (Phase 5). Newer Voyager surfaces require a pinned
// queryId (e.g. "messengerConversations.<hash>") that rotates every few
// LinkedIn web releases. We harvest them from live traffic (harvest.js) and
// cache them in Redis keyed by surface; a 4xx "unknown query" triggers a
// re-harvest. This keeps the API client self-healing against version drift.

const { getRedis } = require('../redisClient');

const KEY = 'voyager:queryids';
const TTL_SECONDS = parseInt(process.env.VOYAGER_QUERYID_TTL_S || `${14 * 24 * 3600}`, 10);

// In-memory mirror so hot paths don't hit Redis every call.
const mem = new Map();

/**
 * Store harvested queryIds. `map` = { surface: queryId } or a flat list of
 * queryId strings (we index those by their dotted prefix).
 */
async function store(map) {
  const redis = getRedis();
  const entries = {};
  if (Array.isArray(map)) {
    for (const qid of map) {
      const surface = String(qid).split('.')[0] || qid;
      entries[surface] = qid;
    }
  } else {
    Object.assign(entries, map);
  }
  for (const [surface, qid] of Object.entries(entries)) {
    mem.set(surface, qid);
  }
  if (Object.keys(entries).length) {
    await redis.hset(KEY, entries).catch(() => null);
    await redis.expire(KEY, TTL_SECONDS).catch(() => null);
  }
  return entries;
}

/** Look up a queryId by surface prefix (e.g. "messengerConversations"). */
async function get(surface) {
  if (mem.has(surface)) return mem.get(surface);
  const redis = getRedis();
  const v = await redis.hget(KEY, surface).catch(() => null);
  if (v) mem.set(surface, v);
  return v || null;
}

async function all() {
  const redis = getRedis();
  const h = await redis.hgetall(KEY).catch(() => ({}));
  for (const [k, v] of Object.entries(h || {})) mem.set(k, v);
  return h || {};
}

/**
 * Invalidate one surface (call when a request returns "unknown query" so the
 * next harvest re-populates it).
 */
async function invalidate(surface) {
  mem.delete(surface);
  const redis = getRedis();
  await redis.hdel(KEY, surface).catch(() => null);
}

module.exports = { store, get, all, invalidate, KEY };
