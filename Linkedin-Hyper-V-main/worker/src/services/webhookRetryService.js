'use strict';

const crypto = require('crypto');
const unifiedRepo = require('../db/repositories/UnifiedRepository');
const { assertSafeWebhookTarget } = require('../security/ssrfGuard');

const BACKOFF_MINUTES = [5, 15, 60, 360];
const MAX_ATTEMPTS = 5;

function minutesFromNow(minutes) {
  return new Date(Date.now() + (minutes * 60 * 1000));
}

function nextBackoffMinutes(attempts) {
  return BACKOFF_MINUTES[Math.max(0, attempts - 1)] || BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
}

async function retryPendingWebhooks() {
  const subscriptions = await unifiedRepo.listActiveWebhookSubscriptions().catch(() => []);
  const secretsByTargetUrl = new Map(subscriptions.map((subscription) => [subscription.targetUrl, subscription.secret]));
  const events = await unifiedRepo.listRetryableWebhookEvents({ limit: 50, maxAttempts: MAX_ATTEMPTS });

  for (const event of events) {
    const secret = secretsByTargetUrl.get(event.targetUrl);
    if (!secret) {
      await unifiedRepo.updateWebhookEvent(event.id, {
        status: 'failed',
        lastAttemptAt: new Date(),
        nextAttemptAt: null,
        responseBody: 'Webhook subscription is missing or inactive.',
      }).catch(() => null);
      continue;
    }

    const body = JSON.stringify(event.payload);
    // Recompute the signature over the EXACT bytes we send. The stored payload is
    // JSONB (key order not preserved), so reusing a stored signature would fail
    // the receiver's HMAC verification on every retry.
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    const nextAttemptCount = Number(event.attempts || 0) + 1;

    // Re-validate the target at delivery time (defeats DNS-rebinding / TOCTOU).
    // A target that now resolves to a private address is failed terminally.
    try {
      await assertSafeWebhookTarget(event.targetUrl);
    } catch (guardErr) {
      await unifiedRepo.updateWebhookEvent(event.id, {
        status: 'failed',
        attempts: nextAttemptCount,
        lastAttemptAt: new Date(),
        nextAttemptAt: null,
        responseBody: `Blocked unsafe webhook target: ${guardErr?.message || 'private/internal address'}`,
        signature,
      }).catch(() => null);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(event.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LinkedIn-Hyper-Event': event.eventType,
          'X-LinkedIn-Hyper-Signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
        // Never follow redirects — a public URL could 3xx to a private address.
        redirect: 'manual',
      });
      clearTimeout(timeoutId);

      const responseBody = await res.text().catch(() => '');
      const terminalFailure = !res.ok && nextAttemptCount >= MAX_ATTEMPTS;
      await unifiedRepo.updateWebhookEvent(event.id, {
        status: res.ok ? 'delivered' : (terminalFailure ? 'failed' : 'retry_pending'),
        attempts: nextAttemptCount,
        lastAttemptAt: new Date(),
        nextAttemptAt: res.ok || terminalFailure ? null : minutesFromNow(nextBackoffMinutes(nextAttemptCount)),
        responseCode: res.status,
        responseBody: responseBody.slice(0, 4000),
        deliveredAt: res.ok ? new Date() : null,
        signature,
      }).catch(() => null);
    } catch (err) {
      const terminalFailure = nextAttemptCount >= MAX_ATTEMPTS;
      await unifiedRepo.updateWebhookEvent(event.id, {
        status: terminalFailure ? 'failed' : 'retry_pending',
        attempts: nextAttemptCount,
        lastAttemptAt: new Date(),
        nextAttemptAt: terminalFailure ? null : minutesFromNow(nextBackoffMinutes(nextAttemptCount)),
        responseBody: String(err?.message || err).slice(0, 4000),
        signature,
      }).catch(() => null);
    }
  }
}

function startWebhookRetryService({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    retryPendingWebhooks().catch((err) => {
      console.warn(`[WebhookRetry] Poll failed: ${err?.message || String(err)}`);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

module.exports = {
  MAX_ATTEMPTS,
  nextBackoffMinutes,
  retryPendingWebhooks,
  startWebhookRetryService,
};
