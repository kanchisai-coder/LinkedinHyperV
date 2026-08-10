'use strict';

// Flag-switched read router. When USE_VOYAGER_READS=1, inbox/thread reads go
// through the Voyager JSON API; on ANY non-rate-limit failure it automatically
// falls back to the DOM scraper so production never regresses. With the flag
// off, it's a transparent pass-through to the scraper.

const scraperProvider = require('../unified/LinkedInProvider');
const voyagerProvider = require('./voyagerProvider');

function voyagerEnabled() {
  return String(process.env.USE_VOYAGER_READS || '').trim() === '1';
}

// Rate-limit errors must NOT trigger a fallback (we're intentionally throttled).
function isRateLimit(err) {
  const c = String(err?.code || '');
  return c === 'RATE_LIMIT_EXCEEDED' || c === 'RATE_LIMIT_HOURLY_EXCEEDED';
}

async function readInbox(args) {
  if (!voyagerEnabled()) return scraperProvider.readInbox(args);
  try {
    const res = await voyagerProvider.readInbox(args);
    // Empty Voyager result is suspicious — fall back to confirm, don't trust a
    // silent empty (could be a shape mismatch rather than a truly empty inbox).
    if (!res.items || res.items.length === 0) {
      console.warn(`[readProvider] voyager inbox empty for ${args.accountId}; falling back to scraper`);
      return scraperProvider.readInbox(args);
    }
    return res;
  } catch (err) {
    if (isRateLimit(err)) throw err;
    console.warn(`[readProvider] voyager inbox failed for ${args.accountId} (${err.code || 'ERR'}): ${err.message}; falling back to scraper`);
    return scraperProvider.readInbox(args);
  }
}

async function readThread(args) {
  if (!voyagerEnabled()) return scraperProvider.readThread(args);
  try {
    const res = await voyagerProvider.readThread(args);
    if (!res.items || res.items.length === 0) {
      console.warn(`[readProvider] voyager thread empty for ${args.accountId}/${args.chatId}; falling back to scraper`);
      return scraperProvider.readThread(args);
    }
    return res;
  } catch (err) {
    if (isRateLimit(err)) throw err;
    console.warn(`[readProvider] voyager thread failed for ${args.accountId}/${args.chatId} (${err.code || 'ERR'}): ${err.message}; falling back to scraper`);
    return scraperProvider.readThread(args);
  }
}

async function readConnections(args) {
  if (!voyagerEnabled()) return scraperProvider.readConnections(args);
  try {
    const res = await voyagerProvider.readConnections(args);
    // Unlike inbox/thread, an empty connections page CAN be legitimate; only fall
    // back on a hard error, not on empty — otherwise we'd re-trigger the
    // redirect-looping DOM scrape we're specifically trying to avoid.
    return res;
  } catch (err) {
    if (isRateLimit(err)) throw err;
    if (err.code === 'BLOCKED' || err.code === 'NO_SESSION') {
      // API says blocked — do NOT fall back to the DOM page (it just
      // redirect-loops on a flagged IP). Surface the block instead.
      throw err;
    }
    console.warn(`[readProvider] voyager connections failed for ${args.accountId} (${err.code || 'ERR'}): ${err.message}; falling back to scraper`);
    return scraperProvider.readConnections(args);
  }
}

module.exports = { readInbox, readThread, readConnections, voyagerEnabled };
