'use strict';

// Rotating proxy pool with mandatory health-gating.
//
// ⚠️ SECURITY: free/public proxies can MITM HTTPS and log everything passing
// through them — including LinkedIn `li_at` session cookies. Only point this at
// proxies you trust. The health-gate filters dead/datacenter/burned proxies but
// CANNOT detect a malicious-but-working proxy. For production, use paid
// residential/ISP proxies. This system works with any source; "free" is just a
// weak source.
//
// Sources (any/all):
//   PROXY_POOL       = comma/newline list of proxy URLs
//   PROXY_POOL_URL   = an http(s) endpoint returning a newline list of host:port
//   PROXY_POOL_FILE  = a path to a newline list
//
// Health-gate (a proxy must pass to enter the healthy set):
//   - reachable (egress IP resolved)
//   - NOT a hosting/datacenter IP (ip-api hosting flag false)  [PROXY_POOL_ALLOW_HOSTING=1 to relax]
//   - linkedin.com reachable without redirect
//
// State in Redis:
//   proxypool:healthy           ZSET member=proxyUrl score=health(0..100)
//   proxypool:assign:<account>  sticky assignment (string), TTL
//   proxypool:cooldown:<sha>    bad proxy cooldown (string), TTL

const crypto = require('crypto');
const { getRedis } = require('../redisClient');

// Lazy-load Playwright's request module so a missing/broken install can NEVER
// crash this file at require-time and take down worker boot. If neither package
// resolves, checkProxy() simply fails-soft (returns dead) and the pool stays empty.
let _request = null;
function getRequest() {
  if (_request) return _request;
  try {
    const lib = process.env.USE_REBROWSER_PLAYWRIGHT === '1'
      ? require('rebrowser-playwright')
      : require('playwright-core');
    _request = lib.request;
    return _request;
  } catch (e) {
    try { _request = require('playwright-core').request; return _request; } catch { /* */ }
    console.warn('[proxyPool] Playwright request module unavailable:', e.message);
    return null;
  }
}

const HEALTHY_KEY = 'proxypool:healthy';
const ASSIGN_TTL_S = parseInt(process.env.PROXY_POOL_ASSIGN_TTL_S || '1800', 10); // 30m sticky
const COOLDOWN_S = parseInt(process.env.PROXY_POOL_COOLDOWN_S || '3600', 10);
const ALLOW_HOSTING = String(process.env.PROXY_POOL_ALLOW_HOSTING || '') === '1';
const CHECK_CONCURRENCY = parseInt(process.env.PROXY_POOL_CHECK_CONCURRENCY || '5', 10);
const CHECK_TIMEOUT_MS = parseInt(process.env.PROXY_POOL_CHECK_TIMEOUT_MS || '15000', 10);

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const memHealthy = new Map(); // fallback when Redis down: proxyUrl -> score

function poolEnabled() {
  return Boolean(process.env.PROXY_POOL || process.env.PROXY_POOL_URL || process.env.PROXY_POOL_FILE);
}

function normalizeCandidate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Accept full URLs, or bare host:port (default to http).
  if (/^(https?|socks\d?):\/\//i.test(s)) return s;
  if (/^[^\s:]+:\d+$/.test(s)) return `http://${s}`;
  return null;
}

async function loadCandidates() {
  const out = new Set();
  for (const line of String(process.env.PROXY_POOL || '').split(/[\n,]/)) {
    const c = normalizeCandidate(line); if (c) out.add(c);
  }
  if (process.env.PROXY_POOL_FILE) {
    try {
      const fs = require('fs');
      for (const line of fs.readFileSync(process.env.PROXY_POOL_FILE, 'utf8').split(/\r?\n/)) {
        const c = normalizeCandidate(line); if (c) out.add(c);
      }
    } catch (e) { console.warn('[proxyPool] PROXY_POOL_FILE read failed:', e.message); }
  }
  if (process.env.PROXY_POOL_URL) {
    const request = getRequest();
    if (!request) return [...out]; // graceful: no playwright -> stop here
    try {
      const ctx = await request.newContext({ timeout: 15000 });
      const res = await ctx.get(process.env.PROXY_POOL_URL);
      if (res.ok()) {
        for (const line of (await res.text()).split(/\r?\n/)) {
          const c = normalizeCandidate(line); if (c) out.add(c);
        }
      }
      await ctx.dispose();
    } catch (e) { console.warn('[proxyPool] PROXY_POOL_URL fetch failed:', e.message); }
  }
  return [...out];
}

function proxyOption(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    const server = `${u.protocol}//${u.host}`;
    if (u.username && !/^socks/i.test(u.protocol)) {
      return { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') };
    }
    return { server };
  } catch { return { server: proxyUrl }; }
}

// Lightweight health check via Playwright APIRequest (no full Chromium launch).
async function checkProxy(proxyUrl) {
  const result = { proxyUrl, alive: false, egressIp: null, hosting: null, linkedinOk: false, latencyMs: null, score: 0 };
  const request = getRequest();
  if (!request) return result; // fail-soft when Playwright unavailable
  const started = Date.now();
  let ctx;
  try {
    ctx = await request.newContext({ proxy: proxyOption(proxyUrl), timeout: CHECK_TIMEOUT_MS, ignoreHTTPSErrors: true });
    const ipRes = await ctx.get('https://api.ipify.org/?format=json');
    if (ipRes.ok()) { try { result.egressIp = (await ipRes.json()).ip; result.alive = true; } catch { /* */ } }
    if (!result.alive) return result;

    const geoRes = await ctx.get('http://ip-api.com/json/?fields=status,hosting,proxy,country');
    if (geoRes.ok()) { try { const g = await geoRes.json(); result.hosting = !!g.hosting || !!g.proxy; } catch { /* */ } }

    const liRes = await ctx.get('https://www.linkedin.com/', { maxRedirects: 0 }).catch((e) => ({ _err: e.message }));
    if (liRes && !liRes._err) {
      const status = liRes.status();
      // 200 = ok; 3xx to authwall/login = blocked. APIRequest follows redirects
      // unless maxRedirects:0 — then a 3xx status means redirected.
      result.linkedinOk = status >= 200 && status < 300;
    }
    result.latencyMs = Date.now() - started;
    // Score: reachable + linkedin ok + residential + low latency.
    let score = 0;
    if (result.alive) score += 30;
    if (result.linkedinOk) score += 40;
    if (result.hosting === false) score += 20;
    if (result.latencyMs && result.latencyMs < 4000) score += 10;
    result.score = score;
    return result;
  } catch {
    return result;
  } finally {
    if (ctx) await ctx.dispose().catch(() => {});
  }
}

function passesGate(r) {
  if (!r.alive) return false;
  if (!r.linkedinOk) return false;
  if (!ALLOW_HOSTING && r.hosting === true) return false;
  return true;
}

// Health-check candidates (bounded concurrency) and rebuild the healthy ZSET.
async function refresh() {
  if (!poolEnabled()) return { checked: 0, healthy: 0 };
  const candidates = await loadCandidates();
  if (candidates.length === 0) return { checked: 0, healthy: 0 };

  const healthy = [];
  for (let i = 0; i < candidates.length; i += CHECK_CONCURRENCY) {
    const batch = candidates.slice(i, i + CHECK_CONCURRENCY);
    const results = await Promise.all(batch.map((p) => checkProxy(p)));
    for (const r of results) if (passesGate(r)) healthy.push(r);
  }

  // Publish healthy set.
  try {
    const redis = getRedis();
    const pipe = redis.multi();
    pipe.del(HEALTHY_KEY);
    for (const r of healthy) pipe.zadd(HEALTHY_KEY, r.score, r.proxyUrl);
    pipe.expire(HEALTHY_KEY, 2 * 3600);
    await pipe.exec();
  } catch {
    memHealthy.clear();
    for (const r of healthy) memHealthy.set(r.proxyUrl, r.score);
  }
  console.log(`[proxyPool] refresh: ${candidates.length} checked, ${healthy.length} healthy`);
  return { checked: candidates.length, healthy: healthy.length };
}

async function inCooldown(proxyUrl) {
  try { return (await getRedis().ttl(`proxypool:cooldown:${sha(proxyUrl)}`)) > 0; }
  catch { return false; }
}

async function topHealthy() {
  try {
    const arr = await getRedis().zrevrange(HEALTHY_KEY, 0, 19);
    return arr || [];
  } catch {
    return [...memHealthy.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }
}

/**
 * Pick a proxy for an account: sticky if its current assignment is still healthy
 * and not in cooldown, else the best available healthy proxy. Returns null if
 * the pool has nothing healthy (caller decides: refuse vs direct).
 */
async function pick(accountId) {
  if (!poolEnabled()) return null;
  const redis = (() => { try { return getRedis(); } catch { return null; } })();
  const assignKey = `proxypool:assign:${accountId}`;

  // Sticky
  if (redis) {
    const current = await redis.get(assignKey).catch(() => null);
    if (current && !(await inCooldown(current))) {
      const stillHealthy = (await redis.zscore(HEALTHY_KEY, current).catch(() => null)) != null;
      if (stillHealthy) { await redis.expire(assignKey, ASSIGN_TTL_S).catch(() => {}); return current; }
    }
  }

  // Choose best healthy not in cooldown.
  const candidates = await topHealthy();
  for (const p of candidates) {
    if (await inCooldown(p)) continue;
    if (redis) await redis.set(assignKey, p, 'EX', ASSIGN_TTL_S).catch(() => {});
    return p;
  }
  return null;
}

/** Demote a proxy that failed for an account: cooldown + drop from healthy. */
async function reportFailure(accountId, proxyUrl) {
  if (!proxyUrl) return;
  try {
    const redis = getRedis();
    await redis.set(`proxypool:cooldown:${sha(proxyUrl)}`, '1', 'EX', COOLDOWN_S).catch(() => {});
    await redis.zrem(HEALTHY_KEY, proxyUrl).catch(() => {});
    if (accountId) await redis.del(`proxypool:assign:${accountId}`).catch(() => {});
  } catch { memHealthy.delete(proxyUrl); }
}

async function stats() {
  try {
    const redis = getRedis();
    const healthy = await redis.zrevrange(HEALTHY_KEY, 0, -1, 'WITHSCORES').catch(() => []);
    const list = [];
    for (let i = 0; i < healthy.length; i += 2) list.push({ proxy: healthy[i].replace(/\/\/[^@]*@/, '//***@'), score: Number(healthy[i + 1]) });
    return { enabled: poolEnabled(), healthy: list.length, top: list.slice(0, 10) };
  } catch {
    return { enabled: poolEnabled(), healthy: memHealthy.size };
  }
}

module.exports = { poolEnabled, refresh, pick, reportFailure, checkProxy, stats, _internals: { normalizeCandidate, passesGate, proxyOption } };
