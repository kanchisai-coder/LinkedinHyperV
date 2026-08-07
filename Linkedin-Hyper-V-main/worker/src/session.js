'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getRedis } = require('./redisClient');

const ALGORITHM = 'aes-256-gcm';
const SESSION_TTL_DAYS = Math.max(1, parseInt(process.env.SESSION_TTL_DAYS || '30', 10) || 30);
const SESSION_TTL = 86400 * SESSION_TTL_DAYS;
const META_TTL = 86400 * SESSION_TTL_DAYS;
const REDIS_SESSION_OP_TIMEOUT_MS = parseInt(process.env.REDIS_SESSION_TIMEOUT_MS || '2500', 10);

// Local fallback when Redis is unavailable (dev convenience).
const memorySessions = new Map();
const memoryMeta = new Map();
const knownAccountIds = new Set(
  (process.env.ACCOUNT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
let redisWarningShown = false;
let diskStoreWarningShown = false;

const DISK_STORE_PATH = path.join(__dirname, '..', '.local-sessions.json');

function warnRedisFallback(err) {
  if (redisWarningShown) return;
  redisWarningShown = true;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[Session] Redis unavailable, using in-memory session store: ${message}`);
}

async function withRedisTimeout(promise, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[Session] ${label} timed out after ${REDIS_SESSION_OP_TIMEOUT_MS}ms`));
    }, REDIS_SESSION_OP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getKey() {
  const hex = process.env.SESSION_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'SESSION_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
      'Generate with: openssl rand -hex 32'
    );
  }
  return Buffer.from(hex, 'hex');
}

function useDiskSessionStore() {
  return process.env.DISABLE_REDIS === '1' || process.env.PERSIST_LOCAL_SESSIONS === '1';
}

function warnDiskStore(err) {
  if (diskStoreWarningShown) return;
  diskStoreWarningShown = true;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[Session] Local disk session store unavailable: ${message}`);
}

function readDiskStore() {
  if (!useDiskSessionStore()) return { sessions: {}, meta: {} };
  try {
    if (!fs.existsSync(DISK_STORE_PATH)) {
      return { sessions: {}, meta: {} };
    }
    const raw = fs.readFileSync(DISK_STORE_PATH, 'utf8');
    if (!raw.trim()) return { sessions: {}, meta: {} };
    const parsed = JSON.parse(raw);
    return {
      sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      meta: parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    };
  } catch (err) {
    warnDiskStore(err);
    return { sessions: {}, meta: {} };
  }
}

function writeDiskStore(store) {
  if (!useDiskSessionStore()) return;
  try {
    fs.writeFileSync(
      DISK_STORE_PATH,
      JSON.stringify(store),
      { encoding: 'utf8' }
    );
  } catch (err) {
    warnDiskStore(err);
  }
}

function saveSessionToDisk(accountId, normalisedCookies, savedAt) {
  if (!useDiskSessionStore()) return;
  try {
    const store = readDiskStore();
    store.sessions[accountId] = encrypt(JSON.stringify(normalisedCookies));
    store.meta[accountId] = { savedAt };
    writeDiskStore(store);
  } catch (err) {
    warnDiskStore(err);
  }
}

function loadSessionFromDisk(accountId) {
  if (!useDiskSessionStore()) return null;
  try {
    const store = readDiskStore();
    const raw = store.sessions[accountId];
    if (!raw) return null;
    return JSON.parse(decrypt(raw));
  } catch (err) {
    warnDiskStore(err);
    return null;
  }
}

function loadMetaFromDisk(accountId) {
  if (!useDiskSessionStore()) return null;
  try {
    const store = readDiskStore();
    const meta = store.meta[accountId];
    if (!meta?.savedAt) return null;
    return { savedAt: meta.savedAt };
  } catch (err) {
    warnDiskStore(err);
    return null;
  }
}

function deleteSessionFromDisk(accountId) {
  if (!useDiskSessionStore()) return;
  try {
    const store = readDiskStore();
    delete store.sessions[accountId];
    delete store.meta[accountId];
    writeDiskStore(store);
  } catch (err) {
    warnDiskStore(err);
  }
}

function listAccountIdsFromDisk() {
  if (!useDiskSessionStore()) return [];
  try {
    const store = readDiskStore();
    const sessionIds = Object.keys(store.sessions || {});
    const metaIds = Object.keys(store.meta || {});
    return Array.from(new Set([...sessionIds, ...metaIds]))
      .map((id) => String(id).trim())
      .filter(Boolean);
  } catch (err) {
    warnDiskStore(err);
    return [];
  }
}

function configuredAccountIds() {
  return (process.env.ACCOUNT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function encrypt(plaintext) {
  const iv     = crypto.randomBytes(16);
  const key    = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return JSON.stringify({
    iv:   iv.toString('hex'),
    tag:  tag.toString('hex'),
    data: enc.toString('hex'),
  });
}

function decrypt(payload) {
  const { iv, tag, data } = JSON.parse(payload);
  const key      = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/** Normalise sameSite values to what Playwright accepts */
function normaliseCookies(cookies) {
  const normalizedList = cookies.map((c) => {
    const normalized = {
      ...c,
      sameSite: (() => {
        const v = (c.sameSite || '').toLowerCase();
        if (v === 'strict') return 'Strict';
        if (v === 'lax') return 'Lax';
        return 'None'; // default fallback — NOT 'Lax'
      })(),
    };

    // Playwright expects `expires` as unix timestamp (seconds) when present.
    // For session cookies, remove `expires` entirely instead of passing -1/0.
    const exp = Number(normalized.expires);
    if (!Number.isFinite(exp) || exp <= 0) {
      delete normalized.expires;
    }

    return normalized;
  });

  const deduped = [];
  const seen = new Set();
  const addUnique = (cookie) => {
    if (!cookie || !cookie.name || !cookie.domain || !cookie.path) return;
    const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(cookie);
  };

  // Keep originals first.
  for (const cookie of normalizedList) {
    addUnique(cookie);
  }

  // Harden LinkedIn auth cookie domain coverage to survive redirect/domain hops.
  for (const cookie of normalizedList) {
    const name = String(cookie?.name || '');
    if (name !== 'li_at' && name !== 'JSESSIONID') continue;
    const domain = String(cookie?.domain || '').toLowerCase();
    if (!domain.includes('linkedin.com')) continue;

    if (domain.includes('www.linkedin.com')) {
      addUnique({ ...cookie, domain: '.linkedin.com' });
    } else if (domain === '.linkedin.com' || domain === 'linkedin.com') {
      addUnique({ ...cookie, domain: '.www.linkedin.com' });
    }
  }

  return deduped;
}

function getLinkedInCookieFlags(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  const linkedIn = list.filter((c) => String(c?.domain || '').includes('linkedin.com'));
  return {
    total: linkedIn.length,
    hasLiAt: linkedIn.some((c) => c?.name === 'li_at' && c?.value),
    hasJsession: linkedIn.some((c) => c?.name === 'JSESSIONID' && c?.value),
  };
}

function hasRequiredLinkedInSessionCookies(cookies) {
  const flags = getLinkedInCookieFlags(cookies);
  return Boolean(flags.hasLiAt && flags.hasJsession);
}

async function saveCookies(accountId, cookies, options = {}) {
  const {
    requireAuthCookies = false,
    skipIfMissingAuthCookies = false,
    source = 'unknown',
  } = options || {};

  const flags = getLinkedInCookieFlags(cookies);
  const missingRequired = !flags.hasLiAt || !flags.hasJsession;
  if (missingRequired && (requireAuthCookies || skipIfMissingAuthCookies)) {
    const reason = `li_at=${flags.hasLiAt}, JSESSIONID=${flags.hasJsession}, linkedinCookieCount=${flags.total}`;
    if (requireAuthCookies) {
      const err = new Error(`Required LinkedIn cookies missing for ${accountId} (${reason}).`);
      err.code = 'COOKIES_MISSING';
      err.status = 400;
      throw err;
    }
    console.warn(
      `[Session] Skipping cookie refresh for ${accountId} from ${source}; required LinkedIn cookies missing (${reason}).`
    );
    return false;
  }

  const normalised = normaliseCookies(cookies);
  const now        = Date.now();
  knownAccountIds.add(accountId);
  saveSessionToDisk(accountId, normalised, now);

  try {
    const redis = getRedis();
    const encrypted = encrypt(JSON.stringify(normalised));
    await withRedisTimeout(Promise.all([
      redis.set(`session:${accountId}`, encrypted, 'EX', SESSION_TTL),
      redis.set(`session:meta:${accountId}`, JSON.stringify({ savedAt: now }), 'EX', META_TTL),
      redis.sadd('session:accounts', accountId),
    ]), 'saveCookies');

    // Keep memory store hot for local dev even when Redis is reachable.
    memorySessions.set(accountId, normalised);
    memoryMeta.set(accountId, { savedAt: now });
  } catch (err) {
    warnRedisFallback(err);
    memorySessions.set(accountId, normalised);
    memoryMeta.set(accountId, { savedAt: now });
  }
  return true;
}

async function loadCookies(accountId) {
  try {
    const redis = getRedis();
    const raw   = await withRedisTimeout(redis.get(`session:${accountId}`), 'loadCookies');
    if (raw) knownAccountIds.add(accountId);
    if (!raw) {
      const diskCookies = loadSessionFromDisk(accountId);
      if (diskCookies) {
        knownAccountIds.add(accountId);
        const normalized = normaliseCookies(diskCookies);
        memorySessions.set(accountId, normalized);
        return normalized;
      }
      const fromMemory = memorySessions.get(accountId);
      return fromMemory ? normaliseCookies(fromMemory) : null;
    }
    return normaliseCookies(JSON.parse(decrypt(raw)));
  } catch (err) {
    warnRedisFallback(err);
    const diskCookies = loadSessionFromDisk(accountId);
    if (diskCookies) {
      knownAccountIds.add(accountId);
      const normalized = normaliseCookies(diskCookies);
      memorySessions.set(accountId, normalized);
      return normalized;
    }
    const fromMemory = memorySessions.get(accountId);
    return fromMemory ? normaliseCookies(fromMemory) : null;
  }
}

async function sessionMeta(accountId) {
  try {
    const redis = getRedis();
    const raw   = await withRedisTimeout(redis.get(`session:meta:${accountId}`), 'sessionMeta');
    if (raw) knownAccountIds.add(accountId);
    const meta  = raw
      ? JSON.parse(raw)
      : (memoryMeta.get(accountId) || loadMetaFromDisk(accountId));
    if (!meta) return null;
    const ageMs = Date.now() - meta.savedAt;
    return { savedAt: meta.savedAt, ageSeconds: Math.floor(ageMs / 1000) };
  } catch (err) {
    warnRedisFallback(err);
    const meta = memoryMeta.get(accountId) || loadMetaFromDisk(accountId);
    if (!meta) return null;
    const ageMs = Date.now() - meta.savedAt;
    return { savedAt: meta.savedAt, ageSeconds: Math.floor(ageMs / 1000) };
  }
}

async function deleteSession(accountId) {
  try {
    const redis = getRedis();
    await withRedisTimeout(Promise.all([
      redis.del(`session:${accountId}`, `session:meta:${accountId}`),
      redis.srem('session:accounts', accountId),
    ]), 'deleteSession');
  } catch (err) {
    warnRedisFallback(err);
  }
  memorySessions.delete(accountId);
  memoryMeta.delete(accountId);
  knownAccountIds.delete(accountId);
  deleteSessionFromDisk(accountId);
}

async function listKnownAccountIds() {
  const ids = new Set();

  for (const id of configuredAccountIds()) ids.add(id);
  for (const id of knownAccountIds) ids.add(id);
  for (const id of memorySessions.keys()) ids.add(id);
  for (const id of memoryMeta.keys()) ids.add(id);
  for (const id of listAccountIdsFromDisk()) ids.add(id);

  try {
    const redis = getRedis();
    const indexed = await withRedisTimeout(redis.smembers('session:accounts'), 'listKnownAccountIds');
    for (const id of indexed) {
      if (id && String(id).trim()) ids.add(String(id).trim());
    }
  } catch (err) {
    warnRedisFallback(err);
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

module.exports = {
  saveCookies,
  loadCookies,
  sessionMeta,
  deleteSession,
  listKnownAccountIds,
  hasRequiredLinkedInSessionCookies,
  getLinkedInCookieFlags,
};
