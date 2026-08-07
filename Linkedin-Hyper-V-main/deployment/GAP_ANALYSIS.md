# Gap analysis — what's still missing

Honest senior assessment after the build-out. Two real code holes were found and
fixed in this pass; the rest is prioritized below so you can decide what to
tackle. Most remaining gaps are **operational/validation**, not "more code."

---

## ✅ Fixed in this pass (real shipped bugs)

| # | Gap | Impact | Fix |
|---|---|---|---|
| 1 | Harvest connections backfill required a **non-existent `ConnectionRepository`** → caught the error and persisted **nothing** (silent data loss). | Connections backfill was a no-op. | Switched to the real `UnifiedRepository.upsertConnection` + `normalizeConnection`. |
| 2 | **No persistence consumer** on the event bus. Realtime `message.received` events were published but only delivered to webhooks (if configured) — never written to Postgres. | Realtime messages lost unless a webhook was set. | Added `events/persistenceConsumer.js` (subscribes, idempotently upserts realtime messages), wired into bootstrap. |

---

## P0 — blocks everything (operational, not code)

### P0.1 — Residential/mobile proxy per account
Still the #1 blocker. Every Voyager/realtime/harvest feature is built and idle
because the worker egresses from the datacenter IP `167.71.211.25` → instant
block. **Nothing downstream works until this is provided** (`PROXY_FOR_<id>`).
No amount of code fixes this; it's an input.

### P0.2 — Validate Voyager/realtime shapes against a live account
The entire Voyager client, mapper, realtime connector, and persistence consumer
are built to LinkedIn's **known/assumed** schemas — never run against a real
session. Until `node src/voyager/probe.js <id> 30` runs behind a proxy and the
captured JSON is diffed against `voyagerMapper.js`, all of it is unverified. The
fallbacks degrade safely (scraper fallback, idempotent skips), but "it works" is
unproven.

---

## P1 — real functional gaps worth building

| Gap | Why it matters | Effort |
|---|---|---|
| **Automated test suite in CI** | I've verified everything with ad-hoc `node -e` runs that aren't committed. A `npm test` (the mapper/sanitizer/event/webhook/harvest logic tests) + a GitHub Action would stop regressions. ~40 tests already written ad-hoc; just need to land them as files. | 1 day |
| **`/events` replay endpoint** | Masterplan §4.3 promised a `GET /events?since=` so a downed webhook consumer can catch up. `eventBus.replaySince()` exists; needs an HTTP route + auth. | 0.5 day |
| **`/metrics` endpoint** | Masterplan §8 listed Prometheus metrics (realtime_connected, voyager_4xx, harvest_eta, webhook_dlq_depth). Nothing exposes them. Without it there's no visibility into the new subsystems. | 1 day |
| **Realtime-frame normalization** | `persistenceConsumer` + `RealtimeConnector` map frames best-effort; the real field paths need the P0.2 probe capture to be correct. | 1 day after P0.2 |
| **2FA TOTP for auto-relogin** | autoLogin bails on 2FA → manual reconnect. If accounts have 2FA, this is the gap between "unattended" and "needs a human." | 2 day |
| **Profiles / posts / notifications backfill handlers** | harvest only has connections/invitations/conversations handlers; the rest defer to live sync (marked caught_up). Full mirror needs them. | 1 day each |

---

## P2 — hardening / polish

| Gap | Note |
|---|---|
| **Secrets still hardcoded in the Nomad file** | Leaked + unrotated (you deferred for the testing phase). `SECRET_ROTATION.md` + the `.secure.nomad.hcl` variant are ready when you want them. |
| **Frontend doesn't surface new backend state** | The worker now emits `harvest` progress, credential status, `blocked`/`blockReason` on threads, per-surface phases — the dashboard shows none of it yet. Backend is ahead of UI. |
| **DLQ has no drain/retry tooling** | `webhookDispatcher` writes failed deliveries to a Redis DLQ list but there's no endpoint to inspect/replay it. |
| **No graceful "Redis down" degradation banner** | API routes fail fast (good) but the UI doesn't distinguish "Redis down" from "no data." |
| **No rate-limit headroom telemetry** | `rateLimit.js` enforces caps but there's no view of how close each account is to its hourly/daily ceiling. |
| **Schema `raw` JSON columns still inline** | Phase 5 cleanup plan (`PERF_PHASE5_SCHEMA_PLAN.md`) deferred — fine until tables grow. |

---

## What I would do next, in order

1. **You: provide one residential proxy** for `personl` (P0.1). Without it, nothing else is testable end-to-end.
2. **Run the probe** (P0.2) → validate/fix the Voyager + realtime shapes.
3. **Land the test suite + CI** (P1) so the growing surface stops regressing silently.
4. **`/metrics` + `/events` replay** (P1) for visibility into the new subsystems.
5. **Frontend pass** (P2) to surface harvest progress + block reasons the backend already emits.

Items 1–2 are yours (inputs); 3–5 I can do on request. The honest summary:
**the code surface is now large and mostly built, but unproven against live
LinkedIn and under-tested in CI. The next dollar is best spent on a proxy +
validation, not more features.**
