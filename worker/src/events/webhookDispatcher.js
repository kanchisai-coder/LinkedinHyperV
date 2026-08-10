'use strict';

// Webhook dispatcher (Phase 3). Consumes the event bus and delivers each event
// to registered subscriber endpoints as a signed HTTPS POST, with exponential
// retries and a dead-letter list. This is our outward Unipile-style contract.
//
// Subscriptions (v1, env-configured — a DB table comes later):
//   WEBHOOK_ENDPOINTS = JSON array, e.g.
//   [{"url":"https://x/hooks/li","secret":"whsec_...","events":["message.*"],"accounts":["*"]}]
//
// Signature header (Stripe-style):
//   X-LI-Signature: t=<unixSeconds>,v1=<hex hmac_sha256(secret, t + "." + body)>

const crypto = require('crypto');
const { subscribe } = require('./eventBus');
const { getRedis } = require('../redisClient');
const { assertSafeWebhookTarget } = require('../security/ssrfGuard');

const GROUP = 'webhooks';
const CONSUMER = process.env.WEBHOOK_CONSUMER || `wh-${process.pid}`;
const DLQ_KEY = 'li:events:dlq';
const MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '8', 10);
const BACKOFF_MS = [1000, 5000, 30000, 300000, 1800000, 7200000, 21600000, 86400000];

function loadSubscriptions() {
  const raw = process.env.WEBHOOK_ENDPOINTS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.error('[webhook] invalid WEBHOOK_ENDPOINTS JSON:', err.message);
    return [];
  }
}

function matchesGlob(pattern, value) {
  if (pattern === '*' || pattern === value) return true;
  // simple "prefix.*" support
  if (pattern.endsWith('.*')) return value.startsWith(pattern.slice(0, -1));
  return false;
}

function subscriptionWants(sub, event) {
  const evMatch = (sub.events || ['*']).some((p) => matchesGlob(p, event.type));
  const acctMatch = (sub.accounts || ['*']).some((p) => matchesGlob(p, event.account_id || ''));
  return evMatch && acctMatch;
}

function sign(secret, tsSeconds, body) {
  const mac = crypto.createHmac('sha256', secret)
    .update(`${tsSeconds}.${body}`)
    .digest('hex');
  return `t=${tsSeconds},v1=${mac}`;
}

async function deliverOnce(sub, event) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'linkedin-outreach-webhooks/1',
    'x-li-event-id': event.id,
    'x-li-event-type': event.type,
  };
  if (sub.secret) headers['x-li-signature'] = sign(sub.secret, ts, body);

  // Re-validate at delivery time (DNS-rebinding/TOCTOU) and never follow
  // redirects, which could hop from a public URL to a private address.
  await assertSafeWebhookTarget(sub.url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  timer.unref?.();
  try {
    const res = await fetch(sub.url, {
      method: 'POST', headers, body, signal: controller.signal, redirect: 'manual',
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function deadLetter(sub, event, lastError) {
  const redis = getRedis();
  await redis.lpush(DLQ_KEY, JSON.stringify({
    url: sub.url, event, lastError, failedAt: new Date().toISOString(),
  })).catch(() => null);
  await redis.ltrim(DLQ_KEY, 0, 9999).catch(() => null);
}

// Deliver with bounded retries. Runs async per (sub, event) so a slow endpoint
// doesn't block the bus consumer beyond the first attempt.
async function deliverWithRetry(sub, event) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const evt = { ...event, delivery_attempt: attempt + 1 };
    try {
      const r = await deliverOnce(sub, evt);
      if (r.ok) return true;
      console.warn(`[webhook] ${sub.url} -> ${r.status} (attempt ${attempt + 1})`);
    } catch (err) {
      console.warn(`[webhook] ${sub.url} error (attempt ${attempt + 1}): ${err.message}`);
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  await deadLetter(sub, event, 'max attempts exceeded');
  return false;
}

function start() {
  const subs = loadSubscriptions();
  if (subs.length === 0) {
    console.log('[webhook] no WEBHOOK_ENDPOINTS configured; dispatcher idle');
    return { stop: async () => {} };
  }
  console.log(`[webhook] dispatcher starting with ${subs.length} subscription(s)`);

  const handle = subscribe({
    group: GROUP,
    consumer: CONSUMER,
    handler: async (event) => {
      const targets = subs.filter((s) => subscriptionWants(s, event));
      // Fire-and-forget per subscriber; ack happens once we've handed off.
      for (const sub of targets) {
        deliverWithRetry(sub, event).catch((e) =>
          console.error('[webhook] delivery pipeline error:', e.message));
      }
    },
  });

  return handle;
}

module.exports = { start, sign, _internals: { matchesGlob, subscriptionWants, loadSubscriptions } };
