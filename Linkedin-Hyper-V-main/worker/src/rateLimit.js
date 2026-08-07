'use strict';

const { getRedis } = require('./redisClient');

// Conservative daily limits — well below LinkedIn detection thresholds
const toPositiveInt = (value, fallback) => {
  const parsed = parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
};

// Conservative daily limits; can be tuned with env variables in production.
const LIMITS = {
  messagesSent:    toPositiveInt(process.env.RATE_LIMIT_MESSAGES_SENT, 25),
  connectRequests: toPositiveInt(process.env.RATE_LIMIT_CONNECT_REQUESTS, 15),
  profileViews:    toPositiveInt(process.env.RATE_LIMIT_PROFILE_VIEWS, 60),
  searchQueries:   toPositiveInt(process.env.RATE_LIMIT_SEARCH_QUERIES, 40),
  // 50/day is too low for dashboard polling + manual refreshes.
  inboxReads:      toPositiveInt(process.env.RATE_LIMIT_INBOX_READS, 500),
};

// ANTI-BAN: hourly caps prevent burst behavior that is more bot-like than
// hitting the daily cap evenly across 24h. Defaults are intentionally
// conservative — about 1/8 of the daily cap so steady-state activity spans
// the business day, not a single hour.
const HOURLY_LIMITS = {
  messagesSent:    toPositiveInt(process.env.RATE_LIMIT_HOURLY_MESSAGES_SENT, 4),
  connectRequests: toPositiveInt(process.env.RATE_LIMIT_HOURLY_CONNECT_REQUESTS, 3),
  profileViews:    toPositiveInt(process.env.RATE_LIMIT_HOURLY_PROFILE_VIEWS, 10),
  searchQueries:   toPositiveInt(process.env.RATE_LIMIT_HOURLY_SEARCH_QUERIES, 6),
  inboxReads:      toPositiveInt(process.env.RATE_LIMIT_HOURLY_INBOX_READS, 60),
};

// Local fallback for dev mode when Redis is unavailable.
const memoryCounters = new Map();
let cachedRedis = null;

function getRateLimitRedis() {
  if (!cachedRedis) {
    cachedRedis = getRedis();
  }
  return cachedRedis;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function hourKey() {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH UTC
}

/**
 * Atomically increment counter and check against limit.
 * Throws if limit exceeded.
 */
async function incrAtomically(key, ttlSeconds) {
  try {
    const redis = getRateLimitRedis();
    return await redis.eval(`
      local count = redis.call("INCR", KEYS[1])
      if count == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return count
    `, 1, key, ttlSeconds);
  } catch (_err) {
    const prev = memoryCounters.get(key) || 0;
    const next = prev + 1;
    memoryCounters.set(key, next);
    setTimeout(() => memoryCounters.delete(key), ttlSeconds * 1000).unref?.();
    return next;
  }
}

async function checkAndIncrement(accountId, action) {
  const limit = LIMITS[action];
  if (limit === undefined) throw new Error(`Unknown rate-limit action: ${action}`);
  const hourlyLimit = HOURLY_LIMITS[action];

  const secondsUntilMidnight = 86400 - (Math.floor(Date.now() / 1000) % 86400);
  const secondsUntilNextHour = 3600 - (Math.floor(Date.now() / 1000) % 3600);

  const dailyKey  = `ratelimit:${accountId}:${action}:${todayKey()}`;
  const hourlyKey = `ratelimit:${accountId}:${action}:h:${hourKey()}`;

  // Increment hourly first — failing it doesn't consume daily budget.
  if (hourlyLimit !== undefined) {
    const hourlyCount = await incrAtomically(hourlyKey, secondsUntilNextHour + 30);
    if (hourlyCount > hourlyLimit) {
      const err = new Error(
        `Hourly limit reached: ${action} (${hourlyCount}/${hourlyLimit}) for account ${accountId}`
      );
      err.code   = 'RATE_LIMIT_HOURLY_EXCEEDED';
      err.status = 429;
      throw err;
    }
  }

  const current = await incrAtomically(dailyKey, secondsUntilMidnight + 60);
  if (current > limit) {
    const err = new Error(
      `Daily limit reached: ${action} (${current}/${limit}) for account ${accountId}`
    );
    err.code   = 'RATE_LIMIT_EXCEEDED';
    err.status = 429;
    throw err;
  }

  return { current, limit, remaining: limit - current };
}

async function readCount(key) {
  try {
    const redis = getRateLimitRedis();
    const v = await redis.get(key);
    return v ? parseInt(v, 10) || 0 : 0;
  } catch (_err) {
    return memoryCounters.get(key) || 0;
  }
}

/**
 * Pre-action gate: throw if the account is ALREADY at/over its daily or hourly
 * cap, WITHOUT consuming budget. Call this before performing a browser action;
 * commit the quota with checkAndIncrement only after the action succeeds.
 *
 * This is what actually throttles — checkAndIncrement alone runs after delivery,
 * so on its own it cannot prevent an over-limit action from reaching LinkedIn.
 */
async function checkOnly(accountId, action) {
  const limit = LIMITS[action];
  if (limit === undefined) throw new Error(`Unknown rate-limit action: ${action}`);
  const hourlyLimit = HOURLY_LIMITS[action];

  if (hourlyLimit !== undefined) {
    const hourlyKey = `ratelimit:${accountId}:${action}:h:${hourKey()}`;
    const hourlyCount = await readCount(hourlyKey);
    if (hourlyCount >= hourlyLimit) {
      const err = new Error(
        `Hourly limit reached: ${action} (${hourlyCount}/${hourlyLimit}) for account ${accountId}`
      );
      err.code   = 'RATE_LIMIT_HOURLY_EXCEEDED';
      err.status = 429;
      throw err;
    }
  }

  const dailyKey = `ratelimit:${accountId}:${action}:${todayKey()}`;
  const dailyCount = await readCount(dailyKey);
  if (dailyCount >= limit) {
    const err = new Error(
      `Daily limit reached: ${action} (${dailyCount}/${limit}) for account ${accountId}`
    );
    err.code   = 'RATE_LIMIT_EXCEEDED';
    err.status = 429;
    throw err;
  }

  return { current: dailyCount, limit, remaining: limit - dailyCount };
}

async function getLimits(accountId) {
  const today   = todayKey();
  const actions = Object.keys(LIMITS);
  const keys    = actions.map((a) => `ratelimit:${accountId}:${a}:${today}`);
  let values;

  try {
    const redis = getRateLimitRedis();
    // Single round-trip instead of N sequential GETs.
    values = await redis.mget(...keys);
  } catch (_err) {
    values = keys.map((k) => String(memoryCounters.get(k) || 0));
  }

  return Object.fromEntries(
    actions.map((action, i) => {
      const current = parseInt(values[i] || '0', 10);
      const limit   = LIMITS[action];
      return [action, { current, limit, remaining: Math.max(0, limit - current) }];
    })
  );
}

module.exports = { checkAndIncrement, checkOnly, getLimits };
