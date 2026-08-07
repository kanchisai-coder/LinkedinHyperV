ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "resolutionState" TEXT NOT NULL DEFAULT 'shell_only',
  ADD COLUMN IF NOT EXISTS "messageCountCanonical" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "shellReason" TEXT;

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "visibilityState" TEXT NOT NULL DEFAULT 'visible',
  ADD COLUMN IF NOT EXISTS "isCanonical" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "identityConfidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "senderConfidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "timestampConfidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "observedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "sourceRunId" TEXT;

CREATE INDEX IF NOT EXISTS "messages_accountId_conversationId_visibilityState_sentAt_idx"
  ON "messages" ("accountId", "conversationId", "visibilityState", "sentAt" DESC);

CREATE INDEX IF NOT EXISTS "messages_accountId_visibilityState_sentAt_idx"
  ON "messages" ("accountId", "visibilityState", "sentAt" DESC);

CREATE TABLE IF NOT EXISTS "message_observations" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "conversationId" TEXT,
  "messageId" TEXT,
  "externalId" TEXT,
  "senderId" TEXT,
  "senderName" TEXT,
  "text" TEXT,
  "observedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ,
  "identityConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "senderConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "timestampConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "visibilityState" TEXT NOT NULL DEFAULT 'pending_repair',
  "contentHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'linkedin',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_observations_accountId_contentHash_key"
  ON "message_observations" ("accountId", "contentHash");

CREATE INDEX IF NOT EXISTS "message_observations_accountId_observedAt_idx"
  ON "message_observations" ("accountId", "observedAt" DESC);

CREATE INDEX IF NOT EXISTS "message_observations_conversationId_observedAt_idx"
  ON "message_observations" ("conversationId", "observedAt" DESC);

CREATE INDEX IF NOT EXISTS "message_observations_visibilityState_observedAt_idx"
  ON "message_observations" ("visibilityState", "observedAt" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'message_observations_accountId_fkey'
  ) THEN
    ALTER TABLE "message_observations"
      ADD CONSTRAINT "message_observations_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'message_observations_conversationId_fkey'
  ) THEN
    ALTER TABLE "message_observations"
      ADD CONSTRAINT "message_observations_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'message_observations_messageId_fkey'
  ) THEN
    ALTER TABLE "message_observations"
      ADD CONSTRAINT "message_observations_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "messages"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
