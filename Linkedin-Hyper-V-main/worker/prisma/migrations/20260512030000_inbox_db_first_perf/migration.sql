ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "replacedByConversationId" TEXT,
  ADD COLUMN IF NOT EXISTS "hiddenReason" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceQuality" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastResolveDurationMs" INTEGER;

CREATE INDEX IF NOT EXISTS "conversations_accountId_syncState_lastMessageAt_idx"
  ON "conversations" ("accountId", "syncState", "lastMessageAt" DESC);

CREATE INDEX IF NOT EXISTS "conversations_accountId_replacedByConversationId_idx"
  ON "conversations" ("accountId", "replacedByConversationId");

CREATE INDEX IF NOT EXISTS "messages_conversationId_sentAt_desc_id_idx"
  ON "messages" ("conversationId", "sentAt" DESC, "id");
