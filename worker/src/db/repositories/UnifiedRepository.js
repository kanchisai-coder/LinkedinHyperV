'use strict';

const { getPrisma } = require('../prisma');
const { getRedis } = require('../../redisClient');

const SYNC_RUN_SUMMARY_KEY = 'sync-runs:summary';

function takeLimit(limit, fallback = 100, max = 500) {
  const parsed = parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function markPersistResult(row, created) {
  if (!row) return row;
  Object.defineProperty(row, '__created', {
    value: Boolean(created),
    enumerable: false,
    configurable: true,
  });
  return row;
}

class UnifiedRepository {
  async upsertProfile(profile) {
    const prisma = getPrisma();
    return prisma.profile.upsert({
      where: {
        accountId_profileUrl: {
          accountId: profile.accountId,
          profileUrl: profile.profileUrl,
        },
      },
      update: {
        externalId: profile.externalId,
        publicIdentifier: profile.publicIdentifier,
        name: profile.name,
        headline: profile.headline,
        location: profile.location,
        avatarUrl: profile.avatarUrl,
        company: profile.company,
        raw: profile.raw,
        contentHash: profile.contentHash,
        source: profile.source,
        lastSeenAt: new Date(),
      },
      create: profile,
    });
  }

  async upsertConnection(connection) {
    const prisma = getPrisma();
    const profile = connection.profile
      ? await this.upsertProfile(connection.profile)
      : null;

    return prisma.connection.upsert({
      where: {
        accountId_profileUrl: {
          accountId: connection.accountId,
          profileUrl: connection.profileUrl,
        },
      },
      update: {
        profileId: profile?.id || undefined,
        name: connection.name,
        headline: connection.headline,
        connectedAt: connection.connectedAt,
        status: connection.status,
        source: connection.source,
        raw: connection.raw,
        contentHash: connection.contentHash,
        lastSeenAt: new Date(),
      },
      create: {
        accountId: connection.accountId,
        profileId: profile?.id || null,
        profileUrl: connection.profileUrl,
        name: connection.name,
        headline: connection.headline,
        connectedAt: connection.connectedAt,
        status: connection.status,
        source: connection.source,
        raw: connection.raw,
        contentHash: connection.contentHash,
      },
    });
  }

  async upsertInvitation(invitation) {
    const prisma = getPrisma();
    const profile = invitation.profile
      ? await this.upsertProfile(invitation.profile)
      : null;

    return prisma.invitation.upsert({
      where: {
        accountId_profileUrl_direction_status: {
          accountId: invitation.accountId,
          profileUrl: invitation.profileUrl,
          direction: invitation.direction,
          status: invitation.status,
        },
      },
      update: {
        profileId: profile?.id || undefined,
        name: invitation.name,
        note: invitation.note,
        sentAt: invitation.sentAt,
        receivedAt: invitation.receivedAt,
        source: invitation.source,
        raw: invitation.raw,
        contentHash: invitation.contentHash,
        lastSeenAt: new Date(),
      },
      create: {
        accountId: invitation.accountId,
        profileId: profile?.id || null,
        profileUrl: invitation.profileUrl,
        name: invitation.name,
        note: invitation.note,
        direction: invitation.direction,
        status: invitation.status,
        sentAt: invitation.sentAt,
        receivedAt: invitation.receivedAt,
        source: invitation.source,
        raw: invitation.raw,
        contentHash: invitation.contentHash,
      },
    });
  }

  async upsertNotification(notification) {
    const prisma = getPrisma();
    const profile = notification.profile
      ? await this.upsertProfile(notification.profile)
      : null;

    const payload = {
      profileId: profile?.id || null,
      type: notification.type,
      title: notification.title,
      text: notification.text,
      url: notification.url,
      occurredAt: notification.occurredAt,
      seenAt: notification.seenAt,
      source: notification.source,
      raw: notification.raw,
      contentHash: notification.contentHash,
    };

    const [existingByExternalId, existingByContentHash] = await Promise.all([
      notification.externalId
        ? prisma.notification.findFirst({
            where: {
              accountId: notification.accountId,
              externalId: notification.externalId,
            },
          })
        : Promise.resolve(null),
      notification.contentHash
        ? prisma.notification.findFirst({
            where: {
              accountId: notification.accountId,
              contentHash: notification.contentHash,
            },
          })
        : Promise.resolve(null),
    ]);

    const survivor = existingByExternalId || existingByContentHash;
    const duplicate = existingByExternalId && existingByContentHash && existingByExternalId.id !== existingByContentHash.id
      ? (existingByExternalId.id === survivor?.id ? existingByContentHash : existingByExternalId)
      : null;

    if (duplicate) {
      await prisma.notification.delete({
        where: { id: duplicate.id },
      }).catch(() => null);
    }

    if (survivor) {
      try {
        return markPersistResult(await prisma.notification.update({
          where: { id: survivor.id },
          data: {
            externalId: notification.externalId || survivor.externalId || null,
            ...payload,
          },
        }), false);
      } catch (updateError) {
        if (updateError?.code !== 'P2002') {
          throw updateError;
        }

        return markPersistResult(await prisma.notification.update({
          where: { id: survivor.id },
          data: {
            externalId: notification.externalId || survivor.externalId || null,
            profileId: payload.profileId,
            type: payload.type,
            title: payload.title,
            text: payload.text,
            url: payload.url,
            occurredAt: payload.occurredAt,
            seenAt: payload.seenAt,
            source: payload.source,
            raw: payload.raw,
          },
        }), false);
      }
    }

    return markPersistResult(await prisma.notification.create({
      data: {
        accountId: notification.accountId,
        externalId: notification.externalId,
        ...payload,
      },
    }), true);
  }

  async upsertPost(post) {
    const prisma = getPrisma();
    const where = post.externalId
      ? {
          accountId_externalId: {
            accountId: post.accountId,
            externalId: post.externalId,
          },
        }
      : {
          accountId_contentHash: {
            accountId: post.accountId,
            contentHash: post.contentHash,
          },
        };

    return prisma.post.upsert({
      where,
      update: {
        authorName: post.authorName,
        authorUrl: post.authorUrl,
        text: post.text,
        url: post.url,
        postedAt: post.postedAt,
        source: post.source,
        raw: post.raw,
        contentHash: post.contentHash,
        lastSeenAt: new Date(),
      },
      create: post,
    });
  }

  async saveRawSnapshot({ accountId, surface, externalId, payload, contentHash, retentionUntil }) {
    const prisma = getPrisma();
    return prisma.rawSnapshot.upsert({
      where: {
        accountId_surface_contentHash: {
          accountId,
          surface,
          contentHash,
        },
      },
      update: {
        externalId,
        payload,
        retentionUntil,
        capturedAt: new Date(),
      },
      create: {
        accountId,
        surface,
        externalId,
        payload,
        contentHash,
        retentionUntil,
      },
    });
  }

  async startSyncRun({ accountId, lane, surface, metadata }) {
    const prisma = getPrisma();
    return prisma.syncRun.create({
      data: {
        accountId,
        lane,
        surface,
        status: 'running',
        metadata,
      },
    });
  }

  async completeSyncRun(id, { status, itemsRead = 0, itemsWritten = 0, errorCode, errorMessage, metadata, startedAt }) {
    const prisma = getPrisma();
    const completedAt = new Date();
    // Prefer the caller-supplied startedAt (the DB-assigned create timestamp) to
    // avoid an extra findUnique per surface completion. Fall back to a lookup for
    // any legacy caller that doesn't pass it.
    let effectiveStartedAt = startedAt;
    if (!effectiveStartedAt) {
      const existing = await prisma.syncRun.findUnique({ where: { id } });
      effectiveStartedAt = existing?.startedAt || null;
    }
    const durationMs = effectiveStartedAt
      ? completedAt.getTime() - new Date(effectiveStartedAt).getTime()
      : null;

    return prisma.syncRun.update({
      where: { id },
      data: {
        status,
        completedAt,
        durationMs,
        itemsRead,
        itemsWritten,
        errorCode,
        errorMessage,
        metadata,
      },
    });
  }

  async upsertSyncCursor({ accountId, surface, cursor, highWatermark, coverage, lagSeconds, nextRunAt, metadata, success = true }) {
    const prisma = getPrisma();
    const now = new Date();
    return prisma.syncCursor.upsert({
      where: {
        accountId_surface: {
          accountId,
          surface,
        },
      },
      update: {
        cursor,
        highWatermark,
        coverage,
        lagSeconds,
        nextRunAt,
        metadata,
        lastSuccessAt: success ? now : undefined,
        lastFailureAt: success ? undefined : now,
        failureCount: success ? 0 : { increment: 1 },
      },
      create: {
        accountId,
        surface,
        cursor,
        highWatermark,
        coverage,
        lagSeconds,
        nextRunAt,
        metadata,
        lastSuccessAt: success ? now : null,
        lastFailureAt: success ? null : now,
        failureCount: success ? 0 : 1,
      },
    });
  }

  async reconcileProfilesFromConversations(accountId) {
    const prisma = getPrisma();
    const conversations = await prisma.conversation.findMany({
      where: {
        accountId,
        participantProfileUrl: { not: null },
      },
      take: 500,
      orderBy: { lastSeenAt: 'desc' },
    });

    // Dedupe by profileUrl (ordered lastSeenAt desc → first seen is newest).
    const byUrl = new Map();
    for (const conv of conversations) {
      const url = conv.participantProfileUrl;
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, conv);
    }
    const urls = [...byUrl.keys()];
    if (urls.length === 0) return 0;

    // Reconcile is a BACKFILL for conversation participants who have no profile
    // row yet. It must never overwrite an existing profile's content — the
    // connection sync owns that, and the old per-row upsert clobbered durable
    // externalId + enrichment with the URL/nulls on every inbox sync (and could
    // hit @@unique([accountId, externalId])). So: insert only the missing ones,
    // and bulk-refresh lastSeenAt for the rest — two queries instead of ~500.
    const existing = await prisma.profile.findMany({
      where: { accountId, profileUrl: { in: urls } },
      select: { profileUrl: true },
    });
    const existingSet = new Set(existing.map((p) => p.profileUrl));

    const existingUrls = urls.filter((u) => existingSet.has(u));
    if (existingUrls.length > 0) {
      await prisma.profile.updateMany({
        where: { accountId, profileUrl: { in: existingUrls } },
        data: { lastSeenAt: new Date() },
      });
    }

    const newRows = [];
    for (const [url, conv] of byUrl) {
      if (existingSet.has(url)) continue;
      newRows.push({
        accountId,
        profileUrl: url,
        // name is a required column; fall back to the URL when the conversation
        // has no participant name yet.
        name: conv.participantName || url,
        avatarUrl: conv.participantAvatarUrl || null,
        raw: { sourceConversationId: conv.id },
        contentHash: conv.contentHash || null,
        source: 'conversation',
      });
    }

    if (newRows.length === 0) return 0;
    // skipDuplicates absorbs races on either unique constraint.
    const res = await prisma.profile.createMany({ data: newRows, skipDuplicates: true });
    return res.count;
  }

  async listAccounts() {
    return getPrisma().account.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async listProfiles({ accountId, limit = 100, cursor }) {
    const prisma = getPrisma();
    return prisma.profile.findMany({
      where: {
        ...(accountId ? { accountId } : {}),
        ...(cursor ? { lastSeenAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: takeLimit(limit),
    });
  }

  async getProfile(accountId, profileIdOrUrl) {
    const prisma = getPrisma();
    const value = String(profileIdOrUrl || '');
    return prisma.profile.findFirst({
      where: {
        ...(accountId ? { accountId } : {}),
        OR: [
          { id: value },
          { externalId: value },
          { profileUrl: value },
          { publicIdentifier: value },
        ],
      },
    });
  }

  async listConnections({ accountId, limit = 100, cursor }) {
    return getPrisma().connection.findMany({
      where: {
        ...(accountId ? { accountId } : {}),
        ...(cursor ? { lastSeenAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: takeLimit(limit),
    });
  }

  async listInvitations({ accountId, limit = 100, cursor }) {
    return getPrisma().invitation.findMany({
      where: {
        ...(accountId ? { accountId } : {}),
        ...(cursor ? { lastSeenAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: takeLimit(limit),
    });
  }

  async listNotifications({ accountId, limit = 100, cursor }) {
    return getPrisma().notification.findMany({
      where: {
        ...(accountId ? { accountId } : {}),
        ...(cursor ? { occurredAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: takeLimit(limit),
    });
  }

  async listPosts({ accountId, limit = 100, cursor }) {
    return getPrisma().post.findMany({
      where: {
        ...(accountId ? { accountId } : {}),
        ...(cursor ? { lastSeenAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: takeLimit(limit),
    });
  }

  async listSyncStatus(accountId) {
    const prisma = getPrisma();
    const recentThreshold = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));
    const [cursors, runs, runsSummary] = await Promise.all([
      prisma.syncCursor.findMany({
        where: accountId ? { accountId } : {},
        orderBy: [{ accountId: 'asc' }, { surface: 'asc' }],
      }),
      prisma.syncRun.findMany({
        where: {
          ...(accountId ? { accountId } : {}),
          startedAt: { gte: recentThreshold },
        },
        orderBy: { startedAt: 'desc' },
        take: 50,
      }),
      this.getSyncRunSummary(accountId),
    ]);
    return { cursors, runs, runsSummary };
  }

  async getSyncRunSummary(accountId) {
    const redis = getRedis();
    const raw = await redis.hgetall(SYNC_RUN_SUMMARY_KEY).catch(() => ({}));
    return Object.entries(raw || {})
      .map(([key, count]) => {
        const [summaryAccountId, surface, status] = String(key).split('|');
        const parsedCount = parseInt(String(count || '0'), 10);
        if (!summaryAccountId || !surface || !status || !Number.isFinite(parsedCount) || parsedCount <= 0) {
          return null;
        }
        return {
          accountId: summaryAccountId,
          surface,
          status,
          count: parsedCount,
        };
      })
      .filter((entry) => entry && (!accountId || entry.accountId === accountId));
  }

  async summarizeAndTrimSyncRuns({ retentionDays = 7, batchSize = 500 } = {}) {
    const prisma = getPrisma();
    const redis = getRedis();
    const threshold = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
    const oldRuns = await prisma.syncRun.findMany({
      where: {
        startedAt: { lt: threshold },
      },
      select: {
        id: true,
        accountId: true,
        surface: true,
        status: true,
      },
      orderBy: { startedAt: 'asc' },
      take: batchSize,
    });

    if (oldRuns.length === 0) {
      return { trimmed: 0, aggregated: 0 };
    }

    const summary = new Map();
    for (const run of oldRuns) {
      const key = [run.accountId, run.surface, run.status].join('|');
      summary.set(key, (summary.get(key) || 0) + 1);
    }

    if (summary.size > 0) {
      const pipeline = redis.multi();
      for (const [key, count] of summary.entries()) {
        pipeline.hincrby(SYNC_RUN_SUMMARY_KEY, key, count);
      }
      await pipeline.exec().catch(() => null);
    }

    await prisma.syncRun.deleteMany({
      where: {
        id: { in: oldRuns.map((run) => run.id) },
      },
    });

    return {
      trimmed: oldRuns.length,
      aggregated: summary.size,
    };
  }

  async createWebhookEvent(event) {
    return getPrisma().webhookEvent.create({ data: event });
  }

  async updateWebhookEvent(id, data) {
    return getPrisma().webhookEvent.update({
      where: { id },
      data,
    });
  }

  async listRetryableWebhookEvents({ limit = 50, maxAttempts = 5 } = {}) {
    const now = new Date();
    // A row is created as 'pending' before the inline delivery attempt and only
    // promoted to 'retry_pending' afterward. If the process crashes mid-delivery
    // (or the post-fetch update fails), the row is stranded at 'pending' and the
    // old query (retry_pending only) never picked it up. Include stale 'pending'
    // rows (older than STALE_PENDING_MS, so in-flight rows are never grabbed).
    const STALE_PENDING_MS = 5 * 60 * 1000;
    const stalePendingBefore = new Date(now.getTime() - STALE_PENDING_MS);
    return getPrisma().webhookEvent.findMany({
      where: {
        attempts: { lt: maxAttempts },
        OR: [
          { status: 'retry_pending', nextAttemptAt: { lte: now } },
          { status: 'pending', createdAt: { lt: stalePendingBefore } },
        ],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: takeLimit(limit, 50, 200),
    });
  }

  async migrateLegacyWebhookSubscriptions() {
    // Run the Redis→Postgres backfill at most once per process. It was
    // previously awaited on every create/list/listActive call — and
    // listActive fires for essentially every emitted event — producing an
    // hvals scan + per-entry upsert storm. Memoize as a one-shot promise;
    // reset on failure so a transient error can be retried on the next call.
    if (!this._legacyMigration) {
      this._legacyMigration = this._runLegacyWebhookMigration().catch((err) => {
        this._legacyMigration = null;
        throw err;
      });
    }
    return this._legacyMigration;
  }

  async _runLegacyWebhookMigration() {
    const prisma = getPrisma();
    const redis = getRedis();
    const rawSubscriptions = await redis.hvals('webhook:subscriptions').catch(() => []);
    for (const raw of rawSubscriptions) {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!parsed?.id || !parsed?.targetUrl || !Array.isArray(parsed?.eventTypes) || !parsed?.secret) {
        continue;
      }
      await prisma.webhookSubscription.upsert({
        where: { id: String(parsed.id) },
        update: {
          targetUrl: String(parsed.targetUrl),
          eventTypes: parsed.eventTypes.map((eventType) => String(eventType)),
          secret: String(parsed.secret),
          status: String(parsed.status || 'active'),
        },
        create: {
          id: String(parsed.id),
          targetUrl: String(parsed.targetUrl),
          eventTypes: parsed.eventTypes.map((eventType) => String(eventType)),
          secret: String(parsed.secret),
          status: String(parsed.status || 'active'),
          createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
        },
      }).catch(() => null);
    }
  }

  async createWebhookSubscription(subscription) {
    await this.migrateLegacyWebhookSubscriptions();
    return getPrisma().webhookSubscription.create({
      data: subscription,
    });
  }

  async listWebhookSubscriptions() {
    await this.migrateLegacyWebhookSubscriptions();
    return getPrisma().webhookSubscription.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async listActiveWebhookSubscriptions() {
    await this.migrateLegacyWebhookSubscriptions();
    return getPrisma().webhookSubscription.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deactivateWebhookSubscription(id) {
    return getPrisma().webhookSubscription.update({
      where: { id },
      data: { status: 'inactive' },
    });
  }
}

module.exports = new UnifiedRepository();
