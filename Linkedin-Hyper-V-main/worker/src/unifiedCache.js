'use strict';

const crypto = require('crypto');
const { getRedis } = require('./redisClient');

const DEFAULT_TTL_SECONDS = 15;
const VERSION_PREFIX = 'cachever';

function stableDigest(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

async function getVersion(scope) {
  const redis = getRedis();
  const raw = await redis.get(`${VERSION_PREFIX}:${scope}`).catch(() => null);
  return String(raw || '0');
}

async function buildCacheKey(namespace, parts) {
  const digest = stableDigest(parts);
  const scopes = Array.isArray(parts?.scopes) ? parts.scopes : ['global'];
  const versions = await Promise.all(scopes.map((scope) => getVersion(scope)));
  return `${namespace}:${digest}:v${versions.join('.')}`;
}

async function getCachedJson(namespace, parts) {
  const redis = getRedis();
  const key = await buildCacheKey(namespace, parts);
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setCachedJson(namespace, parts, payload, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const redis = getRedis();
  const key = await buildCacheKey(namespace, parts);
  await redis.set(key, JSON.stringify(payload), 'EX', ttlSeconds).catch(() => null);
  return payload;
}

async function bumpScopes(scopes = []) {
  const redis = getRedis();
  await Promise.all(
    scopes
      .filter(Boolean)
      .map((scope) => redis.incr(`${VERSION_PREFIX}:${scope}`).catch(() => null))
  );
}

// PERF (Phase 3.2): when an accountId is provided, bump only the per-account
// scopes. Cache keys are built from the union of all scopes' versions, so a
// per-account bump still invalidates that account's keys — but leaves OTHER
// accounts' cached responses intact. Bumping `global`/category scopes is
// reserved for genuinely account-less invalidations (e.g. schema changes).
async function invalidateInboxCache(accountId = null) {
  const scopes = accountId
    ? [`account:${accountId}`, `inbox:${accountId}`]
    : ['global', 'inbox'];
  await bumpScopes(scopes);
}

async function invalidateThreadCache(accountId = null, conversationId = null) {
  if (!accountId && !conversationId) {
    await bumpScopes(['global', 'thread']);
    return;
  }
  const scopes = [];
  if (accountId) scopes.push(`account:${accountId}`);
  if (conversationId) scopes.push(`thread:${conversationId}`);
  await bumpScopes(scopes);
}

async function invalidateSyncStatusCache(accountId = null) {
  const scopes = accountId
    ? [`account:${accountId}`, `sync-status:${accountId}`]
    : ['global', 'sync-status'];
  await bumpScopes(scopes);
}

async function invalidateAccountCaches(accountId = null, conversationId = null) {
  await Promise.all([
    invalidateInboxCache(accountId),
    invalidateThreadCache(accountId, conversationId),
    invalidateSyncStatusCache(accountId),
  ]);
}

module.exports = {
  getCachedJson,
  setCachedJson,
  invalidateInboxCache,
  invalidateThreadCache,
  invalidateSyncStatusCache,
  invalidateAccountCaches,
};
