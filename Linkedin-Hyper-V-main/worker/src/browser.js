'use strict';

const fs = require('fs');
const { chromium } = process.env.USE_REBROWSER_PLAYWRIGHT === '1'
  ? require('rebrowser-playwright')
  : require('playwright-core');
const { normalizeAccountKey } = require('./accountIdentity');
const { fingerprintForAccount, resolveProxyForAccount, resolveProxyForAccountAsync } = require('./antiBan');

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--use-gl=disabled',
  '--window-size=1366,768',
  '--start-maximized',
  '--lang=en-US,en',
  '--disable-extensions',
  '--disable-infobars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

// PERF (Phase 2.1): bump default idle TTL from 60s → 5min. The pool already
// reuses contexts (see getAccountContext below), and the previous TTL forced a
// recycle mid-action if any single step exceeded ~60s — costing 10–15s relaunch
// on every recycle. Override with BROWSER_CONTEXT_TTL_MS env if needed.
const DEFAULT_CONTEXT_TTL_MS = Math.max(
  15_000,
  parseInt(process.env.BROWSER_CONTEXT_TTL_MS || '300000', 10)
);
// Skip the cost of probing a context's liveness if we used it very recently.
const CONTEXT_PROBE_INTERVAL_MS = Math.max(
  5_000,
  parseInt(process.env.BROWSER_PROBE_INTERVAL_MS || '30000', 10)
);
const MAX_ACTIVE_CONTEXTS = Math.max(
  1,
  parseInt(process.env.BROWSER_MAX_ACTIVE_CONTEXTS || '1', 10)
);
const MAX_PAGES_PER_ACCOUNT = Math.max(
  1,
  parseInt(process.env.BROWSER_MAX_PAGES_PER_ACCOUNT || '1', 10)
);

/**
 * Launch a Chrome browser instance for LinkedIn sync.
 * @param {string|undefined} proxyUrl Optional proxy e.g. "http://user:pass@host:port"
 */
function resolveChromeExecutablePath() {
  // Default to bundled Playwright browser for protocol compatibility.
  // Set BROWSER_USE_SYSTEM_CHROME=1 only when you explicitly need system Chrome.
  if (process.env.BROWSER_USE_SYSTEM_CHROME !== '1') {
    return null;
  }

  if (process.platform === 'linux') {
    const candidate = '/usr/bin/google-chrome-stable';
    return fs.existsSync(candidate) ? candidate : null;
  }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA
        ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
        : null,
    ].filter(Boolean);

    return candidates.find((p) => fs.existsSync(p)) || null;
  }

  return null;
}

// Chromium does NOT read credentials embedded in the proxy URL
// (http://user:pass@host:port) — Playwright requires them as SEPARATE
// username/password fields, or auth silently fails with HTTP 407. It also does
// not support authenticated SOCKS5 at all. This splits a credentialed URL into
// the shape Playwright needs.
function buildProxyOption(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    // A schemeless "host:port" or "user:pass@host:port" would make new URL()
    // parse the host (or user) as the protocol, yielding a broken server and
    // silently dropping the proxy — egressing from the real datacenter IP.
    // Normalize to an http:// scheme first when none is present.
    const normalized = /^(https?|socks\d?):\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`;
    const u = new URL(normalized);
    const username = decodeURIComponent(u.username || '');
    const password = decodeURIComponent(u.password || '');
    // server must NOT contain credentials.
    const server = `${u.protocol}//${u.host}`;
    if (/^socks/i.test(u.protocol) && (username || password)) {
      console.warn('[browser] authenticated SOCKS5 proxies are NOT supported by Chromium — use an HTTP/HTTPS residential proxy, or an IP-whitelisted SOCKS5.');
    }
    return username
      ? { server, username, password }
      : { server };
  } catch {
    // Not a parseable URL — pass through as-is (e.g. "host:port").
    return { server: proxyUrl };
  }
}

async function createBrowser(proxyUrl, options = {}) {
const headless = typeof options.headless === 'boolean'
  ? options.headless
  : process.env.BROWSER_HEADLESS === '1' ? true : false;
  const opts = {
    headless,
    args: CHROME_ARGS,
  };

  const executablePath = resolveChromeExecutablePath();
  if (executablePath) {
    opts.executablePath = executablePath;
  }

  const proxyOption = buildProxyOption(proxyUrl);
  if (proxyOption) opts.proxy = proxyOption;
  return chromium.launch(opts);
}

/**
 * Create a normal browser context for LinkedIn sync.
 * Must be called before any page navigation.
 *
 * ANTI-BAN: when an accountId is provided (passed through from getAccountContext),
 * use a deterministic per-account fingerprint instead of a shared hardcoded one.
 * Same accountId → same fingerprint forever (stability is more human than rotation).
 */
async function createContext(browser, options = {}) {
  const fp = options.accountId
    ? fingerprintForAccount(options.accountId, options.fingerprintOverrides || {})
    : {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
        colorScheme: 'light',
      };

  const context = await browser.newContext({
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    colorScheme: fp.colorScheme || 'light',
    deviceScaleFactor: fp.deviceScaleFactor || 1,
    hasTouch: !!fp.hasTouch,
    isMobile: !!fp.isMobile,
    javaScriptEnabled: true,
    permissions: ['notifications'],
  });

  // Keep actions bounded to avoid stuck playwright calls.
  context.setDefaultTimeout(60000);
  context.setDefaultNavigationTimeout(60000);

  if (options.blockAssets !== false) {
    // Keep authenticated sessions closer to a normal browser: block only obviously heavy media assets.
    await context.route('**/*.{mp4,webm,avi,mov,mkv}', (r) => r.abort());
  }

  return context;
}

const activeContexts = new Map();
const accountLocks = new Map();
const browserStats = new Map();

function getStatsEntry(accountId) {
  const key = normalizeAccountKey(accountId) || 'default';
  if (!browserStats.has(key)) {
    browserStats.set(key, {
      accountId: key,
      activeContexts: 0,
      openPages: 0,
      pagesOpened: 0,
      browserRecycles: 0,
      totalContextMs: 0,
      lastBrowserFatalError: null,
      updatedAt: null,
    });
  }
  return browserStats.get(key);
}

function markStatsUpdated(stats) {
  stats.updatedAt = new Date().toISOString();
}

function recordBrowserFatal(accountId, error) {
  const stats = getStatsEntry(accountId);
  stats.browserRecycles += 1;
  stats.lastBrowserFatalError = String(error || 'Browser context recycled');
  markStatsUpdated(stats);
}

function getBrowserBudgetSnapshot(accountId) {
  const key = normalizeAccountKey(accountId) || 'default';
  const stats = getStatsEntry(key);
  const active = activeContexts.get(key);
  const totalContextMs = stats.totalContextMs + (active?.createdAt ? Math.max(0, Date.now() - active.createdAt) : 0);
  return {
    accountId: key,
    activeContexts: active ? 1 : 0,
    openPages: active?.openPages ?? stats.openPages ?? 0,
    pagesOpened: stats.pagesOpened,
    browserRecycles: stats.browserRecycles,
    browserMinutesEstimate: Number((totalContextMs / 60_000).toFixed(2)),
    lastBrowserFatalError: stats.lastBrowserFatalError,
    updatedAt: stats.updatedAt,
  };
}

function getAllBrowserBudgetSnapshots() {
  const keys = new Set([...browserStats.keys(), ...activeContexts.keys()]);
  return Array.from(keys).map((accountId) => getBrowserBudgetSnapshot(accountId));
}

async function trimContextPages(context, maxPages) {
  const pages = context.pages();
  if (pages.length < maxPages) return;
  const pagesToClose = pages.slice(0, Math.max(0, pages.length - maxPages + 1));
  await Promise.all(pagesToClose.map((page) => page.close().catch(() => {})));
}

async function withAccountLock(accountId, fn) {
  const key = normalizeAccountKey(accountId) || 'default';
  let lock = accountLocks.get(key);
  if (!lock) {
    lock = { locked: false, queue: [] };
    accountLocks.set(key, lock);
  }

  await new Promise((resolve) => {
    if (!lock.locked) {
      lock.locked = true;
      resolve();
      return;
    }
    lock.queue.push(resolve);
  });

  try {
    return await fn();
  } finally {
    const next = lock.queue.shift();
    if (next) {
      next();
    } else {
      lock.locked = false;
      if (lock.queue.length === 0) {
        accountLocks.delete(key);
      }
    }
  }
}

function evictContext(accountId, expectedEntry) {
  const key = normalizeAccountKey(accountId) || 'default';
  const current = activeContexts.get(key);
  if (!current) return;
  if (expectedEntry && current !== expectedEntry) return;
  clearTimeout(current.timer);
  activeContexts.delete(key);
  const stats = getStatsEntry(key);
  stats.activeContexts = 0;
  stats.openPages = 0;
  if (current.createdAt) {
    stats.totalContextMs += Math.max(0, Date.now() - current.createdAt);
  }
  markStatsUpdated(stats);
}

async function getAccountContext(accountId, proxyUrl, options = {}) {
  const key = normalizeAccountKey(accountId) || 'default';
  if (options.forceFresh) {
    await cleanupContext(key);
  }

  const existing = activeContexts.get(key);
  if (existing) {
    if (!existing.browser?.isConnected()) {
      await cleanupContext(key);
    } else {
      // PERF (Phase 2.1): the previous code opened+closed a probe page on EVERY
      // acquire, which is ~50–150ms of pure overhead for hot loops. Only probe
      // if we haven't successfully used this context in the last 30s; otherwise
      // trust the existing connection and let the next real action surface a
      // failure naturally.
      const idleMs = Date.now() - (existing.lastUsed || 0);
      if (idleMs >= CONTEXT_PROBE_INTERVAL_MS) {
        try {
          const probePage = await existing.context.newPage();
          await probePage.close().catch(() => {});
        } catch (probeErr) {
          const message = probeErr instanceof Error ? probeErr.message : String(probeErr);
          console.warn(`[Browser] Recycling stale context for ${accountId}: ${message}`);
          recordBrowserFatal(key, message);
          await cleanupContext(key);
        }
      }
    }
  }

  const refreshed = activeContexts.get(key);
  if (refreshed) {
      clearTimeout(refreshed.timer);
      refreshed.lastUsed = Date.now();
      refreshed.timer = setTimeout(() => cleanupContext(key), options.autoCleanupMs || DEFAULT_CONTEXT_TTL_MS);
      return { browser: refreshed.browser, context: refreshed.context, cookiesLoaded: true };
  }

  // Keep the sync browser budget intentionally tight on small hosts.
  if (activeContexts.size >= MAX_ACTIVE_CONTEXTS) {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, ctx] of activeContexts.entries()) {
      if (ctx.lastUsed < oldestTime) {
        oldestTime = ctx.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId) {
      await cleanupContext(oldestId);
    }
  }

  // ANTI-BAN: pick a per-account proxy if one is configured (PROXY_FOR_<accountId>).
  // Falls back to the proxyUrl argument, then to PROXY_URL env. Refuses direct
  // egress if ANTIBAN_REQUIRE_PROXY=1.
  let effectiveProxy = proxyUrl;
  try {
    // Async: also consults the rotating proxy pool when PROXY_FOR_<id>="pool"
    // or PROXY_POOL_MODE=1. Falls back to sync env resolution on any error.
    const perAccountProxy = await resolveProxyForAccountAsync(accountId);
    if (perAccountProxy) effectiveProxy = perAccountProxy;
  } catch (proxyErr) {
    if (proxyErr.code === 'PROXY_REQUIRED') throw proxyErr;
  }
  // Remember which proxy this context used, so failures can demote it from the pool.
  const usedProxy = effectiveProxy;

  const browser = await createBrowser(effectiveProxy, { headless: options.headless });
  const context = await createContext(browser, {
    blockAssets: options.blockAssets,
    accountId, // ANTI-BAN: drives per-account fingerprint inside createContext
    fingerprintOverrides: options.fingerprintOverrides,
  });

  const entry = {
    browser,
    context,
    lastUsed: Date.now(),
    createdAt: Date.now(),
    openPages: 0,
    timer: null,
    proxyUrl: usedProxy || null,
  };
  entry.timer = setTimeout(() => cleanupContext(key), options.autoCleanupMs || DEFAULT_CONTEXT_TTL_MS);

  const originalNewPage = context.newPage.bind(context);
  context.newPage = async (...args) => {
    await trimContextPages(context, MAX_PAGES_PER_ACCOUNT);
    const page = await originalNewPage(...args);
    entry.openPages = context.pages().length;
    const stats = getStatsEntry(key);
    stats.activeContexts = 1;
    stats.openPages = entry.openPages;
    stats.pagesOpened += 1;
    markStatsUpdated(stats);

    page.on('close', () => {
      entry.openPages = Math.max(0, context.pages().length);
      const currentStats = getStatsEntry(key);
      currentStats.openPages = entry.openPages;
      markStatsUpdated(currentStats);
    });

    return page;
  };

  browser.on('disconnected', () => evictContext(key, entry));
  context.on('close', () => evictContext(key, entry));

  activeContexts.set(key, entry);
  const stats = getStatsEntry(key);
  stats.activeContexts = 1;
  stats.openPages = 0;
  markStatsUpdated(stats);

  return { browser, context, cookiesLoaded: false };
}

async function cleanupContext(accountId) {
  const key = normalizeAccountKey(accountId) || 'default';
  const existing = activeContexts.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    activeContexts.delete(key);
    await existing.context.close().catch(() => {});
    await existing.browser.close().catch(() => {});
  }
}

async function cleanupAllContexts() {
  for (const accountId of activeContexts.keys()) {
    await cleanupContext(accountId);
  }
}

process.on('SIGTERM', async () => {
  await cleanupAllContexts();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await cleanupAllContexts();
  process.exit(0);
});

module.exports = {
  createBrowser,
  createContext,
  getAccountContext,
  cleanupContext,
  cleanupAllContexts,
  withAccountLock,
  getBrowserBudgetSnapshot,
  getAllBrowserBudgetSnapshots,
  recordBrowserFatal,
};
