ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "messages_accountId_conversationId_dedupeKey_key"
  ON "messages" ("accountId", "conversationId", "dedupeKey");

CREATE INDEX IF NOT EXISTS "messages_accountId_conversationId_dedupeKey_idx"
  ON "messages" ("accountId", "conversationId", "dedupeKey");
