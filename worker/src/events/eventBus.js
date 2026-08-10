'use strict';

// Internal event bus (Phase 3) backed by Redis Streams.
//
// Producers (realtime connector, Voyager deltas) publish canonical events here;
// consumers (persistence, webhook dispatcher) read via consumer groups so each
// event is processed at-least-once and survives restarts. XRANGE gives replay.
//
// Stream:  li:events
// Envelope matches deployment/LINKEDIN_INGESTION_MASTERPLAN.md §4.1.

const crypto = require('crypto');
const { getRedis, createRedisClient } = require('../redisClient');

const STREAM_KEY = process.env.EVENT_STREAM_KEY || 'li:events';
const MAXLEN = parseInt(process.env.EVENT_STREAM_MAXLEN || '100000', 10); // approx cap

// Crockford-ish ULID: time-ordered, collision-resistant, no dependency.
function ulid() {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(10).toString('hex');
  return `evt_${time}${rand}`;
}

/**
 * Build a canonical event envelope.
 */
function makeEvent({ type, accountId, data, occurredAt }) {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    type,
    version: '1',
    account_id: accountId,
    occurred_at: occurredAt || now,
    received_at: now,
    data: data || {},
  };
}

/**
 * Publish an event to the stream. Returns the stream entry id.
 */
async function publish(eventInput) {
  const redis = getRedis();
  const event = eventInput.id ? eventInput : makeEvent(eventInput);
  const id = await redis.xadd(
    STREAM_KEY,
    'MAXLEN', '~', String(MAXLEN),
    '*',
    'event', JSON.stringify(event)
  );
  return { streamId: id, event };
}

async function ensureGroup(group) {
  const redis = getRedis();
  try {
    await redis.xgroup('CREATE', STREAM_KEY, group, '$', 'MKSTREAM');
  } catch (err) {
    if (!String(err.message || '').includes('BUSYGROUP')) throw err;
  }
}

/**
 * Subscribe via a consumer group. Runs until stop() is called.
 * handler(event, meta) — throw to NACK (message stays pending for retry).
 * @returns {{ stop: () => Promise<void> }}
 */
function subscribe({ group, consumer, handler, blockMs = 5000, batch = 16 }) {
  if (!group || !consumer || typeof handler !== 'function') {
    throw new Error('subscribe requires { group, consumer, handler }');
  }
  let stopped = false;
  const conn = createRedisClient(); // dedicated blocking connection

  const loop = async () => {
    await ensureGroup(group);
    while (!stopped) {
      let res;
      try {
        res = await conn.xreadgroup(
          'GROUP', group, consumer,
          'COUNT', String(batch),
          'BLOCK', String(blockMs),
          'STREAMS', STREAM_KEY, '>'
        );
      } catch (err) {
        if (stopped) break;
        console.error('[eventBus] xreadgroup error:', err.message);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!res) continue; // BLOCK timeout, loop again
      for (const [, entries] of res) {
        for (const [streamId, fields] of entries) {
          const idx = fields.indexOf('event');
          const raw = idx >= 0 ? fields[idx + 1] : null;
          let event = null;
          try { event = raw ? JSON.parse(raw) : null; } catch { /* skip */ }
          try {
            if (event) await handler(event, { streamId, group, consumer });
            await conn.xack(STREAM_KEY, group, streamId);
          } catch (err) {
            // Leave un-acked → stays in PEL for a future XCLAIM/retry sweep.
            console.warn(`[eventBus] handler failed for ${streamId}: ${err.message} (left pending)`);
          }
        }
      }
    }
    await conn.quit().catch(() => {});
  };

  const started = loop().catch((e) => console.error('[eventBus] subscribe loop crashed:', e));
  return {
    stop: async () => { stopped = true; await started; },
  };
}

/**
 * Replay events since a stream id (exclusive). For consumers catching up.
 */
async function replaySince(sinceStreamId = '-', { count = 500 } = {}) {
  const redis = getRedis();
  const start = sinceStreamId === '-' ? '-' : `(${sinceStreamId}`;
  const rows = await redis.xrange(STREAM_KEY, start, '+', 'COUNT', count);
  return rows.map(([streamId, fields]) => {
    const idx = fields.indexOf('event');
    let event = null;
    try { event = idx >= 0 ? JSON.parse(fields[idx + 1]) : null; } catch { /* skip */ }
    return { streamId, event };
  }).filter((r) => r.event);
}

module.exports = { publish, subscribe, replaySince, makeEvent, ulid, STREAM_KEY };
