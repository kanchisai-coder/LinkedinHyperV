'use strict';

// Encrypted credential store. Same AES-256-GCM + SESSION_ENCRYPTION_KEY scheme
// as cookies in session.js, intentionally — one key, one rotation surface.
// Plaintext never leaves this module; consumers get back { email, password }
// only at the moment of use and must not retain it.

const crypto = require('crypto');
const { getRedis } = require('../redisClient');

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const TTL_SECONDS = parseInt(process.env.CRED_STORE_TTL_S || `${90 * 24 * 3600}`, 10); // 90 days

function getKey() {
  const raw = process.env.SESSION_ENCRYPTION_KEY || '';
  if (!raw) throw new Error('SESSION_ENCRYPTION_KEY is not set');
  // Accept hex (64 chars) or raw bytes ≥32; pad/truncate to 32 bytes via sha256
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: enc.toString('hex'),
    v: 1,
  });
}

function decrypt(payload) {
  const { iv, tag, data } = JSON.parse(payload);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
}

const keyFor = (accountId) => `credentials:${accountId}`;
const metaKeyFor = (accountId) => `credentials:meta:${accountId}`;

/**
 * Persist credentials for an account. Refuses if SESSION_ENCRYPTION_KEY is
 * missing (we never want plaintext on disk).
 */
async function save(accountId, { email, password, consentSource = 'novnc-connect' }) {
  if (!accountId) throw new Error('save: accountId required');
  if (!email || !password) throw new Error('save: email and password required');
  const blob = encrypt(JSON.stringify({ email, password, capturedAt: new Date().toISOString() }));
  const redis = getRedis();
  await redis.set(keyFor(accountId), blob, 'EX', TTL_SECONDS);
  await redis.hset(metaKeyFor(accountId), {
    has: '1',
    capturedAt: new Date().toISOString(),
    consentSource,
    lastUsedAt: '',
    lastError: '',
    needsPasswordUpdate: '0',
  });
  await redis.expire(metaKeyFor(accountId), TTL_SECONDS);
  return { ok: true, ttlDays: Math.floor(TTL_SECONDS / 86400) };
}

/**
 * Load credentials for use. DO NOT log the return value. Caller must use
 * immediately and not retain.
 */
async function load(accountId) {
  if (!accountId) return null;
  const redis = getRedis();
  const blob = await redis.get(keyFor(accountId)).catch(() => null);
  if (!blob) return null;
  try {
    return JSON.parse(decrypt(blob));
  } catch {
    return null;
  }
}

/** Public-safe status — never returns plaintext. */
async function status(accountId) {
  const redis = getRedis();
  const meta = await redis.hgetall(metaKeyFor(accountId)).catch(() => ({}));
  return {
    hasStoredCredentials: meta.has === '1',
    capturedAt: meta.capturedAt || null,
    lastUsedAt: meta.lastUsedAt || null,
    lastError: meta.lastError || null,
    needsPasswordUpdate: meta.needsPasswordUpdate === '1',
  };
}

async function markUsed(accountId, { ok, error = null } = {}) {
  const redis = getRedis();
  const updates = {
    lastUsedAt: new Date().toISOString(),
    lastError: ok ? '' : String(error || 'unknown'),
    needsPasswordUpdate: ok ? '0' : (String(error || '').toLowerCase().includes('wrong password') ? '1' : '0'),
  };
  await redis.hset(metaKeyFor(accountId), updates).catch(() => null);
}

async function remove(accountId) {
  const redis = getRedis();
  await redis.del(keyFor(accountId), metaKeyFor(accountId)).catch(() => null);
  return { ok: true };
}

module.exports = { save, load, status, markUsed, remove };
