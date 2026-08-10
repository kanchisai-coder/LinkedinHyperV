# Worker error triage — Redis reconnect + BullMQ jobId + posture spam

Master plan for the three error classes in the worker logs. Two were real bugs
(now fixed); one is the known proxy/ban issue.

---

## Error A — "Failed to refresh unified sync schedules: Error: Connection is closed." (REAL BUG, FIXED)

### Symptom
```
[Worker] Failed to refresh unified sync schedules: Error: Connection is closed.
    at EventEmitter.sendCommand (ioredis/built/Redis.js:333:28)
    at Scripts.addJobScheduler (bullmq/.../scripts.js:251:35)
```
Repeated every ~60 s forever.

### Root cause
`worker/src/redisClient.js` set `retryStrategy: () => null` on BOTH the shared
client and the BullMQ client. `() => null` tells ioredis **never to reconnect**.
So the FIRST disconnect — a Redis restart, an idle-timeout drop on the shared
`proxy.redis-production` cluster, or any network blip — closes the socket
permanently. Every later command (including the 60 s `scheduleAdaptiveSync`
tick that calls `queue.upsertJobScheduler`) then throws "Connection is closed."
indefinitely. The worker never recovers without a process restart.

### Fix
Replace `() => null` with a capped reconnect strategy in both clients:
```js
retryStrategy: (times) => Math.min(times * 200, 5000),   // 200ms..5s backoff
reconnectOnError: (err) => /READONLY|ECONNRESET|EPIPE/i.test(err.message),
```
- Shared client keeps `maxRetriesPerRequest: 1` + `commandTimeout: 3000`, so API
  routes still fail FAST per command — but the socket now self-heals after a
  blip instead of dying forever.
- BullMQ client keeps `maxRetriesPerRequest: null` (required by BullMQ) and now
  reconnects, so schedulers/jobs resume automatically when Redis returns.

### Verification
After deploy, a Redis restart should produce a brief `[Redis] reconnecting in
Nms` log, then normal operation — NOT an endless "Connection is closed." stream.

---

## Error B — "thread-resolution failed ... 'Custom Id cannot contain :'" (REAL BUG, FIXED)

### Symptom
```
[Worker] thread-resolution failed { accountId: 'test', error: 'Custom Id cannot contain :' }
```

### Root cause
BullMQ uses `:` as its internal Redis key separator and **forbids `:` in custom
job ids**. `buildThreadResolveJobId` produced
`repair:${accountId}:${conversationId}` where `conversationId` is itself
`test:2-MTEz...==` — so the id became `repair:test:test:2-MTEz...==`, which
BullMQ rejects at `queue.add`. The job is dropped; that thread never resolves.

Same latent bug existed in `buildUnifiedSyncJobId`, the 5 scheduler template
`opts.jobId`s, the fallback `queue.add` repeat jobIds, and the
`dedupeWindowJobs` jobId in `index.js` (`${name}:${accountId}:${ts}`). They were
partly masked by Error A swallowing the scheduler path.

### Fix
Added `sanitizeJobId(id) => String(id).replace(/:/g, '_')` and applied it to
every custom job id that reaches `queue.add` / `upsertJobScheduler`:
- `queueUnifiedSync`, `queueThreadResolution` (the confirmed failure)
- all 5 `upsertJobScheduler` template jobIds + the fallback `queue.add` repeats
- `index.js` dedupe jobId now uses `_` separators

Scheduler *keys* (first arg to `upsertJobScheduler`) keep their `:` form — those
are tolerated and renaming them would orphan existing schedulers. Only the
template **job ids** are sanitized.

Also removed the redundant `immediately: true` flag (it triggered the harmless
but spammy "Using option immediately with every does not affect the job's
schedule" warning; `every` already runs immediately).

### Verification
After deploy, thread-resolution for `test`/`personl` should no longer log
"Custom Id cannot contain :". Jobs enqueue with ids like
`repair_test_2-MTEz...==`.

---

## Error C — "SYNC_BLOCKED" / "No session" / "ERR_TOO_MANY_REDIRECTS" (KNOWN — proxy/ban)

### Symptom
```
[Worker] thread-resolution failed { accountId: 'personl', error: 'Account session status requires reconnect.', code: 'SYNC_BLOCKED' }
[thread] Live fallback failed for personl:...: No session for account personl
[thread] Live fallback failed for test:...: page.goto: net::ERR_TOO_MANY_REDIRECTS
```

### Root cause
NOT a code bug. This is the datacenter-IP ban issue documented in
`CONNECTIONS_BLOCKED_RECOVERY.md` and `ANTI_BAN_*.md`:
- `personl` posture is `blocked` → the orchestrator correctly refuses browser
  surfaces (`SYNC_BLOCKED`) and the cooldown is doing its job.
- `test`'s live fallback hits `ERR_TOO_MANY_REDIRECTS` because the worker
  egresses from the datacenter IP `167.71.211.25`.

### Fix (operational, not code)
1. Assign a residential/mobile proxy per account (`PROXY_FOR_PERSONL`,
   `PROXY_FOR_TEST`).
2. `POST /accounts/:id/clear-block` to clear the cooldown once the proxy is in
   place.
3. Reconnect via noVNC from the residential egress.

This fix is already shipped (clear-block endpoint, per-account proxy resolver);
it just needs the proxy *input* — see `SLOW_FULL_SYNC_MASTERPLAN.md` §9.

The code-level improvement worth making (future): when posture is `blocked`,
the orchestrator should also stop the **live fallback** browser navigation
(it currently still attempts `page.goto` and burns a redirect-loop hit). Gate
the live fallback on `!isBlockedPosture(posture)`.

---

## Summary

| Error | Class | Status |
|---|---|---|
| A — Connection is closed (spam) | code bug — no Redis reconnect | **FIXED** (retryStrategy) |
| B — Custom Id cannot contain : | code bug — `:` in jobId | **FIXED** (sanitizeJobId) |
| C — SYNC_BLOCKED / redirects | proxy/ban (datacenter IP) | needs proxy input (code already supports it) |

A + B are shipped in the worker image. C is unblocked by providing a proxy.
