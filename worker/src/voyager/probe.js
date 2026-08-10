'use strict';

// Runnable de-risking spike — §11 of the master plan, all three steps:
//   1. harvest()         — record the Voyager + realtime traffic the web app makes
//   2. VoyagerClient     — call /voyager/api/messaging/conversations directly
//   3. RealtimeConnector — open /realtime/connect and log the first frames
//
// Usage (inside the worker container, with a logged-in session for the account):
//   node src/voyager/probe.js <accountId> [seconds]
//
// Proves end-to-end that Voyager auth + the realtime stream are reachable from
// our egress. If steps 2 & 3 succeed behind a residential proxy, green-light
// Phase 1.

const { harvest } = require('./harvest');
const { VoyagerClient } = require('./VoyagerClient');
const { RealtimeConnector } = require('./RealtimeConnector');
const { cleanupContext } = require('../browser');

async function main() {
  const accountId = process.argv[2];
  const realtimeSeconds = parseInt(process.argv[3] || '30', 10);
  if (!accountId) {
    console.error('Usage: node src/voyager/probe.js <accountId> [realtimeSeconds]');
    process.exit(1);
  }

  console.log(`\n=== [1/3] Harvesting Voyager + realtime traffic for "${accountId}" ===`);
  try {
    const h = await harvest(accountId, { dwellMs: 7000 });
    console.log(`captured ${h.counts.total} requests`, h.counts);
    console.log(`queryIds (${h.queryIds.length}):`);
    h.queryIds.slice(0, 20).forEach((q) => console.log('   ', q));
    console.log(`manifest written: ${h.outFile}`);
  } catch (e) {
    console.error('harvest failed:', e.message);
  }

  console.log(`\n=== [2/3] Calling Voyager getConversations() directly ===`);
  const client = new VoyagerClient(accountId);
  try {
    const convos = await client.getConversations({ count: 5 });
    const elements = convos?.elements || convos?.data?.elements || [];
    console.log(`OK — got ${Array.isArray(elements) ? elements.length : '?'} conversation elements`);
    console.log('sample keys:', Object.keys(convos).slice(0, 10));
  } catch (e) {
    console.error(`Voyager call failed [${e.code || 'ERR'} ${e.status || ''}]:`, e.message);
  }

  console.log(`\n=== [3/3] Opening realtime stream for ${realtimeSeconds}s ===`);
  const rc = new RealtimeConnector(accountId);
  let frameCount = 0;
  rc.on('connected', () => console.log('realtime: connected'));
  rc.on('disconnected', (d) => console.log('realtime: disconnected -', d.reason));
  rc.on('reconnecting', (d) => console.log(`realtime: reconnecting (attempt ${d.attempt}, ${d.delayMs}ms)`));
  rc.on('event', () => { frameCount += 1; });
  rc.on('message', (m) => console.log('realtime MESSAGE:', m.eventUrn || '(no urn)', m.topic));
  rc.on('error', (e) => console.error('realtime error:', e.message));

  try {
    await rc.start();
    await new Promise((r) => setTimeout(r, realtimeSeconds * 1000));
  } catch (e) {
    console.error('realtime start failed:', e.message);
  } finally {
    await rc.stop();
    console.log(`realtime: received ${frameCount} frames total`);
  }

  await cleanupContext(accountId).catch(() => {});
  console.log('\n=== probe complete ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
