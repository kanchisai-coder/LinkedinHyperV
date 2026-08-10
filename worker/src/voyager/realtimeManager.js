'use strict';

// Realtime manager (Phase 2). Holds one RealtimeConnector open per account and
// republishes incoming frames as canonical events on the event bus. This is the
// piece that makes inbox delivery real-time instead of polled.
//
// Flag: USE_REALTIME=1. When an account has a healthy realtime connection, the
// orchestrator's polling can drop to a slow safety interval (the manager reports
// health via isRealtimeHealthy()).

const { RealtimeConnector } = require('./RealtimeConnector');
const { publish } = require('../events/eventBus');
const { recordSurfaceFailure } = require('../antiBan');

const connectors = new Map(); // accountId -> { connector, healthy, lastEventAt }

function realtimeEnabled() {
  return String(process.env.USE_REALTIME || '').trim() === '1';
}

function isRealtimeHealthy(accountId) {
  const e = connectors.get(accountId);
  if (!e) return false;
  // Healthy = connected and we've seen a frame (or heartbeat) recently.
  const stale = Date.now() - (e.lastEventAt || 0) > 120000;
  return e.healthy && !stale;
}

async function startForAccount(accountId, options = {}) {
  if (!realtimeEnabled()) return null;
  if (connectors.get(accountId)) return connectors.get(accountId).connector;

  const connector = new RealtimeConnector(accountId, options);
  const entry = { connector, healthy: false, lastEventAt: 0 };
  connectors.set(accountId, entry);

  connector.on('connected', () => { entry.healthy = true; entry.lastEventAt = Date.now(); });
  connector.on('disconnected', () => { entry.healthy = false; });
  connector.on('event', () => { entry.lastEventAt = Date.now(); });

  connector.on('message', async (m) => {
    entry.lastEventAt = Date.now();
    await publish({
      type: 'message.received',
      accountId,
      occurredAt: m.receivedAt,
      data: {
        thread_id: m.raw?.entityUrn || null,
        event_urn: m.eventUrn,
        topic: m.topic,
        raw: m.raw,
      },
    }).catch((e) => console.warn('[realtime] publish message failed:', e.message));
  });

  connector.on('read', (p) => publish({ type: 'message.read', accountId, data: { raw: p } }).catch(() => {}));
  connector.on('typing', (p) => publish({ type: 'typing.started', accountId, data: { raw: p } }).catch(() => {}));
  connector.on('invitation', (p) => publish({ type: 'invitation.received', accountId, data: { raw: p } }).catch(() => {}));

  connector.on('error', (err) => {
    console.warn(`[realtime] ${accountId} error: ${err.message}`);
    // A persistent realtime auth failure is a block signal for the breaker.
    if (/401|403|999|auth/i.test(String(err.message))) {
      recordSurfaceFailure({ accountId, surface: 'inbox', posture: 'blocked' }).catch(() => {});
    }
  });

  try {
    await connector.start();
    console.log(`[realtime] started for ${accountId}`);
  } catch (err) {
    console.warn(`[realtime] start failed for ${accountId}: ${err.message}`);
    connectors.delete(accountId);
    return null;
  }
  return connector;
}

async function stopForAccount(accountId) {
  const e = connectors.get(accountId);
  if (!e) return;
  await e.connector.stop().catch(() => {});
  connectors.delete(accountId);
}

async function stopAll() {
  await Promise.all([...connectors.keys()].map((id) => stopForAccount(id)));
}

module.exports = { realtimeEnabled, startForAccount, stopForAccount, stopAll, isRealtimeHealthy };
