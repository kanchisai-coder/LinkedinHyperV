'use strict';

// Anti-ban gates: business-hours, per-surface circuit breaker, deterministic
// per-account fingerprints, per-account proxy resolution.
//
// All state lives in Redis; falls back to in-memory when Redis is unavailable
// (dev mode). Keep this module side-effect-free at import time.

const crypto = require('crypto');
const { getRedis } = require('./redisClient');

const memFallback = new Map();

function envInt(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envBool(name, fallback = false) {
  const v = String(process.env[name] || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

async function redisIncrWithExpire(key, ttlSeconds) {
  try {
    const redis = getRedis();
    const count = await redis.eval(
      `local c = redis.call("INCR", KEYS[1])
       if c == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
       return c`,
      1, key, ttlSeconds
    );
    return Number(count) || 0;
  } catch {
    const prev = memFallback.get(key) || 0;
    const next = prev + 1;
    memFallback.set(key, next);
    setTimeout(() => memFallback.delete(key), ttlSeconds * 1000).unref?.();
    return next;
  }
}

async function redisGet(key) {
  try {
    const redis = getRedis();
    const v = await redis.get(key);
    return v;
  } catch {
    return memFallback.get(key) || null;
  }
}

async function redisSetWithExpire(key, value, ttlSeconds) {
  try {
    const redis = getRedis();
    await redis.set(key, String(value), 'EX', ttlSeconds);
  } catch {
    memFallback.set(key, String(value));
    setTimeout(() => memFallback.delete(key), ttlSeconds * 1000).unref?.();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Business-hours gate
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_BUSINESS_TZ = process.env.ANTIBAN_DEFAULT_TZ || 'America/New_York';
const BUSINESS_START_HOUR = envInt('ANTIBAN_BUSINESS_START', 9);   // 09:00 local
const BUSINESS_END_HOUR = envInt('ANTIBAN_BUSINESS_END', 18);      // 18:00 local
const ALLOW_WEEKENDS = envBool('ANTIBAN_ALLOW_WEEKENDS', false);
const BUSINESS_HOURS_ENABLED = envBool('ANTIBAN_BUSINESS_HOURS_ENABLED', true);

/**
 * Returns whether actions should be dispatched for an account right now.
 * Looks at the account's local timezone (defaults to America/New_York unless
 * ANTIBAN_TZ_<accountId> env var or accountTz override is provided).
 */
function isWithinBusinessHours(accountId, accountTz = null) {
  if (!BUSINESS_HOURS_ENABLED) return true;
  const tz = accountTz
    || process.env[`ANTIBAN_TZ_${String(accountId || '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`]
    || DEFAULT_BUSINESS_TZ;
  let local;
  try {
    local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  } catch {
    local = new Date();
  }
  const day = local.getDay();   // 0=Sun..6=Sat
  const hour = local.getHours();
  if (!ALLOW_WEEKENDS && (day === 0 || day === 6)) return false;
  return hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Per-surface circuit breaker
// ────────────────────────────────────────────────────────────────────────────
//
// Rules:
//   - 3 failures on the same surface within 1h  → that surface is BLOCKED 6h
//   - 3 surfaces blocked for one account simultaneously → whole account COOLS DOWN 12h
//
// Surfaces: inbox, thread, connections, invitations, notifications, posts, search.

const SURFACE_FAIL_WINDOW_S = envInt('ANTIBAN_SURFACE_FAIL_WINDOW_S', 3600);
const SURFACE_FAIL_THRESHOLD = envInt('ANTIBAN_SURFACE_FAIL_THRESHOLD', 3);
const SURFACE_COOLDOWN_S = envInt('ANTIBAN_SURFACE_COOLDOWN_S', 6 * 3600);
const ACCOUNT_COOLDOWN_S = envInt('ANTIBAN_ACCOUNT_COOLDOWN_S', 12 * 3600);
const ACCOUNT_COOLDOWN_THRESHOLD = envInt('ANTIBAN_ACCOUNT_COOLDOWN_THRESHOLD', 3);

const SURFACES = ['inbox', 'thread', 'connections', 'invitations', 'notifications', 'posts', 'search'];

const k = {
  surfaceFail: (a, s) => `antiban:fail:${a}:${s}`,
  surfaceBlocked: (a, s) => `antiban:blocked:${a}:${s}`,
  accountCooldown: (a) => `antiban:cooldown:account:${a}`,
};

/**
 * Returns { allowed, reason, retryAfterSeconds } — call before launching a
 * browser/action for a given account+surface. If allowed===false, ABORT.
 */
async function gateAction({ accountId, surface, accountTz = null, enforceBusinessHours = true }) {
  if (!accountId) return { allowed: false, reason: 'missing accountId' };

  // 1. Whole-account cooldown
  const cooldownTtl = await redisTtl(k.accountCooldown(accountId));
  if (cooldownTtl > 0) {
    return {
      allowed: false,
      reason: 'account_cooldown',
      retryAfterSeconds: cooldownTtl,
    };
  }

  // 2. Per-surface block
  if (surface) {
    const surfaceTtl = await redisTtl(k.surfaceBlocked(accountId, surface));
    if (surfaceTtl > 0) {
      return {
        allowed: false,
        reason: 'surface_blocked',
        retryAfterSeconds: surfaceTtl,
      };
    }
  }

  // 3. Business hours (skippable for user-initiated actions, which should not be
  //    blocked at night — the cooldown/surface-block above still apply).
  if (enforceBusinessHours && !isWithinBusinessHours(accountId, accountTz)) {
    return {
      allowed: false,
      reason: 'outside_business_hours',
      retryAfterSeconds: secondsUntilNextBusinessWindow(accountTz),
    };
  }

  return { allowed: true };
}

async function redisTtl(key) {
  try {
    const redis = getRedis();
    const ttl = await redis.ttl(key);
    return ttl > 0 ? ttl : 0;
  } catch {
    return memFallback.has(key) ? 60 : 0;
  }
}

function secondsUntilNextBusinessWindow(accountTz = null) {
  const tz = accountTz || DEFAULT_BUSINESS_TZ;
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    let candidate = new Date(now);
    candidate.setHours(BUSINESS_START_HOUR, 0, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    while (!ALLOW_WEEKENDS && (candidate.getDay() === 0 || candidate.getDay() === 6)) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return Math.max(60, Math.floor((candidate - now) / 1000));
  } catch {
    return 3600;
  }
}

/**
 * Call after a failure that points at LinkedIn (block, automation_warning,
 * checkpoint, redirect-loop, etc). Increments the surface failure counter and
 * trips the circuit breaker if thresholds are crossed.
 */
async function recordSurfaceFailure({ accountId, surface, posture }) {
  if (!accountId || !surface) return { tripped: false };
  // Don't penalize transient timeouts; only count hard signals.
  const hardSignals = ['blocked', 'automation_warning', 'checkpoint', 'expired'];
  if (posture && !hardSignals.includes(posture)) return { tripped: false };

  const count = await redisIncrWithExpire(
    k.surfaceFail(accountId, surface),
    SURFACE_FAIL_WINDOW_S
  );
  if (count < SURFACE_FAIL_THRESHOLD) {
    return { tripped: false, count };
  }

  // Trip surface circuit breaker
  await redisSetWithExpire(k.surfaceBlocked(accountId, surface), '1', SURFACE_COOLDOWN_S);
  console.warn(`[antiBan] surface_blocked account=${accountId} surface=${surface} for ${SURFACE_COOLDOWN_S}s`);

  // Count how many surfaces are currently blocked
  const blocked = await Promise.all(
    SURFACES.map(async (s) => ((await redisTtl(k.surfaceBlocked(accountId, s))) > 0 ? s : null))
  );
  const blockedCount = blocked.filter(Boolean).length;
  if (blockedCount >= ACCOUNT_COOLDOWN_THRESHOLD) {
    await redisSetWithExpire(k.accountCooldown(accountId), '1', ACCOUNT_COOLDOWN_S);
    console.warn(`[antiBan] account_cooldown account=${accountId} blockedSurfaces=${blockedCount} for ${ACCOUNT_COOLDOWN_S}s`);
    return { tripped: true, scope: 'account', blockedCount };
  }

  return { tripped: true, scope: 'surface' };
}

async function clearAccountCooldown(accountId) {
  try {
    const redis = getRedis();
    await Promise.all([
      redis.del(k.accountCooldown(accountId)),
      ...SURFACES.map((s) => redis.del(k.surfaceBlocked(accountId, s))),
      ...SURFACES.map((s) => redis.del(k.surfaceFail(accountId, s))),
    ]);
  } catch {
    for (const key of [...memFallback.keys()]) {
      if (key.includes(`:${accountId}:`) || key.endsWith(`:${accountId}`)) {
        memFallback.delete(key);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Deterministic per-account fingerprint
// ────────────────────────────────────────────────────────────────────────────
//
// Goal: each account gets a stable, plausible-looking fingerprint that NEVER
// changes across runs. Fingerprint stability per account is more human than
// rotation. Derived from accountId hash so no DB column needed.

const UA_POOL = [
  // Win10 / Chrome — most common
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  // macOS / Chrome
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  // Win11 / Edge
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
];

const VIEWPORT_POOL = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

const TZ_POOL = [
  { tz: 'America/New_York', locale: 'en-US' },
  { tz: 'America/Chicago', locale: 'en-US' },
  { tz: 'America/Los_Angeles', locale: 'en-US' },
  { tz: 'America/Denver', locale: 'en-US' },
];

function hashAccount(accountId) {
  return crypto.createHash('sha256').update(String(accountId || 'default')).digest();
}

function pickFromPool(pool, hash, offset) {
  // Use 4 bytes starting at `offset` to pick deterministically
  const idx = hash.readUInt32BE(offset % 28) % pool.length;
  return pool[idx];
}

function fingerprintForAccount(accountId, overrides = {}) {
  const h = hashAccount(accountId);
  const explicitTz = overrides.timezoneId
    || process.env[`ANTIBAN_TZ_${String(accountId || '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`];
  const tzEntry = explicitTz
    ? { tz: explicitTz, locale: overrides.locale || 'en-US' }
    : pickFromPool(TZ_POOL, h, 0);
  return {
    userAgent: overrides.userAgent || pickFromPool(UA_POOL, h, 4),
    viewport: overrides.viewport || pickFromPool(VIEWPORT_POOL, h, 8),
    timezoneId: tzEntry.tz,
    locale: tzEntry.locale,
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    colorScheme: 'light',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Per-account proxy resolution (env-map, no schema change)
// ────────────────────────────────────────────────────────────────────────────
//
// Lookup order:
//   1. PROXY_FOR_<ACCOUNTID>  (uppercased, non-alphanumeric replaced with _)
//   2. PROXY_URL              (legacy single-proxy fallback)
//   3. null                   (refuse to run if ANTIBAN_REQUIRE_PROXY=1)

function envKeyForAccount(accountId) {
  const safe = String(accountId || '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return `PROXY_FOR_${safe}`;
}

const REQUIRE_PROXY = envBool('ANTIBAN_REQUIRE_PROXY', false);

// Synchronous env-var resolution. A per-account value of literally "pool" means
// "use the rotating proxy pool" — resolved by the async variant below.
function resolveProxyForAccount(accountId) {
  const perAccount = process.env[envKeyForAccount(accountId)];
  if (perAccount && perAccount.trim() && perAccount.trim() !== 'pool') return perAccount.trim();

  const legacy = process.env.PROXY_URL;
  if (legacy && legacy.trim() && legacy.trim() !== 'pool') return legacy.trim();

  if (REQUIRE_PROXY) {
    const err = new Error(
      `No proxy assigned for ${accountId} and ANTIBAN_REQUIRE_PROXY=1 — refusing direct egress.`
    );
    err.code = 'PROXY_REQUIRED';
    throw err;
  }
  return null;
}

// Async resolver that consults the rotating pool. Use this from request paths.
// Order: explicit per-account URL → "pool" sentinel or PROXY_POOL_MODE → pool
// pick → legacy PROXY_URL → null (or throw if ANTIBAN_REQUIRE_PROXY).
async function resolveProxyForAccountAsync(accountId) {
  const perAccount = (process.env[envKeyForAccount(accountId)] || '').trim();
  if (perAccount && perAccount !== 'pool') return perAccount;

  const wantPool = perAccount === 'pool'
    || String(process.env.PROXY_POOL_MODE || '') === '1'
    || (process.env.PROXY_URL || '').trim() === 'pool';
  if (wantPool) {
    try {
      const pool = require('./proxy/proxyPool');
      if (pool.poolEnabled()) {
        const picked = await pool.pick(accountId);
        if (picked) return picked;
      }
    } catch (e) { console.warn('[antiBan] proxy pool pick failed:', e.message); }
  }

  const legacy = (process.env.PROXY_URL || '').trim();
  if (legacy && legacy !== 'pool') return legacy;

  if (REQUIRE_PROXY) {
    const err = new Error(`No proxy for ${accountId} and ANTIBAN_REQUIRE_PROXY=1 — refusing direct egress.`);
    err.code = 'PROXY_REQUIRED';
    throw err;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────────────────

module.exports = {
  // gates
  gateAction,
  isWithinBusinessHours,
  secondsUntilNextBusinessWindow,
  // circuit breaker
  recordSurfaceFailure,
  clearAccountCooldown,
  // fingerprint
  fingerprintForAccount,
  // proxy
  resolveProxyForAccount,
  resolveProxyForAccountAsync,
  // testing exports
  SURFACES,
  _internals: { envKeyForAccount, hashAccount, pickFromPool, UA_POOL, VIEWPORT_POOL, TZ_POOL },
};
