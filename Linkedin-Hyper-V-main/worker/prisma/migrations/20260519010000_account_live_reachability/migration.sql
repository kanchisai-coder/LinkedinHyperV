ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "liveReachability" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "liveReachabilityAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "liveReachabilityUrl" TEXT;
