-- Unified LinkedIn data layer: durable mirror tables and sync provenance.

CREATE TABLE IF NOT EXISTS "accounts" (
  "id" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP(3),
  "lastSessionSavedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "sessionStatus" TEXT NOT NULL DEFAULT 'disconnected',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "lastSessionSavedAt" TIMESTAMP(3);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sessionStatus" TEXT NOT NULL DEFAULT 'disconnected';

CREATE TABLE IF NOT EXISTS "conversations" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "participantName" TEXT NOT NULL,
  "participantProfileUrl" TEXT,
  "participantAvatarUrl" TEXT,
  "lastMessageAt" TIMESTAMP(3) NOT NULL,
  "lastMessageText" TEXT NOT NULL,
  "lastMessageSentByMe" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "messages" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "conversationId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "senderName" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "sentAt" TIMESTAMPTZ NOT NULL,
  "isSentByMe" BOOLEAN NOT NULL,
  "linkedinMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "messages_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'linkedin';
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "syncCursor" TEXT;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "hasMoreHistory" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'linkedin';
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "raw" JSONB;

CREATE TABLE IF NOT EXISTS "profiles" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "externalId" TEXT,
  "profileUrl" TEXT NOT NULL,
  "publicIdentifier" TEXT,
  "name" TEXT NOT NULL,
  "headline" TEXT,
  "location" TEXT,
  "avatarUrl" TEXT,
  "company" TEXT,
  "raw" JSONB,
  "contentHash" TEXT,
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "profiles_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "connections" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "profileId" TEXT,
  "profileUrl" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "headline" TEXT,
  "connectedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'connected',
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "raw" JSONB,
  "contentHash" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connections_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "connections_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "invitations" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "profileId" TEXT,
  "profileUrl" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "note" TEXT,
  "direction" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "raw" JSONB,
  "contentHash" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invitations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invitations_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "externalId" TEXT,
  "profileId" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "text" TEXT,
  "url" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "seenAt" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "raw" JSONB,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notifications_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "posts" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "externalId" TEXT,
  "profileId" TEXT,
  "authorName" TEXT NOT NULL,
  "authorUrl" TEXT,
  "text" TEXT,
  "url" TEXT,
  "postedAt" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "raw" JSONB,
  "contentHash" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "posts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "posts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "posts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "comments" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "postId" TEXT,
  "profileId" TEXT,
  "externalId" TEXT,
  "authorName" TEXT NOT NULL,
  "authorUrl" TEXT,
  "text" TEXT NOT NULL,
  "commentedAt" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "raw" JSONB,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "comments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "comments_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "reactions" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "postId" TEXT,
  "profileId" TEXT,
  "externalId" TEXT,
  "actorName" TEXT NOT NULL,
  "actorUrl" TEXT,
  "reactionType" TEXT NOT NULL,
  "reactedAt" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "raw" JSONB,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reactions_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reactions_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "attachments" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "conversationId" TEXT,
  "messageId" TEXT,
  "externalId" TEXT,
  "type" TEXT NOT NULL,
  "name" TEXT,
  "url" TEXT,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "raw" JSONB,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attachments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attachments_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "sync_cursors" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "cursor" TEXT,
  "highWatermark" TIMESTAMP(3),
  "coverage" TEXT NOT NULL DEFAULT 'unknown',
  "lagSeconds" INTEGER,
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3),
  "metadata" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_cursors_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "sync_runs" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "lane" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "itemsRead" INTEGER NOT NULL DEFAULT 0,
  "itemsWritten" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "metadata" JSONB,
  CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_runs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "raw_snapshots" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "externalId" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retentionUntil" TIMESTAMP(3),
  "contentHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  CONSTRAINT "raw_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "raw_snapshots_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "responseCode" INTEGER,
  "responseBody" TEXT,
  "signature" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_accountId_externalId_key" ON "conversations"("accountId", "externalId");
CREATE INDEX IF NOT EXISTS "conversations_accountId_idx" ON "conversations"("accountId");
CREATE INDEX IF NOT EXISTS "conversations_lastMessageAt_idx" ON "conversations"("lastMessageAt" DESC);
CREATE INDEX IF NOT EXISTS "conversations_accountId_lastSeenAt_idx" ON "conversations"("accountId", "lastSeenAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "messages_accountId_externalId_key" ON "messages"("accountId", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "messages_conversationId_sentAt_text_key" ON "messages"("conversationId", "sentAt", "text");
CREATE INDEX IF NOT EXISTS "messages_conversationId_sentAt_idx" ON "messages"("conversationId", "sentAt");
CREATE INDEX IF NOT EXISTS "messages_accountId_idx" ON "messages"("accountId");
CREATE INDEX IF NOT EXISTS "messages_sentAt_idx" ON "messages"("sentAt" DESC);
CREATE INDEX IF NOT EXISTS "messages_accountId_sentAt_idx" ON "messages"("accountId", "sentAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "profiles_accountId_profileUrl_key" ON "profiles"("accountId", "profileUrl");
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_accountId_externalId_key" ON "profiles"("accountId", "externalId");
CREATE INDEX IF NOT EXISTS "profiles_accountId_lastSeenAt_idx" ON "profiles"("accountId", "lastSeenAt" DESC);
CREATE INDEX IF NOT EXISTS "profiles_publicIdentifier_idx" ON "profiles"("publicIdentifier");

CREATE UNIQUE INDEX IF NOT EXISTS "connections_accountId_profileUrl_key" ON "connections"("accountId", "profileUrl");
CREATE INDEX IF NOT EXISTS "connections_accountId_lastSeenAt_idx" ON "connections"("accountId", "lastSeenAt" DESC);
CREATE INDEX IF NOT EXISTS "connections_status_idx" ON "connections"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "invitations_accountId_profileUrl_direction_status_key" ON "invitations"("accountId", "profileUrl", "direction", "status");
CREATE INDEX IF NOT EXISTS "invitations_accountId_lastSeenAt_idx" ON "invitations"("accountId", "lastSeenAt" DESC);
CREATE INDEX IF NOT EXISTS "invitations_direction_status_idx" ON "invitations"("direction", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_accountId_externalId_key" ON "notifications"("accountId", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_accountId_contentHash_key" ON "notifications"("accountId", "contentHash");
CREATE INDEX IF NOT EXISTS "notifications_accountId_occurredAt_idx" ON "notifications"("accountId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "notifications_type_idx" ON "notifications"("type");

CREATE UNIQUE INDEX IF NOT EXISTS "posts_accountId_externalId_key" ON "posts"("accountId", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "posts_accountId_contentHash_key" ON "posts"("accountId", "contentHash");
CREATE INDEX IF NOT EXISTS "posts_accountId_postedAt_idx" ON "posts"("accountId", "postedAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "comments_accountId_externalId_key" ON "comments"("accountId", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "comments_accountId_contentHash_key" ON "comments"("accountId", "contentHash");
CREATE INDEX IF NOT EXISTS "comments_accountId_commentedAt_idx" ON "comments"("accountId", "commentedAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "reactions_accountId_externalId_key" ON "reactions"("accountId", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "reactions_accountId_contentHash_key" ON "reactions"("accountId", "contentHash");
CREATE INDEX IF NOT EXISTS "reactions_accountId_reactedAt_idx" ON "reactions"("accountId", "reactedAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "attachments_accountId_externalId_key" ON "attachments"("accountId", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "attachments_accountId_contentHash_key" ON "attachments"("accountId", "contentHash");
CREATE INDEX IF NOT EXISTS "attachments_accountId_idx" ON "attachments"("accountId");
CREATE INDEX IF NOT EXISTS "attachments_conversationId_idx" ON "attachments"("conversationId");

CREATE UNIQUE INDEX IF NOT EXISTS "sync_cursors_accountId_surface_key" ON "sync_cursors"("accountId", "surface");
CREATE INDEX IF NOT EXISTS "sync_cursors_accountId_updatedAt_idx" ON "sync_cursors"("accountId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "sync_runs_accountId_startedAt_idx" ON "sync_runs"("accountId", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "sync_runs_status_idx" ON "sync_runs"("status");
CREATE INDEX IF NOT EXISTS "sync_runs_surface_idx" ON "sync_runs"("surface");

CREATE UNIQUE INDEX IF NOT EXISTS "raw_snapshots_accountId_surface_contentHash_key" ON "raw_snapshots"("accountId", "surface", "contentHash");
CREATE INDEX IF NOT EXISTS "raw_snapshots_accountId_capturedAt_idx" ON "raw_snapshots"("accountId", "capturedAt" DESC);
CREATE INDEX IF NOT EXISTS "raw_snapshots_retentionUntil_idx" ON "raw_snapshots"("retentionUntil");

CREATE INDEX IF NOT EXISTS "webhook_events_status_nextAttemptAt_idx" ON "webhook_events"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "webhook_events_eventType_idx" ON "webhook_events"("eventType");
