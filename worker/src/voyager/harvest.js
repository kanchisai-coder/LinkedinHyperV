'use strict';

// Traffic-harvesting harness — §11 step 1 of the master plan.
//
// Opens an authenticated browser session for an account, navigates the inbox /
// connections / notifications like the web app would, and records every
// Voyager API + realtime request the page fires: URL, method, headers, and
// (for GraphQL) the queryId. The captured manifest is what we build the
// VoyagerClient + RealtimeConnector against, and the queryIds feed the
// auto-harvest cache (§5.2).
//
// This is read-only reconnaissance — it does not send messages or invites.

const fs = require('fs');
const path = require('path');
const { getAuthedContext } = require('./session');
const queryIdCache = require('./queryIdCache');

const VOYAGER_RE = /\/voyager\/api\//;
const REALTIME_RE = /\/realtime\//;
const GRAPHQL_RE = /\/voyager\/api\/graphql/;

function extractQueryId(url) {
  const m = url.match(/[?&]queryId=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Harvest Voyager + realtime traffic for an account.
 * @returns {Promise<{ requests: Array, queryIds: string[], outFile: string }>}
 */
async function harvest(accountId, options = {}) {
  const dwellMs = options.dwellMs || 8000;
  const outDir = options.outDir || '/tmp/voyager-harvest';
  fs.mkdirSync(outDir, { recursive: true });

  const { context } = await getAuthedContext(accountId, { headless: options.headless });
  const page = await context.newPage();

  const requests = [];
  const queryIds = new Set();

  page.on('request', (req) => {
    const url = req.url();
    if (VOYAGER_RE.test(url) || REALTIME_RE.test(url)) {
      const entry = {
        method: req.method(),
        url,
        resourceType: req.resourceType(),
        headers: req.headers(),
        kind: GRAPHQL_RE.test(url) ? 'graphql' : REALTIME_RE.test(url) ? 'realtime' : 'voyager-rest',
        ts: new Date().toISOString(),
      };
      if (entry.kind === 'graphql') {
        const qid = extractQueryId(url);
        if (qid) { entry.queryId = qid; queryIds.add(qid); }
      }
      requests.push(entry);
    }
  });

  // Walk the surfaces the web app would, dwelling so the SPA fires its calls.
  const surfaces = [
    'https://www.linkedin.com/messaging/',
    'https://www.linkedin.com/mynetwork/invitation-manager/',
    'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    'https://www.linkedin.com/notifications/',
  ];
  for (const url of surfaces) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(dwellMs);
  }

  await page.close().catch(() => {});

  const outFile = path.join(outDir, `${accountId.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.json`);
  const manifest = {
    accountId,
    capturedAt: new Date().toISOString(),
    counts: {
      total: requests.length,
      graphql: requests.filter((r) => r.kind === 'graphql').length,
      rest: requests.filter((r) => r.kind === 'voyager-rest').length,
      realtime: requests.filter((r) => r.kind === 'realtime').length,
    },
    queryIds: [...queryIds],
    requests,
  };
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));

  // Phase 5: persist harvested queryIds so the Voyager client self-heals.
  if (queryIds.size) {
    await queryIdCache.store([...queryIds]).catch((e) =>
      console.warn('[harvest] queryId cache store failed:', e.message));
  }

  return { requests, queryIds: [...queryIds], outFile, counts: manifest.counts };
}

module.exports = { harvest };
