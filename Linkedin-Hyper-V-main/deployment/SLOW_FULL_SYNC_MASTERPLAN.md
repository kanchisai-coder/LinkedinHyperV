# Slow Full-Sync — master plan

**Goal:** build and maintain a complete, eventually-consistent local mirror of
**all** data each connected LinkedIn account can access — messages, threads,
connections, invitations, profiles, notifications, posts, comments, reactions —
**without getting banned**. Not a fast scrape. A patient, resumable, IP-trusted,
human-paced drip that converges to "everything" over days/weeks and then stays
fresh forever.

**Status:** plan + working skeleton shipped behind `ENABLE_BACKFILL=1`.

---

## 0. The governing philosophy: slow wins

The single biggest mistake in LinkedIn data work is going fast. Fast = banned =
zero data. The whole design optimizes for **never tripping a flag**, accepting
that "complete" arrives in days, not minutes.

Three principles:

1. **Drip, don't drain.** A real human reads a few conversations, views a few
   profiles, scrolls a connection page — then stops. We mimic that envelope:
   small bursts, long gaps, business-hours only, jittered.
2. **Resumable everything.** Every surface keeps a cursor. A block, a restart, a
   redeploy — we pick up exactly where we left off. Nothing re-fetches from zero.
3. **Hot first, cold forever.** New messages matter now → realtime + frequent
   delta. Old connections from 2019 matter eventually → trickle them in during
   idle capacity, lowest priority.

---

## 1. Data domains (surfaces) and how to get each

All via the **Voyager JSON API** (see `LINKEDIN_INGESTION_MASTERPLAN.md`), never
DOM scraping. Each is paginated with a `start`/`count` or cursor.

| Surface | Voyager source | Volume (typical) | Priority |
|---|---|---|---|
| Conversations (inbox) | `/messaging/conversations` | 100s | **HOT** (realtime + delta) |
| Messages per thread | `/messaging/conversations/{id}/events` | 1000s–10000s | HOT for active, COLD for archived |
| Connections | `/relationships/dash/connections` | 500–30000 | COLD (big backfill) |
| Sent/received invitations | `/relationships/invitationViews` | 10s–100s | WARM |
| Profiles (of connections/senders) | `/identity/profiles/{id}/profileView` | = #connections | COLD, on-demand |
| Notifications | `voyagerIdentityDashNotificationCards` | 100s | WARM |
| Posts / activity | `/identity/profiles/{id}/posts` | 10s–1000s | COLD |
| Comments / reactions | nested in posts | 1000s | COLDEST |

---

## 2. The harvest state machine

For every `(accountId, surface)` pair we persist a record in Redis (mirrored to
Postgres for durability):

```jsonc
{
  "accountId": "personl",
  "surface": "connections",
  "phase": "backfilling",      // idle | backfilling | caught_up | blocked
  "cursor": "start=240",       // opaque per-surface resume token
  "totalEstimate": 5800,        // best-effort, from first page metadata
  "fetched": 240,               // progress
  "lastRunAt": "2026-05-29T14:02:11Z",
  "lastSuccessAt": "2026-05-29T14:02:11Z",
  "nextEligibleAt": "2026-05-29T14:35:00Z",  // pacing gate
  "consecutiveFailures": 0,
  "completedAt": null           // set when phase -> caught_up
}
```

Phase transitions:

```
idle ──first run──▶ backfilling ──last page──▶ caught_up
  ▲                      │                          │
  │                   (block)                    (delta poll
  │                      ▼                         finds new)
  └──────────────── blocked ◀───────────────────────┘
       (cooldown expires, posture healthy)
```

`caught_up` surfaces switch to a slow **delta** cadence (re-check the first page
periodically for new items); `backfilling` surfaces page backward through history.

---

## 3. The pacing engine (token bucket + envelope)

A central scheduler decides **which surface, for which account, may run next** —
and refuses everything else. Layers, all must pass:

1. **Global token bucket.** N harvest operations per hour across ALL accounts
   (default 20/h). Refills slowly. Prevents a thundering scrape.
2. **Per-account token bucket.** M ops/hour per account (default 6/h).
3. **Per-surface budget.** From the existing `rateLimit.js` hourly/daily caps.
4. **Business-hours gate.** From `antiBan.isWithinBusinessHours` — no harvesting
   at 3am account-local.
5. **antiBan circuit breaker + posture.** `antiBan.gateAction` — blocked/cooldown
   surfaces are skipped entirely.
6. **Jittered inter-op gap.** Between any two ops on the same account: a
   log-normal delay (mean ~8 min, min 90 s, max 40 min). Never fixed-interval.
7. **Priority queue.** When multiple surfaces are eligible, pick by weight:
   HOT > WARM > COLD > COLDEST, with aging so cold work isn't starved forever.

The scheduler runs a tick every ~60 s, evaluates eligible `(account, surface)`
pairs, and dispatches **at most one** that passes all gates. That's the drip.

---

## 4. Backfill pagination strategy

For each surface, the orchestrator:

1. Reads the state record → resume `cursor`.
2. Calls the Voyager endpoint with the cursor (`start`, or `pagination token`).
3. Maps results via the existing `voyagerMapper` → canonical items.
4. **Idempotent upsert** via the existing repos (`MessageRepository`,
   connections repo, etc.) — reuses `buildMessageDedupeKey` so overlap with
   realtime/delta is harmless.
5. Advances `cursor`, increments `fetched`.
6. If the page was the last (fewer than `count` items, or no cursor) → phase
   `caught_up`, set `completedAt`.
7. Emits a progress event on the event bus (`backfill.progress`) for the
   dashboard.

Page size stays small (count=20–40) — large pages look like a scrape and cost
more to recover if blocked mid-fetch.

---

## 5. Resumability + block recovery

- **Cursor is persisted before AND after each page.** A crash mid-page re-fetches
  at most one page (idempotent, so no dupes).
- **On block** (`posture: blocked`): phase → `blocked`, `nextEligibleAt` set to
  the posture's cooldown expiry. The scheduler skips it until then.
- **On cooldown expiry + healthy posture:** phase → `backfilling`, resumes at the
  saved cursor.
- **No surface ever restarts from zero** unless an operator explicitly resets it
  (`POST /accounts/:id/harvest/reset?surface=connections`).

---

## 6. Observability — "how complete are we?"

Per surface, the dashboard shows:
- `fetched / totalEstimate` → a real progress bar.
- phase badge (idle / backfilling / caught_up / blocked).
- `lastSuccessAt`, `nextEligibleAt`.
- estimated time-to-complete = `(totalEstimate - fetched) / observed-rate`.

Metrics:
- `harvest_items_total{account,surface}`
- `harvest_phase{account,surface}` (gauge enum)
- `harvest_block_total{account,surface}`
- `harvest_eta_seconds{account,surface}`

Operator endpoints:
- `GET /accounts/:id/harvest` → all surface states.
- `POST /accounts/:id/harvest/reset?surface=...` → restart a surface.
- `POST /accounts/:id/harvest/pause` / `/resume`.

---

## 7. Storage estimate (so you provision correctly)

Rough per account at full mirror:

| Data | Rows | Bytes/row | Total |
|---|---|---|---|
| Connections | 5,000 | ~1 KB | 5 MB |
| Profiles | 5,000 | ~4 KB | 20 MB |
| Conversations | 500 | ~1 KB | 0.5 MB |
| Messages | 50,000 | ~1.5 KB | 75 MB |
| Notifications | 2,000 | ~0.8 KB | 1.6 MB |
| Posts/comments/reactions | 20,000 | ~1 KB | 20 MB |
| **Per account** | | | **~120 MB** |

At 50 accounts ≈ **6 GB** of relational data, plus raw JSON if retained (see the
Phase 5 schema-cleanup plan — move `raw` columns to a side table or object store).
Budget 2–3× for indexes + growth: **~15–20 GB** Postgres for 50 accounts.

---

## 8. Time-to-complete (the honest number)

With the safe defaults (6 ops/account/hour, business hours ~9 ops/day windows,
~30 items/op):

- A 5,000-connection backfill ≈ 5000 / (30 × 6 × 9) ≈ **~3 days** per account.
- 50,000 messages across threads ≈ **1–2 weeks** per account.
- Everything (all surfaces) reaching `caught_up` ≈ **2–3 weeks** per account.

This is by design. Trying to compress it is how accounts die. After the initial
fill, steady-state delta + realtime keeps it fresh with a tiny fraction of that
traffic.

---

## 9. ⭐ What YOU need to provide to make this successful

This is the dependency checklist. The engine is built; these inputs gate success:

### Mandatory
1. **Residential or mobile proxies, one sticky IP per account.** Non-negotiable.
   The entire plan is void on a datacenter IP — the harvest just trips
   `ERR_TOO_MANY_REDIRECTS` repeatedly. Provide `PROXY_FOR_<ACCOUNTID>` for every
   account. (Options + costs in `ANTI_BAN_FREE_TIER.md`.)
2. **A logged-in session per account** (via noVNC connect), ideally with
   `ENABLE_CRED_CAPTURE=1` so sessions auto-refresh (`AUTH_AUTOLOGIN_MASTERPLAN.md`).
3. **Geo + timezone per account** — `ANTIBAN_TZ_<ACCOUNTID>` matching the
   account's real LinkedIn location, so business-hours gating and fingerprint
   timezone line up. A US account harvested on India hours is a flag.
4. **Postgres capacity** per §7 (~15–20 GB for 50 accounts) and Redis headroom
   for cursors/state (negligible, <50 MB).

### Strongly recommended
5. **Validation run of the Voyager probe** (`node src/voyager/probe.js <id> 30`)
   behind the proxy, confirming the real JSON shapes match `voyagerMapper.js`
   before enabling backfill at scale. The mapper is built to known schemas but
   must be verified against your live accounts.
6. **Volume/priority decision per account.** Which accounts need full history vs
   just recent? Set per-account priority so we don't backfill 30k connections on
   an account you only care about new messages for.
7. **A realistic completion expectation** shared with stakeholders: weeks, not
   hours (§8). The number-one source of "make it faster" pressure that gets
   accounts banned is an unrealistic deadline.

### Optional but valuable
8. **Webhook endpoint(s)** if you want push delivery of harvested/new data
   (`WEBHOOK_ENDPOINTS`, see ingestion master plan §4).
9. **2FA TOTP secrets** per account if accounts have 2FA and you want fully
   unattended auto-relogin (`AUTH_AUTOLOGIN_MASTERPLAN.md` §5 v2).
10. **Legal sign-off** on authenticated-data automation + credential storage.
    This is a business decision, not a technical one, but it gates production.

### What I do NOT need from you
- Faster hardware (the bottleneck is deliberate pacing, not compute).
- More accounts to "spread load" (each account is independently paced; more
  accounts ≠ faster per-account completion).

---

## 10. Rollout sequence

1. Wire proxies + sessions + geo for **one** account (`personl`).
2. `node src/voyager/probe.js personl 30` behind the proxy — validate shapes.
3. `ENABLE_BACKFILL=1` for that account only. Watch `GET /accounts/personl/harvest`.
4. Let it run 48h. Confirm: progress advances, zero blocks, posture stays healthy.
5. If clean → enable for the rest, same proxy class.
6. Watch the fleet dashboard; any account that blocks → it self-pauses and
   resumes after cooldown. No manual babysitting needed.

---

## 11. Where this engine sits in the codebase

```
worker/src/harvest/
  harvestState.js         per-(account,surface) cursor + phase + progress (Redis)
  harvestScheduler.js     token buckets + business-hours + jitter + priority → next task
  backfillOrchestrator.js drives Voyager paginated reads, idempotent writes, advances cursor
  (bootstrap wiring)      tick loop started from index.js when ENABLE_BACKFILL=1
```

It composes everything already built: `VoyagerClient` for reads, `voyagerMapper`
for normalization, `antiBan` for gating, `rateLimit` for caps, the repos for
idempotent persistence, and the event bus for progress + webhooks.
