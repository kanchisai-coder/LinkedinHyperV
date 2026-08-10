CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id" TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  "eventTypes" TEXT[] NOT NULL,
  "secret" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_status_idx"
  ON "webhook_subscriptions"("status");
