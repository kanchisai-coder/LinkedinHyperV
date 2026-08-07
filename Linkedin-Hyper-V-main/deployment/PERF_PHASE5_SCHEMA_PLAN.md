# Phase 5 — Schema cleanup plan (NOT YET EXECUTED)

This phase is **deferred**: it requires a coordinated migration window and a backfill
strategy. The notes below are the agreed plan; execute when a maintenance window is
available.

## Target

Move `raw Json?` columns out of hot tables. They add 5–20KB per row, bloat indexes
indirectly via TOAST table pressure, and are rarely read.

Affected tables (per `worker/prisma/schema.prisma`):

| Model | Raw column | Rows scale |
|---|---|---|
| Conversation | `raw` | per inbox item |
| Message | `raw` | per message |
| MessageObservation | `payload` | per observation |
| Profile | `raw` | per profile |
| Invitation | `raw` | per invitation |
| Notification | `raw` | per notification |
| Post | `raw` | per post |
| Comment | `raw` | per comment |
| Reaction | `raw` | per reaction |
| Attachment | `raw` | per attachment |

## Proposed shape

One `*_raw` table per parent, 1:1 keyed by parent id:

```prisma
model MessageRaw {
  messageId String  @id
  payload   Json
  capturedAt DateTime @default(now())
  message   Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
}
```

Repo writes become two statements wrapped in `prisma.$transaction([...])`.
Reads of hot fields stop pulling the JSON column.

## Migration plan

1. **Add the `*_raw` tables** (idempotent, no data movement).
2. **Backfill** in batches of 10k via `INSERT … SELECT id, raw FROM message WHERE raw IS NOT NULL AND id NOT IN (SELECT messageId FROM message_raw)`.
3. **Dual-write** for one release: every write to the parent also writes the raw row.
4. **Cut over reads**: any code that needs `raw` joins `MessageRaw`. Most code paths don't.
5. **Drop the column** in a follow-up release, after verifying no readers remain (grep + log).

## Estimated impact

- Row width on `Message`: ~2.5KB → ~400B average. Bigger fit-in-page ratio, fewer TOAST round-trips.
- Sequential-scan cost on `Message`: −60–80% based on similar refactors.
- Disk space: net-neutral; raw bytes just live elsewhere.

## Risks

- Backfill takes hours on large prod DBs. Must run off-peak; use throttled batches.
- Forgotten readers cause silent missing-`raw` after column drop. Search across all repos before step 5.
- BullMQ-managed sync jobs may carry `raw` payloads in flight — drain queue before cutover.

## Why we didn't ship this in the perf batch

It's a multi-week project disguised as a schema diff. Bundling it with the
in-process perf fixes would have made rollback impossible if something else
in the batch regressed.
