'use strict';

const provider = require('./LinkedInProvider');
const crypto = require('crypto');
const unifiedRepo = require('../db/repositories/UnifiedRepository');
const messageRepo = require('../db/repositories/MessageRepository');
const { getPrisma } = require('../db/prisma');
const { gateAction, recordSurfaceFailure } = require('../antiBan');
// Phase 1: flag-switched read router (Voyager API with scraper fallback).
const reads = require('../voyager/readProvider');
const accountRepo = require('../db/repositories/AccountRepository');
const { getQueue } = require('../queue');
const { getRedis } = require('../redisClient');
const { listKnownAccountIds } = require('../session');
const { cleanupContext } = require('../browser');
const { emitToAccount, broadcastEvent, scheduleInboxRefresh, scheduleSyncStatusRefresh } = require('../utils/websocket');
const { invalidateAccountCaches, invalidateSyncStatusCache } = require('../unifiedCache');
const { resolveCanonicalAccountId, dedupeAccountIds } = require('../accountIdentity');
const {
  classifySyncFailure,
  setSyncPosture,
  clearSyncPosture,
  getSyncPosture,
  isBlockedPosture,
} = require('../syncPosture');
const {
  stableHash,
  normalizeConversation,
  normalizeMessage,
  normalizeConnection,
  normalizeInvitation,
  normalizeNotification,
  normalizePost,
} = require('./normalizer');

const LIVE_SURFACES = ['inbox', 'notifications'];
const BACKFILL_SURFACES = ['connections', 'invitations'];
const PLANNED_SURFACES = ['posts', 'comments', 'reactions', 'search'];
const BROWSER_BACKED_SURFACES = ['inbox', 'notifications', 'connections', 'invitations', 'search'];
const THREAD_RESOLUTION_LIMITS = {
  visible: 25,
  recent: 18,
  backfill: 10,
};
let lastSyncRunTrimAt = 0;

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000);
}

function syncCadenceForPosture(posture) {
  if (posture === 'degraded') {
    return {
      deltaMinutes: 10,
      notificationMinutes: 15,
      backfillMinutes: 120,
      connectionsDeltaMinutes: 15,
      invitationsMinutes: 45,
      maxThreads: 1,
    };
  }

  return {
    deltaMinutes: 1,
    notificationMinutes: 2,
    backfillMinutes: 60,
    connectionsDeltaMinutes: 15,
    invitationsMinutes: 45,
    maxThreads: 1,
  };
}

function elapsedMs(startedAt) {
  return Number(((Date.now() - startedAt) || 0).toFixed(0));
}

function normalizeSurfaces(input, lane) {
  const fallback = lane === 'backfill'
    ? [...BACKFILL_SURFACES, ...PLANNED_SURFACES]
    : LIVE_SURFACES;
  const values = Array.isArray(input) ? input : fallback;
  return Array.from(new Set(values.map((surface) => String(surface || '').trim()).filter(Boolean)));
}

function touchesBrowserSurface(surfaces = []) {
  return surfaces.some((surface) => BROWSER_BACKED_SURFACES.includes(surface));
}

function createSyncBlockedError(accountId, posture, surface) {
  const error = new Error(posture?.reason || `LinkedIn session is blocked for ${accountId}. Reconnect before syncing ${surface}.`);
  error.code = 'SYNC_BLOCKED';
  error.status = 409;
  error.posture = posture?.posture || 'blocked';
  error.warningUrl = posture?.warningUrl || null;
  return error;
}

// BullMQ forbids ':' in custom job ids (it's the Redis key separator). Our
// accountIds and conversationIds (e.g. "test:2-MWMz...==") contain ':', so any
// jobId embedding them must be sanitized or BullMQ throws "Custom Id cannot
// contain :". Replace ':' with '_' everywhere in the final id.
function sanitizeJobId(id) {
  return String(id == null ? '' : id).replace(/:/g, '_');
}

function buildUnifiedSyncJobId(accountId, lane, surfaces) {
  const normalized = normalizeSurfaces(surfaces, lane);
  if (lane === 'delta' && normalized.length === 1 && normalized[0] === 'inbox') {
    return `delta:${accountId}:inbox`;
  }
  if (lane === 'delta' && normalized.length === 1 && normalized[0] === 'notifications') {
    return `delta:${accountId}:notifications`;
  }
  if (lane === 'backfill' && normalized.join(',') === BACKFILL_SURFACES.join(',')) {
    return `backfill:${accountId}`;
  }
  if (normalized.length === 1) {
    return `sync:${accountId}:${lane}:${normalized[0]}`;
  }
  const jobKey = stableHash({ accountId, lane, surfaces: normalized });
  return `unified:${accountId}:${lane}:${jobKey}`;
}

function buildThreadResolveJobId(accountId, options = {}) {
  const priority = options.priority || 'recent';
  const conversationIds = Array.isArray(options.conversationIds)
    ? Array.from(new Set(options.conversationIds.map((id) => String(id || '').trim()).filter(Boolean)))
    : [];
  if (priority === 'visible' && conversationIds.length === 1) {
    return `repair:${accountId}:${conversationIds[0]}`;
  }
  if (priority === 'visible' && conversationIds.length === 0) {
    return `repair:${accountId}:visible`;
  }
  const jobKey = stableHash({
    accountId,
    priority,
    conversationIds,
    limit: options.limit || null,
  });
  return `threadResolve:${accountId}:${priority}:${jobKey}`;
}

async function getExistingQueuedJob(queue, jobId) {
  if (!queue || !jobId || typeof queue.getJob !== 'function') return null;
  const job = await queue.getJob(jobId).catch(() => null);
  if (!job) return null;
  const state = await job.getState().catch(() => null);
  if (['active', 'waiting', 'waiting-children', 'delayed', 'prioritized'].includes(String(state || ''))) {
    return job;
  }
  return null;
}

async function removeQueuedJobs(queue, predicate) {
  if (!queue || typeof queue.getJobs !== 'function') return 0;
  const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']).catch(() => []);
  let removed = 0;
  for (const job of jobs) {
    if (!predicate(job)) continue;
    await job.remove().catch(() => {});
    removed += 1;
  }
  return removed;
}

async function trimHistoricalSyncRuns() {
  const now = Date.now();
  if (now - lastSyncRunTrimAt < 60 * 60_000) {
    return null;
  }
  lastSyncRunTrimAt = now;
  if (typeof unifiedRepo.summarizeAndTrimSyncRuns !== 'function') {
    return null;
  }
  return unifiedRepo.summarizeAndTrimSyncRuns().catch(() => null);
}

function retryClassification(err) {
  const failure = classifySyncFailure(err);
  return {
    code: err?.code || 'SYNC_FAILED',
    retryable: failure.retryable,
    backoffMinutes: failure.backoffMinutes,
    coverage: failure.coverage,
    posture: failure.posture,
  };
}

function surfaceFinalUrlLooksAuthBlocked(finalUrl) {
  const normalized = String(finalUrl || '').toLowerCase();
  return normalized.includes('/login')
    || normalized.includes('/authwall')
    || normalized.includes('/checkpoint')
    || normalized.includes('/challenge');
}

function invitationFailureImpliesAccountBlock(err) {
  const code = String(err?.code || '').toUpperCase();
  const diagnostics = err?.diagnostics && typeof err.diagnostics === 'object'
    ? err.diagnostics
    : {};
  const authState = String(diagnostics.authState || '').toLowerCase();
  const finalUrl = String(diagnostics.finalUrl || diagnostics.warningUrl || err?.warningUrl || '');
  const sample = String(diagnostics.textSample || '').toLowerCase();

  if (code === 'AUTOMATION_WARNING' || code === 'CHECKPOINT_INCOMPLETE' || code === 'NO_SESSION' || code === 'COOKIES_MISSING') {
    return true;
  }
  if (authState === 'automation_warning' || authState === 'checkpoint') {
    return true;
  }
  if (authState === 'login' && surfaceFinalUrlLooksAuthBlocked(finalUrl)) {
    return true;
  }
  if (surfaceFinalUrlLooksAuthBlocked(finalUrl)) {
    return true;
  }
  if (sample.includes('sign in') || sample.includes('security verification') || sample.includes('forgot password')) {
    return true;
  }
  return false;
}

async function recordEvent(accountId, event, payload) {
  const redis = getRedis();
  const enriched = {
    ...payload,
    accountId,
    event,
    timestamp: new Date().toISOString(),
  };
  await redis.xadd(
    `events:account:${accountId}`,
    'MAXLEN',
    '~',
    1000,
    '*',
    'event',
    event,
    'payload',
    JSON.stringify(enriched)
  ).catch(() => {});
  emitToAccount(accountId, event, enriched);
  broadcastEvent(event, enriched);
  if (event === 'message.created' || event === 'conversation.updated' || event === 'conversation.resolving' || event === 'thread.resolve_failed') {
    await invalidateAccountCaches(accountId, payload?.conversationId || null).catch(() => {});
    scheduleInboxRefresh(accountId, payload);
  }
  if (event === 'sync.progress' || event === 'sync.failed') {
    await invalidateSyncStatusCache(accountId).catch(() => {});
    scheduleSyncStatusRefresh(accountId, payload);
  }
  await deliverWebhooks(event, enriched).catch((err) => {
    console.warn(`[Webhook] Delivery scheduling failed for ${event}: ${err.message}`);
  });
}

async function deliverWebhooks(eventType, payload) {
  const subscriptions = await unifiedRepo.listActiveWebhookSubscriptions()
    .then((rows) => rows.filter((sub) => Array.isArray(sub?.eventTypes) && sub.eventTypes.includes(eventType)))
    .catch(() => []);

  for (const subscription of subscriptions) {
    const body = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', subscription.secret)
      .update(body)
      .digest('hex');

    const event = await unifiedRepo.createWebhookEvent({
      eventType,
      targetUrl: subscription.targetUrl,
      payload,
      status: 'pending',
      attempts: 0,
      signature,
      nextAttemptAt: new Date(),
    });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(subscription.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LinkedIn-Hyper-Event': eventType,
          'X-LinkedIn-Hyper-Signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const responseBody = await res.text().catch(() => '');
      const status = res.ok ? 'delivered' : 'retry_pending';
      await updateWebhookEvent(event.id, {
        status,
        attempts: 1,
        lastAttemptAt: new Date(),
        nextAttemptAt: res.ok ? null : minutesFromNow(5),
        responseCode: res.status,
        responseBody: responseBody.slice(0, 4000),
        deliveredAt: res.ok ? new Date() : null,
      });
    } catch (err) {
      await updateWebhookEvent(event.id, {
        status: 'retry_pending',
        attempts: 1,
        lastAttemptAt: new Date(),
        nextAttemptAt: minutesFromNow(5),
        responseBody: err?.message || String(err),
      });
    }
  }
}

async function updateWebhookEvent(id, data) {
  return unifiedRepo.updateWebhookEvent(id, data);
}

async function updateCursor(accountId, surface, data) {
  return unifiedRepo.upsertSyncCursor({
    accountId,
    surface,
    cursor: data.cursor || null,
    highWatermark: data.highWatermark || null,
    coverage: data.coverage || 'available',
    lagSeconds: data.lagSeconds ?? null,
    nextRunAt: data.nextRunAt || null,
    metadata: data.metadata || {},
    success: data.success !== false,
  });
}

async function runSurface(accountId, lane, surface, fn) {
  const startedAt = Date.now();

  // ANTI-BAN: short-circuit BEFORE we ever touch the network. Checks
  // (1) account-wide cooldown, (2) per-surface circuit breaker, (3) business hours.
  // Skipped for the lightweight "coverage" lane that is internal bookkeeping.
  if (lane !== 'coverage') {
    const gate = await gateAction({ accountId, surface }).catch(() => ({ allowed: true }));
    if (!gate.allowed) {
      console.info(
        `[antiBan] skip account=${accountId} surface=${surface} lane=${lane} reason=${gate.reason}` +
        (gate.retryAfterSeconds ? ` retryAfter=${gate.retryAfterSeconds}s` : '')
      );
      return {
        skipped: true,
        reason: gate.reason,
        retryAfterSeconds: gate.retryAfterSeconds || null,
        itemsRead: 0,
        itemsWritten: 0,
      };
    }
  }

  const run = await unifiedRepo.startSyncRun({
    accountId,
    lane,
    surface,
    metadata: { startedBy: 'SyncOrchestrator' },
  });

  try {
    const result = await fn();
    const durationMs = elapsedMs(startedAt);
    const metadata = {
      ...(result.metadata || {}),
      durationMs,
    };
    if (BROWSER_BACKED_SURFACES.includes(surface)) {
      await clearSyncPosture(accountId, `${surface} sync succeeded`).catch(() => null);
    }
    await unifiedRepo.completeSyncRun(run.id, {
      status: 'success',
      itemsRead: result.itemsRead || 0,
      itemsWritten: result.itemsWritten || 0,
      metadata,
      startedAt: run.startedAt,
    });
    if (durationMs >= 2_000) {
      console.info(`[SyncPerf] ${surface} ${lane} for ${accountId} completed in ${durationMs}ms`);
    }
    return {
      ...result,
      metadata,
    };
  } catch (err) {
    const durationMs = elapsedMs(startedAt);
    const classification = retryClassification(err);
    const nextAllowedAt = minutesFromNow(classification.backoffMinutes);
    const diagnostics = err?.diagnostics && typeof err.diagnostics === 'object'
      ? err.diagnostics
      : null;
    await setSyncPosture(accountId, classification.posture, {
      surface,
      lane,
      reason: err?.message || String(err),
      errorCode: classification.code,
      warningUrl: classification.warningUrl,
      nextAllowedAt,
    }).catch(() => null);
    // ANTI-BAN: feed the circuit breaker. Non-blocking — never throw from here.
    recordSurfaceFailure({
      accountId,
      surface,
      posture: classification.posture,
    }).catch(() => null);
    await unifiedRepo.completeSyncRun(run.id, {
      status: classification.retryable ? 'retryable_failure' : 'blocked',
      errorCode: classification.code,
      errorMessage: err?.message || String(err),
      metadata: {
        durationMs,
        retryable: classification.retryable,
        ...(diagnostics ? { diagnostics } : {}),
      },
      startedAt: run.startedAt,
    });
    await updateCursor(accountId, surface, {
      coverage: classification.coverage,
      nextRunAt: nextAllowedAt,
      success: false,
      metadata: {
        errorCode: classification.code,
        errorMessage: err?.message || String(err),
        retryable: classification.retryable,
        durationMs,
        syncPosture: classification.posture,
        nextAllowedAt: nextAllowedAt.toISOString(),
        warningUrl: classification.warningUrl || null,
        ...(diagnostics ? { diagnostics } : {}),
      },
    });
    await recordEvent(accountId, 'sync.failed', {
      surface,
      lane,
      errorCode: classification.code,
      error: err?.message || String(err),
      retryable: classification.retryable,
      syncPosture: classification.posture,
    });
    throw err;
  }
}

async function skipSurfaceForPosture(accountId, lane, surface, posture) {
  const nextAllowedAt = posture?.nextAllowedAt ? new Date(posture.nextAllowedAt) : minutesFromNow(60);
  const metadata = {
    skipped: true,
    reason: posture?.reason || 'LinkedIn session is blocked; reconnect before syncing.',
    syncPosture: posture?.posture || 'blocked',
    nextAllowedAt: Number.isFinite(nextAllowedAt.getTime()) ? nextAllowedAt.toISOString() : null,
  };

  await updateCursor(accountId, surface, {
    coverage: 'blocked',
    nextRunAt: Number.isFinite(nextAllowedAt.getTime()) ? nextAllowedAt : minutesFromNow(60),
    success: false,
    metadata,
  });
  await recordEvent(accountId, 'sync.progress', {
    lane,
    surface,
    status: 'skipped',
    ...metadata,
  });
  return { status: 'skipped', itemsRead: 0, itemsWritten: 0, metadata };
}

async function removeScheduledJob(queue, schedulerId) {
  if (!queue || !schedulerId) return;
  if (typeof queue.removeJobScheduler === 'function') {
    await queue.removeJobScheduler(schedulerId).catch(() => {});
  }
  if (typeof queue.getJobSchedulers === 'function') {
    const schedulers = await queue.getJobSchedulers().catch(() => []);
    for (const scheduler of schedulers) {
      if (scheduler?.key === schedulerId || scheduler?.id === schedulerId) {
        await queue.removeJobScheduler(scheduler.key || scheduler.id).catch(() => {});
      }
    }
  }
  if (typeof queue.getRepeatableJobs === 'function') {
    const repeatables = await queue.getRepeatableJobs().catch(() => []);
    for (const repeatable of repeatables) {
      if (repeatable?.key === schedulerId || repeatable?.id === schedulerId) {
        await queue.removeRepeatableByKey(repeatable.key).catch(() => {});
      }
    }
  }

  if (typeof queue.getJobs === 'function') {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']).catch(() => []);
    for (const job of jobs) {
      if (job?.id === schedulerId) {
        await job.remove().catch(() => {});
      }
    }
  }
}

async function removeLegacyScheduledJobs(queue, schedulerIds = []) {
  for (const schedulerId of schedulerIds) {
    await removeScheduledJob(queue, schedulerId);
  }
}

function isShellConversation(conversation) {
  const externalId = String(conversation?.externalId || '');
  return externalId.startsWith('fallback-')
    || (!conversation?.participantProfileUrl && !conversation?.lastMessageText);
}

function shouldRefreshThread(previousConversation, nextConversation) {
  if (!previousConversation) return true;
  if (isShellConversation(nextConversation)) return true;
  if (['shell_only', 'failed', 'partial', 'resolving'].includes(String(previousConversation.syncState || ''))) {
    return true;
  }
  if ((previousConversation.messageCount || 0) <= 0) return true;
  if (Boolean(previousConversation.hasMoreHistory)) return true;
  if (String(previousConversation.contentHash || '') !== String(nextConversation.contentHash || '')) return true;
  if (String(previousConversation.threadUrl || '') !== String(nextConversation.threadUrl || '')) return true;
  return false;
}

function canonicalConversationId(accountId, conversation, resolvedChatId) {
  const rawResolved = String(resolvedChatId || '').trim();
  if (!rawResolved || rawResolved === conversation.externalId) {
    return conversation.id;
  }

  const unprefixed = rawResolved.startsWith(`${accountId}:`)
    ? rawResolved.slice(`${accountId}:`.length)
    : rawResolved;
  return `${accountId}:${unprefixed}`;
}

async function resolveThreadBatch(accountId, options = {}) {
  const currentPosture = await getSyncPosture(accountId);
  if (isBlockedPosture(currentPosture.posture)) {
    return {
      resolved: 0,
      failed: 0,
      messagesCaptured: 0,
      candidates: 0,
      browserRecycles: 0,
      duplicatesMerged: 0,
      duplicatesQuarantined: 0,
      lastThreadError: currentPosture.reason || 'LinkedIn session is blocked; reconnect before resolving threads.',
    };
  }

  const priority = options.priority || 'recent';
  const cadence = syncCadenceForPosture(currentPosture.posture);
  const limit = Math.min(
    options.limit || THREAD_RESOLUTION_LIMITS[priority] || THREAD_RESOLUTION_LIMITS.recent,
    priority === 'visible' ? options.limit || THREAD_RESOLUTION_LIMITS.visible : cadence.maxThreads
  );
  const candidates = await messageRepo.listThreadResolutionCandidates({
    accountId,
    conversationIds: options.conversationIds,
    limit,
  });

  let resolved = 0;
  let failed = 0;
  let messagesCaptured = 0;
  let browserRecycles = 0;
  let duplicatesMerged = 0;
  let duplicatesQuarantined = 0;
  let lastThreadError = null;
  let consecutiveBrowserFailures = 0;

  for (const conversation of candidates) {
    const posture = await getSyncPosture(accountId);
    if (isBlockedPosture(posture.posture)) {
      lastThreadError = posture.reason || 'LinkedIn session is blocked; reconnect before resolving threads.';
      break;
    }

    const nextAttempts = (conversation.resolveAttempts || 0) + 1;
    await messageRepo.upsertConversation({
      ...conversation,
      syncState: 'resolving',
      resolutionState: 'resolving',
      shellReason: 'Queued for background resolution.',
      resolveAttempts: nextAttempts,
      resolveError: null,
    });
    await recordEvent(accountId, 'conversation.resolving', {
      conversationId: conversation.id,
      resolveAttempts: nextAttempts,
    });

    try {
      const threadPayload = await reads.readThread({
        accountId,
        chatId: conversation.externalId || conversation.id,
        threadUrl: conversation.threadUrl || null,
        participantName: conversation.participantName,
        participantProfileUrl: conversation.participantProfileUrl,
        proxyUrl: options.proxyUrl,
        limit: options.threadLimit || 60,
      });

      const targetConversationId = canonicalConversationId(accountId, conversation, threadPayload.resolvedChatId);
      const messages = (threadPayload.items || []).map((item) => (
        normalizeMessage(accountId, targetConversationId, item)
      ));

      await messageRepo.upsertConversation({
        ...conversation,
        id: targetConversationId,
        externalId: targetConversationId.slice(`${accountId}:`.length),
        threadUrl: threadPayload.threadUrl || conversation.threadUrl || null,
        participantName: threadPayload.participant?.name && threadPayload.participant.name !== 'Unknown'
          ? threadPayload.participant.name
          : conversation.participantName,
        participantProfileUrl: threadPayload.participant?.profileUrl || conversation.participantProfileUrl,
        syncState: 'resolving',
        resolutionState: 'resolving',
        shellReason: 'Reading canonical LinkedIn thread.',
        resolveAttempts: nextAttempts,
        resolveError: null,
        syncCursor: threadPayload.cursor || conversation.syncCursor,
        hasMoreHistory: Boolean(threadPayload.hasMore),
      });
      for (const message of messages) {
        const saved = await messageRepo.upsertMessage(message);
        if (saved) {
          messagesCaptured += 1;
          if (saved?.__created === true) await recordEvent(accountId, 'message.created', {
            conversationId: targetConversationId,
            messageId: saved.id,
            sentAt: saved.sentAt,
          });
        }
      }

      await messageRepo.upsertConversation({
        ...conversation,
        id: targetConversationId,
        externalId: targetConversationId.slice(`${accountId}:`.length),
        threadUrl: threadPayload.threadUrl || conversation.threadUrl || null,
        participantName: threadPayload.participant?.name && threadPayload.participant.name !== 'Unknown'
          ? threadPayload.participant.name
          : conversation.participantName,
        participantProfileUrl: threadPayload.participant?.profileUrl || conversation.participantProfileUrl,
        syncState: messages.length > 0 || !String(targetConversationId).includes('fallback-') ? 'available' : 'partial',
        messageCount: messages.length,
        messageCountCanonical: messages.filter((message) => message.visibilityState === 'visible').length,
        resolutionState: messages.length > 0 ? 'available' : 'partial',
        lastResolvedAt: new Date(),
        resolveAttempts: nextAttempts,
        resolveError: null,
        shellReason: null,
        syncCursor: threadPayload.cursor || conversation.syncCursor,
        hasMoreHistory: Boolean(threadPayload.hasMore),
      });

      if (targetConversationId !== conversation.id) {
        const mergeResult = await messageRepo.mergeConversationInto(conversation.id, targetConversationId);
        duplicatesMerged += mergeResult?.duplicatesQuarantined || 0;
        duplicatesQuarantined += mergeResult?.duplicatesQuarantined || 0;
      }
      const persistedMessageCount = await messageRepo.countMessagesByConversation(targetConversationId);
      await messageRepo.upsertConversation({
        ...conversation,
        id: targetConversationId,
        externalId: targetConversationId.slice(`${accountId}:`.length),
        threadUrl: threadPayload.threadUrl || conversation.threadUrl || null,
        participantName: threadPayload.participant?.name && threadPayload.participant.name !== 'Unknown'
          ? threadPayload.participant.name
          : conversation.participantName,
        participantProfileUrl: threadPayload.participant?.profileUrl || conversation.participantProfileUrl,
        syncState: persistedMessageCount > 0 || !String(targetConversationId).includes('fallback-') ? 'available' : 'partial',
        messageCount: persistedMessageCount,
        messageCountCanonical: persistedMessageCount,
        resolutionState: persistedMessageCount > 0 ? 'available' : 'partial',
        lastResolvedAt: new Date(),
        resolveAttempts: nextAttempts,
        resolveError: null,
        shellReason: persistedMessageCount > 0 ? null : 'Thread resolved but did not yield canonical messages yet.',
        syncCursor: threadPayload.cursor || conversation.syncCursor,
        hasMoreHistory: Boolean(threadPayload.hasMore),
      });

      resolved += 1;
      consecutiveBrowserFailures = 0;
      await recordEvent(accountId, 'conversation.updated', {
        conversationId: targetConversationId,
        syncState: persistedMessageCount > 0 ? 'available' : 'partial',
        messageCount: persistedMessageCount,
      });
    } catch (err) {
      failed += 1;
      lastThreadError = err?.message || String(err);
      if (err?.browserFatal) {
        browserRecycles += 1;
        consecutiveBrowserFailures += 1;
      } else {
        consecutiveBrowserFailures = 0;
      }
      await messageRepo.upsertConversation({
        ...conversation,
        syncState: 'failed',
        resolutionState: 'failed',
        lastResolvedAt: conversation.lastResolvedAt || null,
        resolveAttempts: nextAttempts,
        resolveError: err?.message || String(err),
        shellReason: err?.message || String(err),
      });
      await recordEvent(accountId, 'thread.resolve_failed', {
        conversationId: conversation.id,
        error: err?.message || String(err),
        code: err?.code || 'THREAD_RESOLVE_FAILED',
      });
      if (consecutiveBrowserFailures >= 2) {
        break;
      }
    }
  }

  return {
    resolved,
    failed,
    messagesCaptured,
    candidates: candidates.length,
    browserRecycles,
    duplicatesMerged,
    duplicatesQuarantined,
    lastThreadError,
  };
}

async function syncInbox(accountId, options) {
  return runSurface(accountId, options.lane, 'inbox', async () => {
    const payload = await reads.readInbox({
      accountId,
      proxyUrl: options.proxyUrl,
      limit: options.limit || 25,
    });

    let written = 0;
    let shellConversations = 0;
    let resolvedThreads = 0;
    let messagesCaptured = 0;
    let threadCandidates = 0;
    let threadsAttempted = 0;
    let threadsRefreshed = 0;
    let threadFailures = 0;
    let browserRecycles = 0;
    let duplicatesMerged = 0;
    let duplicatesQuarantined = 0;
    let lastThreadError = null;
    const conversations = payload.items.map((item) => normalizeConversation(accountId, item));
    const refreshCandidates = [];

    // PERF (Phase 1.1): prefetch all prior conversation rows in one query instead of
    // N sequential getConversationById round-trips. shouldRefreshThread() only needs
    // a handful of fields, so we deliberately skip the _count include here.
    const previousById = new Map();
    if (conversations.length > 0) {
      const ids = conversations.map((c) => c.id);
      try {
        const prisma = getPrisma();
        const rows = await prisma.conversation.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            syncState: true,
            messageCount: true,
            hasMoreHistory: true,
            contentHash: true,
            threadUrl: true,
          },
        });
        for (const row of rows) previousById.set(row.id, row);
      } catch (err) {
        // Fall back to per-row reads only if the batch fails; preserves prior behavior.
        console.warn('[syncInbox] batch prefetch failed, falling back to per-row reads:', err?.message || err);
        for (const conversation of conversations) {
          const row = await messageRepo.getConversationById(conversation.id).catch(() => null);
          if (row) previousById.set(conversation.id, row);
        }
      }
    }

    for (let index = 0; index < conversations.length; index += 1) {
      const conversation = conversations[index];
      const source = payload.items[index] || {};
      const previousConversation = previousById.get(conversation.id) || null;

      if (isShellConversation(conversation)) {
        shellConversations += 1;
      }
      // The delta inbox item carries messageCount:0 for shell threads; since 0 is
      // a number, upsertConversation would persist it and clobber the stored
      // count for every non-refreshed thread. Strip the count fields from the
      // bulk upsert — the resolution path below sets the authoritative count.
      const { messageCount: _bulkMc, messageCountCanonical: _bulkMcc, ...conversationForBulkUpsert } = conversation;
      await messageRepo.upsertConversation(conversationForBulkUpsert);
      written += 1;
      await recordEvent(accountId, 'conversation.updated', { conversationId: conversation.id });

      if (shouldRefreshThread(previousConversation, conversation)) {
        refreshCandidates.push({ conversation, source });
      }
    }

    const threadLimit = options.lane === 'backfill'
      ? parsePositiveInt(process.env.UNIFIED_BACKFILL_THREAD_LIMIT, 30)
      : parsePositiveInt(process.env.UNIFIED_DELTA_THREAD_LIMIT, 12);
    const posture = await getSyncPosture(accountId);
    const cadence = syncCadenceForPosture(posture.posture);
    const defaultMaxThreads = options.lane === 'backfill'
      ? parsePositiveInt(process.env.UNIFIED_BACKFILL_MAX_THREADS, 2)
      : Math.min(parsePositiveInt(process.env.UNIFIED_DELTA_MAX_THREADS, cadence.maxThreads), cadence.maxThreads);
    const threadsToRead = refreshCandidates
      .slice(0, options.maxThreads || defaultMaxThreads);
    threadCandidates = refreshCandidates.length;
    let consecutiveBrowserFailures = 0;

    for (const { conversation, source } of threadsToRead) {
      const currentPosture = await getSyncPosture(accountId);
      if (isBlockedPosture(currentPosture.posture)) {
        lastThreadError = currentPosture.reason || 'LinkedIn session is blocked; reconnect before syncing inbox threads.';
        break;
      }
      threadsAttempted += 1;
      try {
        const threadPayload = await reads.readThread({
          accountId,
          chatId: conversation.externalId || conversation.id,
          threadUrl: source.threadUrl || source.url || null,
          participantName: conversation.participantName,
          participantProfileUrl: conversation.participantProfileUrl,
          proxyUrl: options.proxyUrl,
          limit: threadLimit,
        });

        const targetConversationId = canonicalConversationId(
          accountId,
          conversation,
          threadPayload.resolvedChatId
        );
        if (targetConversationId !== conversation.id) {
          resolvedThreads += 1;
        }

        const messages = (threadPayload.items || []).map((item) => (
          normalizeMessage(accountId, targetConversationId, item)
        ));

        await messageRepo.upsertConversation({
          ...conversation,
          id: targetConversationId,
          externalId: targetConversationId.slice(`${accountId}:`.length),
          threadUrl: threadPayload.threadUrl || source.threadUrl || source.url || conversation.threadUrl || null,
          participantName: threadPayload.participant?.name && threadPayload.participant.name !== 'Unknown'
            ? threadPayload.participant.name
            : conversation.participantName,
          participantProfileUrl: threadPayload.participant?.profileUrl || conversation.participantProfileUrl,
          syncState: 'resolving',
          resolutionState: 'resolving',
          shellReason: 'Refreshing canonical thread messages.',
          resolveError: null,
          syncCursor: threadPayload.cursor || conversation.syncCursor,
          hasMoreHistory: Boolean(threadPayload.hasMore),
        });
        // PERF (Phase 1.2): run upserts in bounded-parallel chunks. upsertMessage()
        // is idempotent and self-contained per row, so concurrency is safe. Keep the
        // chunk size small to avoid saturating the Prisma connection pool.
        const UPSERT_CHUNK = parsePositiveInt(process.env.UNIFIED_MESSAGE_UPSERT_CHUNK, 8);
        for (let i = 0; i < messages.length; i += UPSERT_CHUNK) {
          const chunk = messages.slice(i, i + UPSERT_CHUNK);
          const results = await Promise.all(
            chunk.map((message) => messageRepo.upsertMessage(message).catch((err) => {
              console.warn('[syncInbox] upsertMessage failed:', err?.message || err);
              return null;
            }))
          );
          for (const saved of results) {
            if (!saved) continue;
            written += 1;
            messagesCaptured += 1;
            if (saved.__created === true) {
              // Fire-and-forget event emission; ordering across messages is not critical.
              recordEvent(accountId, 'message.created', {
                conversationId: targetConversationId,
                messageId: saved.id,
                sentAt: saved.sentAt,
              }).catch(() => null);
            }
          }
        }

        await messageRepo.upsertConversation({
          ...conversation,
          id: targetConversationId,
          externalId: targetConversationId.slice(`${accountId}:`.length),
          threadUrl: threadPayload.threadUrl || source.threadUrl || source.url || conversation.threadUrl || null,
          participantName: threadPayload.participant?.name && threadPayload.participant.name !== 'Unknown'
            ? threadPayload.participant.name
            : conversation.participantName,
          participantProfileUrl: threadPayload.participant?.profileUrl || conversation.participantProfileUrl,
          syncState: messages.length > 0 || !String(targetConversationId).includes('fallback-') ? 'available' : 'partial',
          messageCount: messages.length,
          messageCountCanonical: messages.filter((message) => message.visibilityState === 'visible').length,
          resolutionState: messages.length > 0 ? 'available' : 'partial',
          lastResolvedAt: new Date(),
          resolveAttempts: conversation.resolveAttempts || 0,
          resolveError: null,
          shellReason: null,
          replacedByConversationId: null,
          hiddenReason: null,
          syncCursor: threadPayload.cursor || conversation.syncCursor,
          hasMoreHistory: Boolean(threadPayload.hasMore),
        });
        if (targetConversationId !== conversation.id) {
          const mergeResult = await messageRepo.mergeConversationInto(conversation.id, targetConversationId);
          duplicatesMerged += mergeResult?.duplicatesQuarantined || 0;
          duplicatesQuarantined += mergeResult?.duplicatesQuarantined || 0;
        }
        const persistedMessageCount = await messageRepo.countMessagesByConversation(targetConversationId);
        await messageRepo.upsertConversation({
          ...conversation,
          id: targetConversationId,
          externalId: targetConversationId.slice(`${accountId}:`.length),
          threadUrl: threadPayload.threadUrl || source.threadUrl || source.url || conversation.threadUrl || null,
          participantName: threadPayload.participant?.name && threadPayload.participant.name !== 'Unknown'
            ? threadPayload.participant.name
            : conversation.participantName,
          participantProfileUrl: threadPayload.participant?.profileUrl || conversation.participantProfileUrl,
          syncState: persistedMessageCount > 0 || !String(targetConversationId).includes('fallback-') ? 'available' : 'partial',
          messageCount: persistedMessageCount,
          messageCountCanonical: persistedMessageCount,
          resolutionState: persistedMessageCount > 0 ? 'available' : 'partial',
          lastResolvedAt: new Date(),
          resolveAttempts: conversation.resolveAttempts || 0,
          resolveError: null,
          shellReason: persistedMessageCount > 0 ? null : 'Thread refreshed without canonical messages.',
          replacedByConversationId: null,
          hiddenReason: null,
          syncCursor: threadPayload.cursor || conversation.syncCursor,
          hasMoreHistory: Boolean(threadPayload.hasMore),
        });
        threadsRefreshed += 1;
        consecutiveBrowserFailures = 0;
      } catch (err) {
        threadFailures += 1;
        lastThreadError = err?.message || String(err);
        if (err?.browserFatal) {
          browserRecycles += 1;
          consecutiveBrowserFailures += 1;
        } else {
          consecutiveBrowserFailures = 0;
        }
        await messageRepo.upsertConversation({
          ...conversation,
          syncState: 'failed',
          resolutionState: 'failed',
          resolveError: lastThreadError,
          shellReason: lastThreadError,
        }).catch(() => {});
        await recordEvent(accountId, 'thread.resolve_failed', {
          conversationId: conversation.id,
          error: lastThreadError,
          code: err?.code || 'THREAD_REFRESH_FAILED',
        }).catch(() => {});
        if (consecutiveBrowserFailures >= 2) {
          break;
        }
      }
    }

    const inboxCoverage = threadFailures > 0 && threadsRefreshed >= 0
      ? (payload.coverage === 'available' ? 'partial' : payload.coverage)
      : payload.coverage;

    const profileCount = await unifiedRepo.reconcileProfilesFromConversations(accountId);
    await updateCursor(accountId, 'inbox', {
      cursor: payload.cursor,
      highWatermark: conversations[0]?.lastMessageAt || new Date(),
      coverage: inboxCoverage,
      nextRunAt: minutesFromNow(options.lane === 'backfill' ? 30 : 1),
      metadata: {
        hasMore: payload.hasMore,
        conversations: conversations.length,
        profileCount,
        shellConversations,
        resolvedThreads,
        messagesCaptured,
        threadCandidates,
        threadsAttempted,
        threadsRefreshed,
        threadFailures,
        duplicatesMerged,
        duplicatesQuarantined,
        browserRecycles,
        lastThreadError,
        browserMinutesEstimate: Number((threadsAttempted * 0.35).toFixed(2)),
        syncPosture: posture.posture || 'healthy',
        nextAllowedAt: posture.nextAllowedAt || null,
        postureReason: posture.reason || null,
      },
    });

    return {
      itemsRead: payload.items.length,
      itemsWritten: written + profileCount,
      metadata: {
        conversations: conversations.length,
        profileCount,
        shellConversations,
        resolvedThreads,
        messagesCaptured,
        threadCandidates,
        threadsAttempted,
        threadsRefreshed,
        threadFailures,
        duplicatesMerged,
        duplicatesQuarantined,
        browserRecycles,
        lastThreadError,
        browserMinutesEstimate: Number((threadsAttempted * 0.35).toFixed(2)),
        syncPosture: posture.posture || 'healthy',
        nextAllowedAt: posture.nextAllowedAt || null,
        postureReason: posture.reason || null,
      },
    };
  });
}

async function resolveConversationThreads(accountId, options = {}) {
  const resolvedAccountId = await resolveCanonicalAccountId(accountId);
  const batch = await resolveThreadBatch(resolvedAccountId, options);
  await updateCursor(resolvedAccountId, 'inbox', {
    coverage: batch.failed > 0 ? 'partial' : 'available',
    nextRunAt: minutesFromNow(options.priority === 'visible' ? 1 : 3),
    metadata: {
      resolvingThreads: 0,
      resolvedThreads: batch.resolved,
      threadResolveFailures: batch.failed,
      messagesCaptured: batch.messagesCaptured,
      browserRecycles: batch.browserRecycles,
      duplicatesMerged: batch.duplicatesMerged,
      duplicatesQuarantined: batch.duplicatesQuarantined,
      lastThreadError: batch.lastThreadError,
      priority: options.priority || 'recent',
    },
  });
  await recordEvent(resolvedAccountId, 'sync.progress', {
    lane: 'threadResolve',
    status: 'completed',
    resolvedThreads: batch.resolved,
    threadResolveFailures: batch.failed,
    messagesCaptured: batch.messagesCaptured,
    browserRecycles: batch.browserRecycles,
    duplicatesMerged: batch.duplicatesMerged,
    duplicatesQuarantined: batch.duplicatesQuarantined,
    lastThreadError: batch.lastThreadError,
  });
  return {
    accountId: resolvedAccountId,
    ...batch,
  };
}

async function syncNotifications(accountId, options) {
  return runSurface(accountId, options.lane, 'notifications', async () => {
    const payload = await provider.readNotifications({
      accountId,
      proxyUrl: options.proxyUrl,
      limit: options.limit || 50,
    });

    let written = 0;
    for (const item of payload.items) {
      const notification = normalizeNotification(accountId, item);
      const saved = await unifiedRepo.upsertNotification(notification);
      written += 1;
      if (saved?.__created === true) await recordEvent(accountId, 'notification.created', {
        notificationId: saved.id,
        occurredAt: saved.occurredAt,
      });
    }

    const posture = await getSyncPosture(accountId);
    const cadence = syncCadenceForPosture(posture.posture);
    await updateCursor(accountId, 'notifications', {
      highWatermark: payload.items[0]?.occurredAt || new Date(),
      coverage: payload.coverage,
      nextRunAt: minutesFromNow(cadence.notificationMinutes),
      metadata: {
        count: payload.items.length,
        syncPosture: posture.posture || 'healthy',
        nextAllowedAt: posture.nextAllowedAt || null,
      },
    });

    return { itemsRead: payload.items.length, itemsWritten: written };
  });
}

async function syncConnections(accountId, options) {
  return runSurface(accountId, options.lane, 'connections', async () => {
    const payload = await reads.readConnections({
      accountId,
      proxyUrl: options.proxyUrl,
      limit: options.limit || 100,
    });

    // PERF: bounded-parallel chunks instead of ~200 fully-serialized round-trips
    // (each upsertConnection does a profile upsert + connection upsert). No
    // contentHash short-circuit here — lastSeenAt is the ordering/pagination key.
    let written = 0;
    const ENTITY_UPSERT_CHUNK = parsePositiveInt(process.env.UNIFIED_ENTITY_UPSERT_CHUNK, 8);
    for (let i = 0; i < payload.items.length; i += ENTITY_UPSERT_CHUNK) {
      const chunk = payload.items.slice(i, i + ENTITY_UPSERT_CHUNK);
      const results = await Promise.all(
        chunk.map((item) => unifiedRepo.upsertConnection(normalizeConnection(accountId, item)).catch((err) => {
          console.warn('[syncConnections] upsertConnection failed:', err?.message || err);
          return null;
        }))
      );
      for (const saved of results) if (saved) written += 1;
    }

    const posture = await getSyncPosture(accountId);
    const cadence = syncCadenceForPosture(posture.posture);
    const nextMinutes = options.lane === 'delta' ? cadence.connectionsDeltaMinutes : cadence.backfillMinutes;
    await updateCursor(accountId, 'connections', {
      coverage: payload.coverage,
      nextRunAt: minutesFromNow(nextMinutes),
      metadata: {
        count: payload.items.length,
        itemsRead: payload.items.length,
        itemsWritten: written,
        coverage: payload.coverage,
        syncPosture: posture.posture || 'healthy',
        nextAllowedAt: posture.nextAllowedAt || null,
        diagnostics: payload.diagnostics || null,
      },
    });

    return {
      itemsRead: payload.items.length,
      itemsWritten: written,
      metadata: {
        diagnostics: payload.diagnostics || null,
      },
    };
  });
}

async function syncInvitations(accountId, options) {
  return runSurface(accountId, options.lane, 'invitations', async () => {
    const directions = ['received', 'sent'];
    const results = {};
    const failures = {};

    for (const direction of directions) {
      try {
        results[direction] = await provider.readInvitations({
          accountId,
          proxyUrl: options.proxyUrl,
          direction,
          limit: options.limit || 50,
        });
      } catch (err) {
        failures[direction] = err;
      }
    }

    const items = directions.flatMap((direction) => results[direction]?.items || []);
    // PERF: bounded-parallel chunks (mirror of syncConnections).
    let written = 0;
    const ENTITY_UPSERT_CHUNK = parsePositiveInt(process.env.UNIFIED_ENTITY_UPSERT_CHUNK, 8);
    for (let i = 0; i < items.length; i += ENTITY_UPSERT_CHUNK) {
      const chunk = items.slice(i, i + ENTITY_UPSERT_CHUNK);
      const results2 = await Promise.all(
        chunk.map((item) => unifiedRepo.upsertInvitation(normalizeInvitation(accountId, item)).catch((err) => {
          console.warn('[syncInvitations] upsertInvitation failed:', err?.message || err);
          return null;
        }))
      );
      for (const saved of results2) if (saved) written += 1;
    }

    const failureEntries = Object.entries(failures);
    const primaryFailure = failureEntries[0]?.[1] || null;
    const primaryClassification = primaryFailure ? retryClassification(primaryFailure) : null;
    const propagateInvitationBlock = primaryFailure ? invitationFailureImpliesAccountBlock(primaryFailure) : false;
    const receivedCoverage = results.received?.coverage || (failures.received ? (retryClassification(failures.received).coverage || 'partial') : 'unavailable');
    const sentCoverage = results.sent?.coverage || (failures.sent ? (retryClassification(failures.sent).coverage || 'partial') : 'unavailable');

    let coverage = 'available';
    if (failureEntries.length > 0) {
      coverage = primaryClassification?.coverage === 'blocked' && items.length === 0 ? 'blocked' : 'partial';
    } else if (results.received?.coverage === 'empty' && results.sent?.coverage === 'empty') {
      coverage = 'empty';
    } else if (!items.length) {
      coverage = 'partial';
    }

    const blockedNextAllowedAt = primaryClassification && isBlockedPosture(primaryClassification.posture) && propagateInvitationBlock
      ? minutesFromNow(primaryClassification.backoffMinutes)
      : null;

    if (!results.received && !results.sent && !propagateInvitationBlock) {
      await updateCursor(accountId, 'invitations', {
        coverage,
        nextRunAt: minutesFromNow(syncCadenceForPosture((await getSyncPosture(accountId)).posture).invitationsMinutes),
        metadata: {
          receivedCount: 0,
          sentCount: 0,
          receivedCoverage,
          sentCoverage,
          nextAllowedAt: null,
          surfaceScopedFailure: true,
          failures: failureEntries.map(([direction, err]) => ({
            direction,
            code: err?.code || 'SYNC_FAILED',
            error: err?.message || String(err),
            diagnostics: err?.diagnostics || null,
          })),
          diagnostics: {
            received: failures.received?.diagnostics || null,
            sent: failures.sent?.diagnostics || null,
          },
        },
      });

      return {
        itemsRead: 0,
        itemsWritten: 0,
        metadata: {
          coverage,
          receivedCount: 0,
          sentCount: 0,
          receivedCoverage,
          sentCoverage,
          failureCount: failureEntries.length,
          lastError: primaryFailure?.message || null,
          surfaceScopedFailure: true,
          diagnostics: {
            received: failures.received?.diagnostics || null,
            sent: failures.sent?.diagnostics || null,
          },
        },
      };
    }

    if (!results.received && !results.sent) {
      throw failures.sent || failures.received || new Error(`Invitation sync failed for ${accountId}.`);
    }

    if (blockedNextAllowedAt) {
      await setSyncPosture(accountId, primaryClassification.posture, {
        surface: 'invitations',
        lane: options.lane,
        reason: primaryFailure?.message || String(primaryFailure),
        errorCode: primaryFailure?.code || primaryClassification.code || 'INVITATIONS_BLOCKED',
        warningUrl: primaryFailure?.warningUrl || primaryFailure?.diagnostics?.finalUrl || null,
        nextAllowedAt: blockedNextAllowedAt,
      }).catch(() => null);
    }

    const posture = await getSyncPosture(accountId);
    const cadence = syncCadenceForPosture(posture.posture);
    await updateCursor(accountId, 'invitations', {
      coverage,
      nextRunAt: blockedNextAllowedAt || minutesFromNow(cadence.invitationsMinutes),
      metadata: {
        receivedCount: results.received?.items?.length || 0,
        sentCount: results.sent?.items?.length || 0,
        receivedCoverage,
        sentCoverage,
        nextAllowedAt: blockedNextAllowedAt ? blockedNextAllowedAt.toISOString() : null,
        failures: failureEntries.map(([direction, err]) => ({
          direction,
          code: err?.code || 'SYNC_FAILED',
          error: err?.message || String(err),
          diagnostics: err?.diagnostics || null,
        })),
        diagnostics: {
          received: results.received?.diagnostics || failures.received?.diagnostics || null,
          sent: results.sent?.diagnostics || failures.sent?.diagnostics || null,
        },
      },
    });

    return {
      itemsRead: items.length,
      itemsWritten: written,
      metadata: {
        coverage,
        receivedCount: results.received?.items?.length || 0,
        sentCount: results.sent?.items?.length || 0,
        receivedCoverage,
        sentCoverage,
        failureCount: failureEntries.length,
        lastError: primaryFailure?.message || null,
        diagnostics: {
          received: results.received?.diagnostics || failures.received?.diagnostics || null,
          sent: results.sent?.diagnostics || failures.sent?.diagnostics || null,
        },
      },
    };
  });
}

async function markPlannedSurface(accountId, surface) {
  return runSurface(accountId, 'coverage', surface, async () => {
    await updateCursor(accountId, surface, {
      coverage: 'planned',
      nextRunAt: minutesFromNow(180),
      metadata: {
        reason: 'Coverage marker for a supported roadmap surface. No backend read path is enabled yet.',
      },
    });
    return { itemsRead: 0, itemsWritten: 0 };
  });
}

async function syncAccountUnified(accountId, options = {}) {
  const resolvedAccountId = await resolveCanonicalAccountId(accountId);
  const lane = options.lane || 'delta';
  const surfaces = options.surfaces || (lane === 'backfill'
    ? [...BACKFILL_SURFACES, ...PLANNED_SURFACES]
    : LIVE_SURFACES);
  const proxyUrl = options.proxyUrl ?? process.env.PROXY_URL ?? null;
  const result = { accountId: resolvedAccountId, lane, surfaces: {}, startedAt: new Date().toISOString() };

  try {
    await accountRepo.upsertAccount(resolvedAccountId, resolvedAccountId);
    await recordEvent(resolvedAccountId, 'sync.progress', { lane, status: 'started', surfaces });

    const health = await provider.getAccountHealth(resolvedAccountId);
    const currentPosture = await getSyncPosture(resolvedAccountId);
    if (health.coverage === 'available' && currentPosture.posture === 'healthy') {
      await clearSyncPosture(resolvedAccountId, 'Session available before sync').catch(() => null);
    }
    await updateCursor(resolvedAccountId, 'account_health', {
      coverage: isBlockedPosture(currentPosture.posture) ? 'blocked' : health.coverage,
      nextRunAt: minutesFromNow(5),
      metadata: {
        ...health,
        syncPosture: currentPosture.posture || 'healthy',
        postureReason: currentPosture.reason || null,
        nextAllowedAt: currentPosture.nextAllowedAt || null,
      },
    });

    for (const surface of surfaces) {
      try {
        const posture = await getSyncPosture(resolvedAccountId);
        if (!options.forceBrowserSync && isBlockedPosture(posture.posture)) {
          result.surfaces[surface] = await skipSurfaceForPosture(resolvedAccountId, lane, surface, posture);
          continue;
        }
        if (surface === 'inbox') result.surfaces.inbox = await syncInbox(resolvedAccountId, { ...options, lane, proxyUrl });
        else if (surface === 'notifications') result.surfaces.notifications = await syncNotifications(resolvedAccountId, { ...options, lane, proxyUrl });
        else if (surface === 'connections') result.surfaces.connections = await syncConnections(resolvedAccountId, { ...options, lane, proxyUrl });
        else if (surface === 'invitations') result.surfaces.invitations = await syncInvitations(resolvedAccountId, { ...options, lane, proxyUrl });
        else if (surface === 'posts') {
          await markPlannedSurface(resolvedAccountId, 'posts');
          result.surfaces.posts = { coverage: 'planned' };
        } else if (PLANNED_SURFACES.includes(surface)) {
          await markPlannedSurface(resolvedAccountId, surface);
          result.surfaces[surface] = { coverage: 'planned' };
        }
        await recordEvent(resolvedAccountId, 'sync.progress', { lane, surface, status: 'completed' });
      } catch (err) {
        result.surfaces[surface] = {
          status: 'failed',
          error: err?.message || String(err),
          code: err?.code || 'SYNC_FAILED',
        };
        if (options.stopOnError) throw err;
      }
    }

    result.completedAt = new Date().toISOString();
    await accountRepo.updateLastSyncedAt(resolvedAccountId).catch(() => {});
    await recordEvent(resolvedAccountId, 'sync.progress', { lane, status: 'completed', surfaces });
    return result;
  } finally {
    if (process.env.BROWSER_KEEP_CONTEXT_AFTER_SYNC !== '1') {
      await cleanupContext(resolvedAccountId).catch(() => {});
    }
  }
}

async function syncAllUnifiedAccounts(options = {}) {
  const accountIds = dedupeAccountIds(options.accountIds || await listKnownAccountIds());
  const results = [];
  for (const accountId of accountIds) {
    results.push(await syncAccountUnified(accountId, options));
  }
  return { count: results.length, results };
}

async function queueUnifiedSync(accountId, options = {}) {
  const resolvedAccountId = await resolveCanonicalAccountId(accountId);
  const queue = getQueue(resolvedAccountId || 'default');
  const lane = options.lane || 'delta';
  const surfaces = normalizeSurfaces(options.surfaces, lane);
  const posture = await getSyncPosture(resolvedAccountId);
  if (!options.forceBrowserSync && isBlockedPosture(posture.posture) && touchesBrowserSurface(surfaces)) {
    throw createSyncBlockedError(resolvedAccountId, posture, surfaces.join(', ') || lane);
  }
  const jobId = sanitizeJobId(buildUnifiedSyncJobId(resolvedAccountId, lane, surfaces));
  const existing = await getExistingQueuedJob(queue, jobId);
  if (existing) {
    return existing;
  }
  return queue.add('unifiedSync', {
    ...options,
    accountId: resolvedAccountId,
    lane,
    surfaces,
    requestHash: stableHash({
      accountId: resolvedAccountId,
      lane,
      surfaces,
    }),
  }, {
    jobId,
    attempts: lane === 'backfill' ? 2 : 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 86400, count: 200 },
  });
}

async function queueThreadResolution(accountId, options = {}) {
  const resolvedAccountId = await resolveCanonicalAccountId(accountId);
  const queue = getQueue(resolvedAccountId || 'default');
  const priority = options.priority || 'recent';
  const posture = await getSyncPosture(resolvedAccountId);
  if (!options.forceBrowserSync && isBlockedPosture(posture.posture)) {
    throw createSyncBlockedError(resolvedAccountId, posture, 'thread resolution');
  }
  const jobId = sanitizeJobId(buildThreadResolveJobId(resolvedAccountId, options));
  const existing = await getExistingQueuedJob(queue, jobId);
  if (existing) {
    return existing;
  }
  return queue.add('threadResolve', {
    ...options,
    accountId: resolvedAccountId,
    priority,
    requestHash: stableHash({
      accountId: resolvedAccountId,
      priority,
      conversationIds: options.conversationIds || null,
      limit: options.limit || null,
    }),
  }, {
    jobId,
    priority: priority === 'visible' ? 1 : priority === 'recent' ? 2 : 3,
    attempts: 2,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 86400, count: 200 },
  });
}

async function scheduleAdaptiveSync() {
  await trimHistoricalSyncRuns();
  const ids = dedupeAccountIds(await listKnownAccountIds());
  const healthyDeltaMinutes = parsePositiveInt(process.env.SYNC_INTERVAL_MINUTES, 5);
  const healthyBackfillMinutes = parsePositiveInt(process.env.BACKFILL_INTERVAL_MINUTES, 60);
  const healthyConnectionsDeltaMinutes = parsePositiveInt(process.env.CONNECTIONS_DELTA_INTERVAL_MINUTES, 15);
  const healthyInvitationsMinutes = parsePositiveInt(process.env.INVITATIONS_INTERVAL_MINUTES, 45);

  for (const [index, accountId] of ids.entries()) {
    const queue = getQueue(accountId);
    const deltaJobId = `delta:${accountId}:inbox`;
    const notificationsJobId = `delta:${accountId}:notifications`;
    const connectionsDeltaJobId = `sync:${accountId}:delta:connections`;
    const connectionsBackfillJobId = `sync:${accountId}:backfill:connections`;
    const invitationsJobId = `sync:${accountId}:backfill:invitations`;
    const legacySchedulerIds = [
      `connections:${accountId}:delta`,
      `connections:${accountId}:backfill`,
      `invitations:${accountId}:backfill`,
    ];
    const offsetMs = index * 15_000;
    const posture = await getSyncPosture(accountId);

    if (isBlockedPosture(posture.posture)) {
      await removeScheduledJob(queue, deltaJobId);
      await removeScheduledJob(queue, notificationsJobId);
      await removeScheduledJob(queue, connectionsDeltaJobId);
      await removeScheduledJob(queue, connectionsBackfillJobId);
      await removeScheduledJob(queue, invitationsJobId);
      await removeLegacyScheduledJobs(queue, legacySchedulerIds);
      await removeQueuedJobs(queue, (job) => (
        ['unifiedSync', 'threadResolve'].includes(String(job?.name || ''))
        && String(job?.data?.accountId || '') === accountId
      ));
      continue;
    }

    const cadence = syncCadenceForPosture(posture.posture);
    const deltaMinutes = posture.posture === 'healthy' ? healthyDeltaMinutes : cadence.deltaMinutes;
    const backfillMinutes = posture.posture === 'healthy' ? healthyBackfillMinutes : cadence.backfillMinutes;
    const connectionsDeltaMinutes = posture.posture === 'healthy'
      ? healthyConnectionsDeltaMinutes
      : Math.max(cadence.deltaMinutes, 10);
    const invitationsMinutes = posture.posture === 'healthy'
      ? healthyInvitationsMinutes
      : Math.max(cadence.notificationMinutes, 30);
    await removeLegacyScheduledJobs(queue, legacySchedulerIds);

    if (typeof queue.upsertJobScheduler === 'function') {
      await queue.upsertJobScheduler(deltaJobId, {
        every: deltaMinutes * 60_000,
      }, {
        name: 'unifiedSync',
        data: { accountId, lane: 'delta', surfaces: ['inbox'], maxThreads: cadence.maxThreads },
        opts: { jobId: sanitizeJobId(deltaJobId) },
      });
      await queue.upsertJobScheduler(notificationsJobId, {
        every: cadence.notificationMinutes * 60_000,
      }, {
        name: 'unifiedSync',
        data: { accountId, lane: 'delta', surfaces: ['notifications'], maxThreads: cadence.maxThreads },
        opts: { jobId: sanitizeJobId(notificationsJobId) },
      });
      await queue.upsertJobScheduler(connectionsDeltaJobId, {
        every: connectionsDeltaMinutes * 60_000,
      }, {
        name: 'unifiedSync',
        data: { accountId, lane: 'delta', surfaces: ['connections'], maxThreads: 1 },
        opts: { jobId: sanitizeJobId(connectionsDeltaJobId) },
      });
      await queue.upsertJobScheduler(connectionsBackfillJobId, {
        every: backfillMinutes * 60_000,
      }, {
        name: 'unifiedSync',
        data: { accountId, lane: 'backfill', surfaces: ['connections'], maxThreads: 1 },
        opts: { jobId: sanitizeJobId(connectionsBackfillJobId) },
      });
      await queue.upsertJobScheduler(invitationsJobId, {
        every: invitationsMinutes * 60_000,
      }, {
        name: 'unifiedSync',
        data: { accountId, lane: 'backfill', surfaces: ['invitations'], maxThreads: 1 },
        opts: { jobId: sanitizeJobId(invitationsJobId) },
      });
    } else {
      await queue.add('unifiedSync', { accountId, lane: 'delta', surfaces: ['inbox'], maxThreads: cadence.maxThreads }, {
        repeat: { every: deltaMinutes * 60_000 },
        jobId: sanitizeJobId(deltaJobId),
        delay: offsetMs,
      });
      await queue.add('unifiedSync', { accountId, lane: 'delta', surfaces: ['notifications'], maxThreads: cadence.maxThreads }, {
        repeat: { every: cadence.notificationMinutes * 60_000 },
        jobId: sanitizeJobId(notificationsJobId),
        delay: offsetMs + 10_000,
      });
      await queue.add('unifiedSync', { accountId, lane: 'delta', surfaces: ['connections'], maxThreads: 1 }, {
        repeat: { every: connectionsDeltaMinutes * 60_000 },
        jobId: sanitizeJobId(connectionsDeltaJobId),
        delay: offsetMs + 30_000,
      });
      await queue.add('unifiedSync', { accountId, lane: 'backfill', surfaces: ['connections'], maxThreads: 1 }, {
        repeat: { every: backfillMinutes * 60_000 },
        jobId: sanitizeJobId(connectionsBackfillJobId),
        delay: offsetMs + 40_000,
      });
      await queue.add('unifiedSync', { accountId, lane: 'backfill', surfaces: ['invitations'], maxThreads: 1 }, {
        repeat: { every: invitationsMinutes * 60_000 },
        jobId: sanitizeJobId(invitationsJobId),
        delay: offsetMs + 50_000,
      });
    }
  }

  return { scheduledAccounts: ids.length, syncIntervalMinutes: healthyDeltaMinutes, backfillIntervalMinutes: healthyBackfillMinutes };
}

module.exports = {
  LIVE_SURFACES,
  BACKFILL_SURFACES,
  PLANNED_SURFACES,
  parsePositiveInt,
  syncAccountUnified,
  syncAllUnifiedAccounts,
  queueUnifiedSync,
  resolveConversationThreads,
  queueThreadResolution,
  scheduleAdaptiveSync,
  retryClassification,
};
