'use strict';

// Persistence consumer (the missing half of LINKEDIN_INGESTION_MASTERPLAN §3).
//
// The realtime manager PUBLISHES message/read/invitation events to the bus, but
// without a consumer those events were only delivered to webhooks (if any) and
// otherwise lost — never written to Postgres. This consumer subscribes to the
// bus and idempotently persists realtime events to the DB, so the live stream
// actually populates the mirror.
//
// Idempotent by construction: upsertMessage/upsertConversation dedupe on
// dedupeKey/id, so overlap with backfill + delta sync is harmless.

const { subscribe } = require('./eventBus');
const messageRepo = require('../db/repositories/MessageRepository');

let handle = null;

function lastUrnSegment(urn) {
  const s = String(urn || '');
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1).replace(/^\(+|\)+$/g, '') : s;
}

// Map a realtime message frame → a normalized message row. Best-effort: realtime
// frame shapes vary by LinkedIn version, so every access is defensive. Anything
// we can't confidently map is skipped (the slow delta/backfill sync still
// covers it), never persisted wrong.
async function persistMessageEvent(event) {
  const data = event?.data || {};
  const raw = data.raw || {};
  const threadId = data.thread_id || raw.conversationUrn || raw.entityUrn;
  if (!threadId) return false;

  const accountId = event.account_id;
  const conversationId = String(threadId).includes(':')
    ? threadId
    : `${accountId}:${lastUrnSegment(threadId)}`;

  // Pull message fields from the realtime envelope defensively.
  const ev = raw.event || raw;
  // Realtime frames nest text under the MessageEvent wrapper
  // (eventContent['com.linkedin.voyager.messaging.event.MessageEvent'].attributedBody.text)
  // which the flat chain below misses — use the shared extractor first, then
  // keep the existing top-level fallbacks (strictly additive).
  const { extractMessageText } = require('../voyager/voyagerMapper');
  const text = extractMessageText(ev)
    || ev?.eventContent?.attributedBody?.text
    || ev?.attributedBody?.text
    || ev?.body
    || '';
  const externalId = data.event_urn || ev?.entityUrn || ev?.eventUrn || null;
  if (!externalId && !text) return false; // nothing usable

  const { normalizeMessage } = require('../unified/normalizer');
  const normalized = normalizeMessage(accountId, conversationId, {
    externalId,
    text,
    createdAt: ev?.createdAt || event.occurred_at,
    senderName: ev?.from?.miniProfile
      ? `${ev.from.miniProfile.firstName || ''} ${ev.from.miniProfile.lastName || ''}`.trim()
      : undefined,
    source: 'realtime',
    raw,
  });

  const saved = await messageRepo.upsertMessage(normalized).catch(() => null);
  if (saved) {
    await messageRepo.refreshConversationStats(conversationId).catch(() => null);
  }
  return Boolean(saved);
}

async function handler(event) {
  switch (event.type) {
    case 'message.received':
    case 'message.sent':
      await persistMessageEvent(event);
      break;
    // read/typing/invitation: no DB write needed yet (delta sync handles state).
    // backfill.progress / account.status_changed: informational.
    default:
      break;
  }
}

function start() {
  // Only run when realtime is on — that's the only producer of message events
  // that need this consumer (delta/backfill persist inline).
  if (String(process.env.USE_REALTIME || '').trim() !== '1') {
    console.log('[persistence] consumer idle (USE_REALTIME not set)');
    return { stop: () => {} };
  }
  console.log('[persistence] event-bus persistence consumer starting');
  handle = subscribe({
    group: 'persistence',
    consumer: `persist-${process.pid}`,
    handler: (event) => handler(event).catch((e) =>
      console.warn('[persistence] handler error:', e.message)),
  });
  return handle;
}

module.exports = { start, _internals: { persistMessageEvent, lastUrnSegment } };
