'use strict';

// Per-(account, surface) harvest state: cursor, phase, progress. Redis-backed
// so it survives restarts and supports resumable backfill (SLOW_FULL_SYNC §2).
//
// Key: harvest:{accountId}:{surface}  → hash

const { getRedis } = require('../redisClient');

const SURFACES = ['conversations', 'messages', 'connections', 'invitations', 'notifications', 'profiles', 'posts'];

const PRIORITY = {
  conversations: 100, // HOT
  messages: 80,
  invitations: 60,    // WARM
  notifications: 55,
  connections: 30,    // COLD
  profiles: 20,
  posts: 10,          // COLDEST
};

const key = (a, s) => `harvest:${a}:${s}`;

function defaults(accountId, surface) {
  return {
    accountId,
    surface,
    phase: 'idle',        // idle | backfilling | caught_up | blocked
    cursor: '',
    totalEstimate: 0,
    fetched: 0,
    lastRunAt: '',
    lastSuccessAt: '',
    nextEligibleAt: '',
    consecutiveFailures: 0,
    completedAt: '',
  };
}

function coerce(raw, accountId, surface) {
  const d = defaults(accountId, surface);
  if (!raw || Object.keys(raw).length === 0) return d;
  return {
    ...d,
    ...raw,
    totalEstimate: Number(raw.totalEstimate) || 0,
    fetched: Number(raw.fetched) || 0,
    consecutiveFailures: Number(raw.consecutiveFailures) || 0,
  };
}

async function get(accountId, surface) {
  const redis = getRedis();
  const raw = await redis.hgetall(key(accountId, surface)).catch(() => ({}));
  return coerce(raw, accountId, surface);
}

async function getAll(accountId) {
  return Promise.all(SURFACES.map((s) => get(accountId, s)));
}

async function patch(accountId, surface, fields) {
  const redis = getRedis();
  const flat = {};
  for (const [k, v] of Object.entries(fields)) flat[k] = String(v ?? '');
  await redis.hset(key(accountId, surface), flat).catch(() => null);
  return get(accountId, surface);
}

async function reset(accountId, surface) {
  const redis = getRedis();
  await redis.del(key(accountId, surface)).catch(() => null);
  return get(accountId, surface);
}

function isEligibleNow(state, now = Date.now()) {
  if (state.phase === 'caught_up') {
    // delta re-check: eligible only past nextEligibleAt
    return state.nextEligibleAt ? new Date(state.nextEligibleAt).getTime() <= now : true;
  }
  if (state.phase === 'blocked') {
    return state.nextEligibleAt ? new Date(state.nextEligibleAt).getTime() <= now : false;
  }
  if (state.nextEligibleAt && new Date(state.nextEligibleAt).getTime() > now) return false;
  return true; // idle or backfilling
}

module.exports = { get, getAll, patch, reset, isEligibleNow, SURFACES, PRIORITY };
