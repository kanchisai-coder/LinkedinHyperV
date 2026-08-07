'use strict';

const accountRepo = require('./db/repositories/AccountRepository');
const { getRedis } = require('./redisClient');

const POSTURE_KEY_PREFIX = 'sync:posture';
const BLOCKED_STATUSES = new Set(['blocked', 'checkpoint', 'expired', 'automation_warning']);
const WARNING_PATTERNS = [
  'automated behavior',
  'automation',
  'using automation',
  'unusual activity',
  'temporarily restricted',
  'restricted your account',
  'suspicious activity',
  'we noticed',
];

function isAutomationWarningText(value) {
  const lower = String(value || '').toLowerCase();
  return WARNING_PATTERNS.some((pattern) => lower.includes(pattern));
}

function postureKey(accountId) {
  return `${POSTURE_KEY_PREFIX}:${accountId}`;
}

function classifySyncFailure(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || err || '');
  const lower = message.toLowerCase();
  const warningUrl = String(err?.warningUrl || err?.diagnostics?.warningUrl || err?.diagnostics?.finalUrl || '');

  // ANTI-BAN: hard-block backoffs were way too short. LinkedIn blocks of these
  // categories typically last days, not hours. Retrying every 60–180 min on a
  // blocked account is itself a signal that amplifies the original detection.
  // Defaults are tunable via env so ops can shorten for testing.
  const automationWarningBackoff = parseInt(process.env.SYNC_BACKOFF_AUTOMATION_WARNING_MIN || '10080', 10); // 7 days
  const expiredBackoff           = parseInt(process.env.SYNC_BACKOFF_EXPIRED_MIN || '720', 10);              // 12 hours
  const checkpointBackoff        = parseInt(process.env.SYNC_BACKOFF_CHECKPOINT_MIN || '1440', 10);          // 24 hours
  const blockedBackoff           = parseInt(process.env.SYNC_BACKOFF_BLOCKED_MIN || '2880', 10);             // 48 hours

  if (
    code === 'AUTOMATION_WARNING'
    || code === 'RESTRICTED'
    || isAutomationWarningText(lower)
    || isAutomationWarningText(err?.diagnostics?.textSample)
  ) {
    return {
      posture: 'automation_warning',
      coverage: 'blocked',
      retryable: false,
      backoffMinutes: automationWarningBackoff,
      reason: message || 'LinkedIn flagged possible automation or unusual activity.',
      warningUrl,
    };
  }

  if (code === 'SESSION_EXPIRED' || code === 'NO_SESSION' || code === 'COOKIES_MISSING') {
    return {
      posture: 'expired',
      coverage: 'blocked',
      retryable: false,
      backoffMinutes: expiredBackoff,
      reason: message || 'LinkedIn session is expired.',
    };
  }

  if (code === 'CHECKPOINT_INCOMPLETE' || lower.includes('/checkpoint') || lower.includes('/challenge')) {
    return {
      posture: 'checkpoint',
      coverage: 'blocked',
      retryable: false,
      backoffMinutes: checkpointBackoff,
      reason: message || 'LinkedIn checkpoint is required.',
    };
  }

  if (lower.includes('err_too_many_redirects') || lower.includes('too many redirects') || lower.includes('/authwall')) {
    return {
      posture: 'blocked',
      coverage: 'blocked',
      retryable: false,
      backoffMinutes: blockedBackoff,
      reason: message || 'LinkedIn redirected to a blocked or logged-out state.',
    };
  }

  if (/timeout|network|navigation|closed/i.test(message)) {
    return {
      posture: 'degraded',
      coverage: 'stale',
      retryable: true,
      backoffMinutes: 10,
      reason: message,
    };
  }

  return {
    posture: 'degraded',
    coverage: 'stale',
    retryable: true,
    backoffMinutes: 20,
    reason: message,
  };
}

async function setSyncPosture(accountId, posture, fields = {}) {
  if (!accountId || !posture) return null;
  const redis = getRedis();
  const now = new Date().toISOString();
  const payload = {
    posture,
    reason: fields.reason || '',
    surface: fields.surface || '',
    lane: fields.lane || '',
    errorCode: fields.errorCode || '',
    warningUrl: fields.warningUrl || '',
    nextAllowedAt: fields.nextAllowedAt ? new Date(fields.nextAllowedAt).toISOString() : '',
    updatedAt: now,
  };

  await redis.hset(postureKey(accountId), payload).catch(() => null);
  await redis.expire(postureKey(accountId), 7 * 24 * 60 * 60).catch(() => null);

  const sessionStatus = BLOCKED_STATUSES.has(posture)
    ? posture === 'blocked'
      ? 'expired'
      : posture === 'automation_warning'
        ? 'restricted'
        : posture
    : posture === 'healthy' ? 'connected' : undefined;
  const liveReachability = BLOCKED_STATUSES.has(posture)
    ? posture === 'expired'
      ? 'login_redirect'
      : posture
    : posture === 'healthy'
      ? 'reachable'
      : posture === 'degraded'
        ? 'unknown'
        : undefined;
  if (sessionStatus) {
    await accountRepo.updateSessionState(accountId, { sessionStatus }).catch(() => null);
  }
  if (liveReachability) {
    await accountRepo.updateSessionState(accountId, {
      liveReachability,
      liveReachabilityAt: new Date(),
      liveReachabilityUrl: fields.warningUrl || null,
    }).catch(() => null);
  }

  return payload;
}

async function clearSyncPosture(accountId, reason = 'Session verified') {
  if (!accountId) return null;
  const redis = getRedis();
  await redis.del(postureKey(accountId)).catch(() => null);
  await accountRepo.updateSessionState(accountId, {
    sessionStatus: 'connected',
    liveReachability: 'reachable',
    liveReachabilityAt: new Date(),
    liveReachabilityUrl: null,
  }).catch(() => null);
  return setSyncPosture(accountId, 'healthy', { reason });
}

async function getSyncPosture(accountId) {
  if (!accountId) return { posture: 'healthy' };
  const redis = getRedis();
  const raw = await redis.hgetall(postureKey(accountId)).catch(() => ({}));
  if (raw?.posture) return raw;

  const account = await accountRepo.getAccountById(accountId).catch(() => null);
  if (['expired', 'checkpoint', 'blocked', 'restricted'].includes(String(account?.sessionStatus || ''))) {
    return {
      posture: account.sessionStatus === 'checkpoint'
        ? 'checkpoint'
        : account.sessionStatus === 'restricted'
          ? 'automation_warning'
          : 'expired',
      reason: 'Account session status requires reconnect.',
      updatedAt: account.updatedAt ? new Date(account.updatedAt).toISOString() : '',
    };
  }

  return { posture: 'healthy' };
}

function isBlockedPosture(posture) {
  return BLOCKED_STATUSES.has(String(posture || ''));
}

module.exports = {
  classifySyncFailure,
  setSyncPosture,
  clearSyncPosture,
  getSyncPosture,
  isBlockedPosture,
  isAutomationWarningText,
};
