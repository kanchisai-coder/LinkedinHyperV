# LinkedIn Ingestion Master Plan — toward a Unipile-style real-time engine

**Author:** Architecture
**Audience:** senior engineers implementing the next generation of the LinkedIn
worker
**Status:** master plan / RFC. Phased; each phase is independently shippable.

---

## 0. The one-paragraph thesis

Our current worker **scrapes the rendered DOM** with Playwright (see
`worker/src/unified/LinkedInProvider.js` — every method is `inspect*Page` /
`scroll*` / `openLinkedInPage`). DOM scraping is slow, breaks on every UI change,
burns CPU rendering pages, and **fundamentally cannot be real-time** — it can only
poll. Tools like **Unipile**, **Phantombuster's messaging API**, and
**HeyReach** don't do this. They drive LinkedIn's own internal **Voyager API**
(the JSON API the linkedin.com web app calls) and subscribe to LinkedIn's
**realtime event stream** (the long-lived connection that delivers messages to
the web app the instant they arrive). To build "something like Unipile"
ourselves, we migrate from *DOM scraping + polling* to *Voyager API + realtime
stream + webhooks*. The browser stays — but only for login and challenge-solving,
not for data extraction.

---

## 1. Goals / non-goals

### Goals
- **Real-time message delivery** (sub-second), not polling.
- **Webhooks** to downstream consumers: `message.received`, `message.sent`,
  `invitation.received`, `connection.added`, `reaction.added`, etc.
- **10–50× lower resource cost** per account (no page rendering for reads).
- **Resilience to LinkedIn UI changes** (JSON API is far more stable than DOM).
- **A clean internal API** mirroring Unipile's surface so the rest of our stack
  (and customers) integrate against *our* contract, not LinkedIn's.
- Keep the **anti-ban posture** from `ANTI_BAN_STRATEGY.md` / `ANTI_BAN_FREE_TIER.md`.

### Non-goals
- We are **not** abandoning the browser entirely — login, checkpoints, and
  captchas still need a real browser (the noVNC flow stays).
- We are **not** trying to defeat LinkedIn detection with stealth hacks. The
  realtime stream and Voyager API are exactly what the official web client uses;
  our job is to look like that client, behave at human pace, and egress from a
  trusted IP.
- This is **not** a public-data crawler. Scope is limited to data the
  authenticated account already has access to.

---

## 2. How LinkedIn actually works under the hood

The linkedin.com web SPA talks to three things. Understanding them is the whole
ballgame.

### 2.1 Voyager REST API — `https://www.linkedin.com/voyager/api/...`
The JSON API behind the web app. REST-ish with Rest.li / GraphQL-style
decorations. Key properties:

- **Auth:** the `li_at` session cookie + a CSRF header `csrf-token` whose value
  is the `JSESSIONID` cookie (minus quotes).
- **Required headers:**
  - `csrf-token: <JSESSIONID value>`
  - `x-restli-protocol-version: 2.0.0`
  - `x-li-lang`, `x-li-track` (JSON device descriptor), `x-li-page-instance`
  - a normal browser `user-agent` consistent with the account's fingerprint
- **Representative endpoints** (subject to LinkedIn versioning — must be
  captured/validated, not hardcoded blindly):
  - Conversations list:
    `GET /voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX`
  - One conversation's events (messages):
    `GET /voyager/api/messaging/conversations/{threadId}/events`
  - Send message:
    `POST /voyager/api/messaging/conversations/{threadId}/events?action=create`
  - Profile:
    `GET /voyager/api/identity/profiles/{publicId}/profileView`
  - Invitations:
    `GET /voyager/api/relationships/invitationViews`
  - Send invitation:
    `POST /voyager/api/growth/normInvitations`
  - Connections:
    `GET /voyager/api/relationships/dash/connections`
- Newer surfaces are **GraphQL** at `/voyager/api/graphql?queryId=...` with
  pinned `queryId`s. These query IDs rotate; we capture them from live traffic
  (see §5.2 "query-id harvesting").

### 2.2 The Realtime stream — `https://www.linkedin.com/realtime/connect`
**This is the crown jewel for real-time.** The web app holds open a long-lived
HTTP connection (chunked transfer / EventSource-style) to the realtime service.
LinkedIn pushes JSON event frames down it the moment they happen:

- new message in any conversation
- typing indicators
- read receipts / seen-state
- reactions
- presence (online/away)
- some invitation + notification events

Mechanics:
- `GET /realtime/connect?rc=1` with the same cookie auth, plus a
  `x-li-realtime-session` / `x-li-recipe-*` accept headers describing which
  "topics" to subscribe to.
- The server responds with `content-type: text/event-stream`-like chunks; each
  chunk is a base64/JSON `com.linkedin.realtimefrontend.*` event envelope.
- Heartbeats arrive every ~30–60s; absence ⇒ reconnect.
- Connection lifetime is minutes-to-hours; we reconnect with backoff and
  resubscribe.

A single persistent realtime connection per account replaces *all* inbox/thread
polling. That is the difference between "checks every 5 minutes and gets banned"
and "knows instantly, like a human's open browser tab."

### 2.3 The web app / DOM (legacy)
What we use today. We keep it **only** for: interactive login, checkpoint /
captcha solving, and as a last-resort fallback when an API surface breaks.

---

## 3. Target architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                Account A                       │
                       │                                                │
  ┌─────────────┐      │  ┌────────────────┐   ┌────────────────────┐  │
  │  noVNC      │ login│  │ Session Manager│   │ Realtime Connector │  │
  │  (browser)  ├──────┼─►│ cookies+csrf   ├──►│ holds /realtime/    │  │
  │  challenges │      │  │ refresh, store │   │ connect open        │  │
  └─────────────┘      │  └───────┬────────┘   └─────────┬──────────┘  │
                       │          │                       │ events      │
                       │          ▼                       ▼             │
                       │  ┌────────────────┐   ┌────────────────────┐  │
                       │  │ Voyager Client │   │  Event Normalizer  │  │
                       │  │ backfill+actions│  │  raw → canonical   │  │
                       │  └───────┬────────┘   └─────────┬──────────┘  │
                       └──────────┼──────────────────────┼─────────────┘
                                  │                       │
                                  ▼                       ▼
                        ┌──────────────────────────────────────────┐
                        │      Internal Event Bus (Redis Streams /  │
                        │      NATS / Kafka)  topic: li.events       │
                        └───────┬───────────────────────┬───────────┘
                                │                        │
                   ┌────────────▼─────────┐   ┌──────────▼───────────┐
                   │ Persistence Consumer │   │ Webhook Dispatcher   │
                   │ (Postgres via Prisma)│   │ signed POST, retries │
                   └──────────────────────┘   └──────────┬───────────┘
                                                          │
                                                  ┌───────▼────────┐
                                                  │ Customer / n8n │
                                                  │ HTTPS endpoint │
                                                  └────────────────┘
```

### Component responsibilities

| Component | Responsibility | Notes |
|---|---|---|
| **Session Manager** | Capture full cookie set at login, keep `li_at`+`JSESSIONID` fresh, detect soft-logout, store encrypted | extends today's `connectSessions.js` |
| **Realtime Connector** | One persistent `/realtime/connect` per account; parse frames; reconnect w/ backoff; emit raw events | NEW — the heart of real-time |
| **Voyager Client** | Authenticated JSON calls for backfill + actions (send msg, invite, read profile) | replaces the `inspect*Page` scrapers |
| **Event Normalizer** | Map raw LinkedIn envelopes → our canonical schema; dedupe; idempotency keys | reuse `normalizer.js`, `MessageRepository` dedupe logic |
| **Event Bus** | Decouple ingestion from delivery; durable, replayable | Redis Streams is the cheap first choice |
| **Persistence Consumer** | Write canonical events to Postgres | existing Prisma repos |
| **Webhook Dispatcher** | Deliver signed events to subscribers; retries, DLQ, ordering | NEW — the Unipile-style outward contract |
| **Browser (noVNC)** | Login + challenges only | shrinks dramatically in scope |

---

## 4. The webhook contract (our Unipile-equivalent)

This is what consumers integrate against. Stable, versioned, provider-agnostic.

### 4.1 Event envelope

```jsonc
{
  "id": "evt_01HV…",                 // ULID, globally unique, idempotency key
  "type": "message.received",        // see catalogue below
  "version": "1",
  "account_id": "personl",
  "occurred_at": "2026-05-27T08:14:55.123Z",  // LinkedIn timestamp
  "received_at": "2026-05-27T08:14:55.420Z",  // when WE saw it
  "data": { /* type-specific payload */ },
  "delivery_attempt": 1
}
```

### 4.2 Event catalogue (v1)

| Type | Trigger source | Payload core |
|---|---|---|
| `message.received` | realtime stream | thread_id, sender, text, attachments |
| `message.sent` | realtime + our own action echo | thread_id, message_id, text |
| `message.read` | realtime | thread_id, reader, read_at |
| `typing.started` | realtime | thread_id, participant |
| `invitation.received` | realtime / Voyager poll | inviter profile, invitation_id, note |
| `invitation.accepted` | realtime / Voyager | profile, connected_at |
| `connection.added` | Voyager delta | profile |
| `reaction.added` | realtime | thread_id, message_id, emoji, actor |
| `account.status_changed` | internal | posture: healthy/blocked/checkpoint/expired |

### 4.3 Delivery semantics
- **Signing:** `X-LI-Signature: t=<ts>,v1=<hmac_sha256(secret, ts + "." + body)>`
  — consumers verify like a Stripe webhook.
- **At-least-once** delivery; consumers must dedupe on `id`.
- **Retries:** exponential backoff (1s, 5s, 30s, 5m, 30m, 2h, 6h), max ~24h,
  then dead-letter.
- **Ordering:** best-effort per `account_id`+`thread_id` via a single bus
  partition key; consumers shouldn't assume strict global order.
- **Replay:** `GET /events?since=<id>` endpoint backed by the event log so a
  consumer that was down can catch up without us re-pushing.

---

## 5. Implementation details that will bite you

### 5.1 Auth header derivation
`csrf-token` MUST equal the `JSESSIONID` cookie value with surrounding quotes
stripped. Get both `li_at` and `JSESSIONID` from the same logged-in context.
Capture them via Playwright `context.cookies()` right after login succeeds (we
already detect "authenticated state" — extend it to grab the full jar).

### 5.2 GraphQL queryId harvesting
Newer Voyager surfaces require a pinned `queryId` (e.g.
`messengerConversations.<hash>`). These rotate every few LinkedIn releases.
Strategy:
1. On a fresh login, run **one** browser session with request interception
   (`page.route`) and record every `/voyager/api/graphql?queryId=…` the web app
   fires while you navigate inbox/connections.
2. Persist the harvested queryIds in Redis with the LinkedIn app version.
3. The Voyager Client uses the cached queryIds; a 4xx "unknown query" triggers a
   re-harvest. This is exactly how the commercial tools keep up.

### 5.3 Realtime frame parsing
Frames are newline-delimited JSON envelopes; message events live under
`com.linkedin.realtimefrontend.DecoratedEvent` → `payload` → various
`com.linkedin.voyager.messaging.event.*` shapes. Build a small dispatcher keyed
on the `topic`/`recipe` URN. Treat unknown frames as no-ops (forward-compat).

### 5.4 Idempotency
Every realtime event AND every backfill row maps to a deterministic
`dedupeKey` — reuse the logic already in
`MessageRepository.buildMessageDedupeKey`. Realtime and backfill **will**
overlap; idempotent upserts make that a non-issue.

### 5.5 Reconnect storms
If an account's realtime drops, reconnect with jittered backoff. If 50 accounts
drop at once (LinkedIn-side blip), a thundering herd of reconnects looks like an
attack. Global concurrency limiter + jitter on reconnect.

### 5.6 Rate limits still apply
The realtime stream is read-only and cheap, but **Voyager writes** (send message,
invite) and backfills count against the same human-pace budgets in
`worker/src/rateLimit.js` and the `antiBan.js` gates. Wire the Voyager Client
through `checkAndIncrement` exactly like the current actions.

---

## 6. Anti-ban posture (inherited, non-negotiable)

The API approach is **lower-risk than scraping** (you make the same calls the web
app makes), but the IP and behavioral rules from `ANTI_BAN_*.md` still hold:

- **Residential/mobile egress per account** — same `PROXY_FOR_<id>` mechanism.
  The realtime connection MUST egress from the same sticky IP as the account's
  browser login, or LinkedIn flags the session-IP mismatch instantly.
- **Per-account fingerprint** consistency (`antiBan.fingerprintForAccount`) —
  the `user-agent` / `x-li-track` device descriptor must match the login.
- **Human-pace writes** — realtime *reads* can be 24/7 (a real user keeps a tab
  open), but *sends/invites* stay inside business-hours + hourly caps.
- **Circuit breaker** — a 401/403/999 from Voyager trips the same breaker.

---

## 7. Migration plan (phased, each shippable)

### Phase 1 — Voyager read client behind a flag (2 wks)
- Build `VoyagerClient` (auth, headers, retry, proxy-aware).
- Reimplement `readInbox` + `readThread` via Voyager JSON.
- Feature-flag `USE_VOYAGER_READS=1`; run side-by-side with the scraper, compare
  outputs for correctness. Keep the scraper as fallback.
- **Win:** kills the two heaviest scraping paths; ~10× faster, far fewer bans.

### Phase 2 — Realtime connector for messages (2–3 wks)
- Build `RealtimeConnector`: persistent `/realtime/connect`, frame parser,
  reconnect.
- Emit `message.received/sent/read`, `typing.*`, `reaction.*` to the event bus.
- Turn OFF inbox polling for accounts with a healthy realtime connection
  (fall back to a slow safety poll every 30 min).
- **Win:** true real-time; this is the Unipile-defining feature.

### Phase 3 — Event bus + webhook dispatcher (2 wks)
- Stand up Redis Streams topic `li.events`.
- Persistence consumer (Prisma) + Webhook dispatcher (signing, retries, DLQ).
- Ship the `/events?since=` replay endpoint + subscription management API.
- **Win:** external consumers (n8n, CRM) get real-time pushes — the product.

### Phase 4 — Voyager writes + remaining surfaces (2 wks)
- Move send-message, send-invite, profile, connections, notifications to Voyager.
- Browser now used ONLY for login + challenges.
- **Win:** retire ~90% of the Playwright scraping code.

### Phase 5 — GraphQL queryId auto-harvest + hardening (1–2 wks)
- Automate queryId capture + refresh on 4xx.
- Full observability (per §8), load testing, chaos (kill realtime, kill proxy).
- **Win:** self-healing against LinkedIn version drift.

Total: ~9–11 weeks, one engineer. Phases 1–2 deliver the bulk of the value.

---

## 8. Observability

| Metric | Why |
|---|---|
| `realtime_connected{account}` (0/1) | Is the live stream up? |
| `realtime_reconnects_total{account}` | Drop frequency → IP/session health |
| `realtime_event_lag_seconds` | occurred_at → received_at; real-time SLA |
| `voyager_request_duration{endpoint,status}` | API health, soft rate-limiting |
| `voyager_4xx_total{endpoint,code}` | 401/403/999 → ban signal; queryId drift |
| `webhook_delivery_duration{subscriber}` | downstream health |
| `webhook_dlq_depth` | failed deliveries piling up |
| `queryid_reharvest_total` | LinkedIn version drift rate |

Alert on: realtime down >5 min for any account, Voyager 999/403 spike, webhook
DLQ growth.

---

## 9. Build vs buy — be honest about it

| Dimension | Build (this plan) | Buy (Unipile / Phantombuster) |
|---|---|---|
| Up-front cost | ~10 eng-weeks | ~$0 dev, integrate in days |
| Per-account/mo | proxy + infra (~$10–50) | Unipile ~$20–60/account/mo |
| Maintenance | **ongoing — LinkedIn breaks things** | vendor absorbs it |
| Control / data | total | vendor holds sessions |
| Ban liability | ours | partially vendor-managed |
| Lock-in | none | vendor API |

**Recommendation:** if this is core IP and you'll run >50 accounts long-term,
build it — the per-account economics win and you own the data path. If you need
real-time *this quarter* and have <20 accounts, **integrate Unipile now**, and
build behind it in parallel; our internal webhook contract (§4) is deliberately
shaped like Unipile's so we can swap the backend later without changing
downstream consumers. That dual-track is the lowest-risk path.

---

## 10. Legal / ToS reality check

- LinkedIn's User Agreement prohibits automated scraping/access. Using Voyager +
  realtime is the same data the user can already see, driven on their behalf,
  but it is still automation. *hiQ v. LinkedIn* covered **public** data; this is
  **authenticated** data — different and riskier.
- Mitigations: explicit user consent to operate their account, per-account
  isolation, human-pace limits, data minimization, retention limits, and a kill
  switch per account.
- Get sign-off from legal before scaling. This plan is the technical "how"; the
  "should we" is a business/legal decision.

---

## 11. First concrete steps (week 1)

1. Add a Playwright request-interceptor harness that logs every Voyager +
   realtime request the web app makes during a manual login+inbox session.
   Capture: URLs, headers, queryIds, the realtime subscribe handshake.
2. From that capture, write a throwaway script that, using a saved cookie jar,
   calls `GET /voyager/api/messaging/conversations` directly and prints JSON.
   This proves the auth-header derivation end-to-end.
3. Open a `/realtime/connect` from the same script and log the first 10 frames.
   This proves real-time is reachable from our egress.
4. If steps 2–3 work behind a residential proxy → green-light Phase 1.

Those three spikes de-risk the entire plan in ~3 days.
