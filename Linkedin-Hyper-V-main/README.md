# LinkedIn Hyper-V

> Self-hosted, multi-account **LinkedIn unified mailbox** — a drop-in replacement for Unipile's LinkedIn messaging surface.
> No third-party SaaS. Real Google Chrome instances run inside Docker (driven by Playwright like a human), backed by LinkedIn's own Voyager API for fast, low-footprint reads.

---

## What It Does

| Feature | Details |
|---|---|
| **Unified Inbox** | Every conversation from every connected account in one feed, persisted in PostgreSQL with a live-browser fallback |
| **Thread View & Reply** | Read full history and reply from the dashboard |
| **New Conversations** | Start a conversation from any LinkedIn profile URL |
| **Connection Requests** | Send invitations with an optional note, per-account rate limited |
| **Connections & Invitations** | Browse synced connections and pending invitations |
| **Notifications** | Unified LinkedIn notification feed across accounts |
| **People Search** | Search LinkedIn people through any connected account |
| **Voyager API reads** | Optional fast path (`USE_VOYAGER_READS`) that reads inbox/threads via LinkedIn's internal Voyager API instead of DOM scraping |
| **Real-time** | Voyager realtime stream + Socket.IO push new messages to the dashboard |
| **Background Sync** | Adaptive delta sync, patient full-mirror backfill (`ENABLE_BACKFILL`), and connection/invitation pollers |
| **Anti-ban controls** | Per-account daily **and** hourly caps, human-behavior emulation, session cooldowns, optional rotating proxy pool |
| **Account Onboarding** | Import session cookies (wizard/API) or log in interactively via an embedded noVNC browser; optional credential capture + programmatic re-login |
| **Webhooks** | Subscribe external systems to events (SSRF-guarded targets, retry with backoff) |
| **Unipile-parity REST** | A `/unified/*` REST surface mirroring Unipile's shape for external integrations |
| **CSV Export** | Export messages and activity per account |
| **Dashboard Auth** | Password login issuing JWT sessions; worker API protected by a shared API key |

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| Worker API | Node.js 20 + Express |
| Browser Automation | rebrowser-playwright + Google Chrome Stable (headed, under Xvfb) |
| LinkedIn Reads | Voyager API client (opt-in) with DOM-scrape fallback |
| Job Queue | BullMQ on Redis (concurrency = 1) |
| Primary Store | PostgreSQL 16 + Prisma |
| Session / Cache Store | Redis (AES-256-GCM encrypted cookies, rate limits, activity logs, cache) |
| Interactive Login | noVNC bridge to the headed Chrome (port 6080) |
| Orchestration | Docker Compose (dev) · Nomad + Harbor (production CI/CD) |

---

## Quick Start (Docker Compose)

### 1. Clone and configure

```bash
git clone https://github.com/Acumen-org/Linkedin-Hyper-V.git
cd Linkedin-Hyper-V
cp env.example .env
```

Edit `.env` — minimum required:

```env
SESSION_ENCRYPTION_KEY=   # openssl rand -hex 32  (exactly 64 hex chars)
API_SECRET=               # openssl rand -hex 24
REDIS_PASSWORD=           # openssl rand -hex 16
DB_PASSWORD=              # openssl rand -hex 16
DASHBOARD_PASSWORD=       # openssl rand -base64 32
JWT_SECRET=               # openssl rand -base64 48 (min 32 chars)
ACCOUNT_IDS=              # comma-separated IDs e.g. alice,bob
```

### 2. Build and start

```bash
docker-compose up -d --build
```

### 3. Verify services are healthy

```bash
docker-compose ps       # postgres, redis, worker, frontend — all "healthy"
docker-compose logs -f worker
```

### 4. Open the dashboard and connect an account

Navigate to [http://localhost:3000](http://localhost:3000), log in with `DASHBOARD_PASSWORD`, then on the **Accounts** page either:

- **Import cookies** — the Add Account wizard accepts a cookie JSON export (`li_at` + `JSESSIONID` minimum), or
- **Interactive login** — opens the real Chrome in an embedded noVNC window to log in manually (survives checkpoints/2FA).

Cookies can also be imported directly against the worker API:

```bash
curl -s -X POST http://localhost:3001/accounts/alice/session \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_SECRET" \
  -d '[{"name":"li_at","value":"AQE...","domain":".linkedin.com","path":"/","httpOnly":true,"secure":true},{"name":"JSESSIONID","value":"\"ajax:...\"","domain":".linkedin.com","path":"/","httpOnly":false,"secure":true}]'
```

### 5. Use the unified inbox

Background sync starts automatically. The **Inbox** page shows every conversation across all connected accounts; replies and new conversations are queued through the worker with human-like behavior.

---

## Environment Variables

### Shared / Frontend

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_SECRET` | ✅ | — | Shared secret between frontend and worker (`X-Api-Key`) |
| `API_URL` | ✅ | `http://localhost:3001` | Internal worker API URL (`http://worker:3001` in Docker) |
| `DASHBOARD_PASSWORD` | ✅ | — | Dashboard login password |
| `JWT_SECRET` | ✅ | — | JWT signing secret (min 32 chars, HS256) |
| `SESSION_MAX_AGE` | ❌ | `2592000` | Dashboard session lifetime (seconds) |
| `NEXT_PUBLIC_WS_URL` | ❌ | same origin | Public WebSocket origin for real-time updates |
| `API_ROUTE_AUTH_TOKEN` | ❌ | — | Optional bearer token for non-browser (service) callers of the BFF |

### Worker

| Variable | Required | Default | Description |
|---|---|---|---|
| `SESSION_ENCRYPTION_KEY` | ✅ | — | 64 hex chars (AES-256-GCM). `openssl rand -hex 32` |
| `ACCOUNT_IDS` | ✅ | — | Comma-separated LinkedIn account IDs |
| `DB_PASSWORD` | ✅ | — | PostgreSQL password (compose builds `DATABASE_URL` from it) |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | ✅ | — | Redis connection (`redis` in Docker) |
| `SESSION_TTL_DAYS` | ❌ | `30` | Encrypted cookie TTL in Redis |
| `SYNC_INTERVAL_MINUTES` | ❌ | `30` | Unified delta-sync interval |
| `BACKFILL_INTERVAL_MINUTES` | ❌ | `60` | Full backfill interval (requires `ENABLE_BACKFILL=1`) |
| `CONNECTIONS_DELTA_INTERVAL_MINUTES` | ❌ | `15` | Connections sync interval |
| `INVITATIONS_INTERVAL_MINUTES` | ❌ | `45` | Invitations sync interval |
| `USE_VOYAGER_READS` | ❌ | `0` | Read inbox/threads via the Voyager API instead of DOM scraping |
| `ENABLE_BACKFILL` | ❌ | `0` | Enable the patient full-mirror backfill harvester |
| `PROXY_POOL` / `PROXY_POOL_URL` | ❌ | — | Enable and source the rotating, health-gated proxy pool |
| `PROXY_URL` | ❌ | — | Single HTTP proxy for Chrome: `http://user:pass@host:port` |
| `BROWSER_HEADLESS` | ❌ | `0` | Keep `0` — headless Chrome is fingerprinted by LinkedIn |
| `BROWSER_CONTEXT_TTL_MS` | ❌ | `300000` | Idle browser-context lifetime |
| `NOVNC_PORT` | ❌ | `6080` | noVNC bridge port for interactive login |
| `NOVNC_PUBLIC_URL` | prod | auto | Public URL where noVNC is proxied |
| `XVFB_WIDTH/HEIGHT/DEPTH` | ❌ | `1366/768/16` | Virtual display size |
| `TRUSTED_ORIGINS` / `FRONTEND_URL` | ❌ | — | Allowed public origins for Socket.IO CORS |
| `RATE_LIMIT_*` / `RATE_LIMIT_HOURLY_*` | ❌ | see below | Override any daily/hourly action cap |

---

## Rate Limits (per account)

Enforced atomically in Redis **before** any browser action, on both a per-UTC-day and a per-hour window (the hourly cap smooths out bot-like bursts):

| Action | Daily | Hourly | Daily override |
|---|---|---|---|
| Messages sent | 25 | 4 | `RATE_LIMIT_MESSAGES_SENT` |
| Connection requests | 15 | 3 | `RATE_LIMIT_CONNECT_REQUESTS` |
| Profile views | 60 | 10 | `RATE_LIMIT_PROFILE_VIEWS` |
| Search queries | 40 | 6 | `RATE_LIMIT_SEARCH_QUERIES` |
| Inbox reads | 500 | 60 | `RATE_LIMIT_INBOX_READS` |

Hourly caps use the `RATE_LIMIT_HOURLY_*` overrides. See [deployment/ANTI_BAN_STRATEGY.md](deployment/ANTI_BAN_STRATEGY.md).

---

## Architecture

```
Browser
  └─ Next.js Frontend :3000  (JWT dashboard auth)
        └─ /api/*        → BFF route handlers → Worker API

Worker Express API :3001  (X-Api-Key)
  ├─ BullMQ queue (concurrency = 1) → worker.js dispatcher
  │     ├─ verifySession / readMessages / readThread
  │     ├─ sendMessage(New) / sendConnectionRequest / searchPeople
  │     ├─ unified sync (delta) + humanBehavior (mouse, typing, scroll)
  │     └─ antiBan cooldowns + rate limits
  ├─ Voyager subsystem  → VoyagerClient / realtime stream (USE_VOYAGER_READS)
  ├─ Harvest subsystem  → backfill orchestrator (ENABLE_BACKFILL)
  ├─ Auth subsystem     → credential capture + programmatic re-login
  ├─ Event bus          → persistence consumer + webhook dispatcher
  ├─ Proxy pool         → rotating, health-gated egress (PROXY_POOL)
  └─ browser.js (Chrome pool via rebrowser-playwright)
        └─ Google Chrome Stable (headed + Xvfb, noVNC bridge :6080)

PostgreSQL :5432 (internal)   — chats, messages, profiles, connections,
                                invitations, notifications, webhooks, sync state
Redis :6379                   — BullMQ, rate limits, encrypted cookies,
                                activity logs, response cache
```

Design docs and runbooks for each subsystem live under [deployment/](deployment/) (anti-ban, proxy pool, Voyager ingestion, backfill, auto-login, Unipile parity, secret rotation, error triage).

---

## Hard Constraints

| Rule | Reason |
|---|---|
| **BullMQ concurrency = 1** | Parallel sessions trigger LinkedIn bans |
| **headed Chrome + Xvfb** | Headless Chrome is fingerprinted and blocked |
| **Google Chrome Stable only** | Chromium lacks the fingerprint of a real user browser |
| **AES-256-GCM with fresh IV** | Never store cookies in plaintext |
| **Rate limit before any action** | Limits are atomic and cannot be raced |
| **Worker port 3001 never public** | Internal API; expose only :3000 behind Nginx/TLS |

---

## Development

```bash
# Frontend type-check + lint (same as CI)
npm ci && npx tsc --noEmit && npx eslint . --ext .ts,.tsx --max-warnings 0

# Worker unit tests (node:test)
cd worker && npm ci && npx prisma generate && npm test

# Local dev on Windows (starts Next.js + worker, applies the Prisma schema)
./start-dev.ps1
```

Production deployment (Docker Compose or Ubuntu/Nginx) is documented in [DEPLOYMENT.md](DEPLOYMENT.md). Production CI/CD builds images to Harbor and deploys to Nomad via `.github/workflows/ci.yml` and `nomad/`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chrome crashes on startup | `shm_size: 1gb` must be set in compose; check with `docker inspect` |
| Xvfb fails | Ensure the worker entrypoint sets `DISPLAY=:99` before node |
| `NO_SESSION` error | Cookie is missing or expired — re-import or use interactive login |
| `RATE_LIMIT_EXCEEDED` error | Account hit its daily/hourly cap — daily resets at UTC midnight |
| Connections/inbox blocked | See [deployment/CONNECTIONS_BLOCKED_RECOVERY.md](deployment/CONNECTIONS_BLOCKED_RECOVERY.md) |
| `Backend unreachable` in UI | Worker container not healthy — `docker-compose logs worker` |
| Redis / Postgres auth errors | Verify `REDIS_PASSWORD` / `DB_PASSWORD` match compose |
| Cannot log in to dashboard | Verify `DASHBOARD_PASSWORD` and `JWT_SECRET` (≥ 32 chars) are set |
| noVNC window blank | Check `NOVNC_PUBLIC_URL` and the `/novnc/` block in `deployment/nginx.conf` |

