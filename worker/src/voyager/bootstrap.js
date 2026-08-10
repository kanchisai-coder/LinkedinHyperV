'use strict';

// Boots the Voyager / realtime / event-bus / harvest / proxy-pool subsystems.
// Every step is wrapped in fail-safe boundaries: a broken/missing module here
// MUST NEVER take down worker boot (which would 502 the dashboard). On any
// error the affected subsystem stays off, the worker still serves API + sync.

const SAFE = (name, fn) => { try { return fn(); } catch (e) { console.warn(`[bootstrap] ${name} skipped:`, e.message); return null; } };
function safeRequire(name, path) {
  try { return require(path); }
  catch (e) { console.warn(`[bootstrap] require ${name} failed (subsystem disabled):`, e.message); return null; }
}

// Lazy-require so a bad module load can never crash this file at require-time.
const webhookDispatcher    = safeRequire('webhookDispatcher',    '../events/webhookDispatcher');
const persistenceConsumer  = safeRequire('persistenceConsumer',  '../events/persistenceConsumer');
const realtimeManager      = safeRequire('realtimeManager',      './realtimeManager');
const harvestRunner        = safeRequire('harvestRunner',        '../harvest/harvestRunner');
const proxyPool            = safeRequire('proxyPool',            '../proxy/proxyPool');
const sessionMod           = safeRequire('session',              '../session');
const listKnownAccountIds  = sessionMod && sessionMod.listKnownAccountIds
  ? sessionMod.listKnownAccountIds
  : async () => [];

let started = false;
let webhookHandle = null;
let persistenceHandle = null;
let realtimeRefreshTimer = null;
let harvestHandle = null;
let proxyPoolTimer = null;

async function refreshRealtime() {
  if (!realtimeManager || !realtimeManager.realtimeEnabled || !realtimeManager.realtimeEnabled()) return;
  let ids = [];
  try { ids = await listKnownAccountIds(); } catch { ids = []; }
  for (const accountId of ids) {
    if (accountId === 'connect') continue;
    await realtimeManager.startForAccount(accountId).catch((e) =>
      console.warn(`[bootstrap] realtime start ${accountId}: ${e.message}`));
  }
}

async function boot() {
  if (started) return;
  started = true;

  // Webhook dispatcher (idle if no endpoints configured).
  if (webhookDispatcher && webhookDispatcher.start) {
    webhookHandle = SAFE('webhookDispatcher.start', () => webhookDispatcher.start());
  }
  // Persistence consumer — writes realtime events to Postgres.
  if (persistenceConsumer && persistenceConsumer.start) {
    persistenceHandle = SAFE('persistenceConsumer.start', () => persistenceConsumer.start());
  }

  // Realtime streams (USE_REALTIME=1).
  if (realtimeManager && realtimeManager.realtimeEnabled && realtimeManager.realtimeEnabled()) {
    console.log('[bootstrap] USE_REALTIME=1 — starting realtime streams');
    await refreshRealtime().catch((e) => console.warn('[bootstrap] realtime refresh:', e.message));
    realtimeRefreshTimer = setInterval(() => { refreshRealtime().catch(() => {}); }, 60_000);
    realtimeRefreshTimer.unref?.();
  } else {
    console.log('[bootstrap] USE_REALTIME not set — realtime disabled (polling only)');
  }

  // Harvest drip loop (ENABLE_BACKFILL=1).
  if (harvestRunner && harvestRunner.start) {
    harvestHandle = SAFE('harvestRunner.start', () => harvestRunner.start());
  }

  // Rotating proxy pool. Initial refresh is fired ASYNC and DEFERRED so worker
  // boot is never delayed/blocked by candidate health checks.
  if (proxyPool && proxyPool.poolEnabled && proxyPool.poolEnabled()) {
    console.warn('[bootstrap] PROXY POOL enabled — async refresh deferred 5s. '
      + 'SECURITY: untrusted proxies can intercept LinkedIn session cookies; use trusted/paid residential in production.');
    const everyMs = parseInt(process.env.PROXY_POOL_REFRESH_MS || '600000', 10);
    setTimeout(() => {
      proxyPool.refresh().catch((e) => console.warn('[bootstrap] proxy pool initial refresh:', e.message));
    }, 5000).unref?.();
    proxyPoolTimer = setInterval(() => { proxyPool.refresh().catch(() => {}); }, everyMs);
    proxyPoolTimer.unref?.();
  } else {
    console.log('[bootstrap] proxy pool not configured (set PROXY_POOL / PROXY_POOL_URL)');
  }
}

async function shutdown() {
  if (realtimeRefreshTimer) clearInterval(realtimeRefreshTimer);
  if (realtimeManager && realtimeManager.stopAll) await realtimeManager.stopAll().catch(() => {});
  if (webhookHandle && webhookHandle.stop) await webhookHandle.stop().catch(() => {});
  if (persistenceHandle && persistenceHandle.stop) await persistenceHandle.stop().catch(() => {});
  if (harvestHandle && harvestHandle.stop) harvestHandle.stop();
  if (proxyPoolTimer) clearInterval(proxyPoolTimer);
  started = false;
}

module.exports = { boot, shutdown };
