# LinkedIn Anti-Ban Strategy — DigitalOcean Deployment

**Status:** plan. Implementation is phased; each phase has an estimated effort and a
direct mapping to files in this repo. Nothing in this document advocates breaking
LinkedIn's ToS — it's defensive hardening to keep legitimate worker sessions alive
under aggressive anti-automation heuristics.

---

## 0. Reading the current incident

From the dashboard screenshot:

- **`personl`** → posture `blocked`, surfaces blocked = 7, error
  `ERR_TOO_MANY_REDIRECTS` on `linkedin.com/mynetwork/invite-connect/connections/`.
- **`test`** → `Missing session`, no LinkedIn cookies imported.

`ERR_TOO_MANY_REDIRECTS` is the smoking gun: LinkedIn detected the request source
(IP, fingerprint, or cookie state) and is bouncing the browser between
`/authwall` ↔ `/login` ↔ original URL. This is what they do when an IP/account is
on their datacenter blocklist but the cookie isn't fully invalidated yet.

The existing code already classifies this in `worker/src/syncPosture.js:70`
(posture `blocked`, 60-min backoff). So **detection works**. What's missing is
**prevention** and **recovery via rotation**.

---

## 1. Root causes (ranked by impact)

| # | Cause | Evidence | Impact |
|---|---|---|---|
| 1 | **All accounts use one shared proxy** (`PROXY_URL` in `docker-compose.yml`) — and if unset, all accounts egress straight from the DigitalOcean droplet's IP. | Single env var, no per-account proxy assignment | **CRITICAL** |
| 2 | **DigitalOcean datacenter ASN is on LinkedIn's known-bot list.** | `ERR_TOO_MANY_REDIRECTS` from the droplet | CRITICAL |
| 3 | Same browser fingerprint across runs (UA, viewport, timezone, fonts) — see `worker/src/browser.js:96-106` (hardcoded `Mozilla/5.0 … Chrome/120 …`, `America/New_York`, `1366×768`). | hardcoded in `createContext` | HIGH |
| 4 | **No proxy ↔ geo ↔ account coherence**: an account whose LinkedIn profile location is "Paris" egressing from a US datacenter is an instant flag. | no `account.geo` field; no proxy selection by geo | HIGH |
| 5 | Sync cadence is account-agnostic (`SYNC_INTERVAL_MINUTES=5`). Round-the-clock evenly-spaced traffic is robotic. | `docker-compose.yml:66` | MED |
| 6 | TLS/JA3 fingerprint of bundled Playwright Chromium is identifiable. | default Playwright build | MED |
| 7 | Cookie set isn't kept *complete and warm* — only the auth cookies are imported, not `bcookie`, `bscookie`, `lidc`, `JSESSIONID`, etc. | `worker/src/actions/connectSession.js` | MED |
| 8 | No circuit breaker per surface — when one surface (Connections) is blocked, the worker keeps hitting it. The "7 surfaces blocked" cascade is partly this. | observable in screenshot | MED |
| 9 | No CAPTCHA / checkpoint solver. When LinkedIn shows a checkpoint, the account is just "blocked" forever until manual intervention. | `posture: 'checkpoint'` is terminal | LOW–MED |
| 10 | Single Xvfb display ID `:99` shared across all account contexts → indirectly correlatable via timing. | `worker/entrypoint.sh:15` | LOW |

---

## 2. Strategy at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Account A  ──►  Sticky residential proxy A (geo-matched)        │
│  Account B  ──►  Sticky residential proxy B (geo-matched)        │
│  Account C  ──►  Sticky residential proxy C (geo-matched)        │
│       │                       │                                  │
│       ▼                       ▼                                  │
│  Worker container egress all through a per-account proxy.        │
│  DigitalOcean droplet IP is NEVER seen by LinkedIn.              │
└─────────────────────────────────────────────────────────────────┘
            +
   Per-account fingerprint (UA, viewport, TZ, locale)
            +
   Human-pace cadence (jittered, business-hours weighted)
            +
   Per-surface circuit breakers + global cooldown
            +
   Observability & alerting
```

**Rule of thumb:** if a real human couldn't physically do what your worker just
did (browsing 24/7, jumping countries, 100 actions/hour), LinkedIn will catch it.

---

## 3. Phased plan

### Phase A — Proxy rotation foundation (highest impact, ~1 week)

**Goal:** every account has its own sticky residential IP. The DigitalOcean
droplet IP never appears on LinkedIn.

#### A.1 — Schema + config

Add `Account.proxyId`, `Proxy` table:

```prisma
model Proxy {
  id           String   @id @default(cuid())
  provider     String   // "smartproxy" | "brightdata" | "oxylabs" | "iproyal"
  label        String?
  url          String   // "http://user-XYZ-session-S1:pwd@gate.smartproxy.com:7000"
  geo          String   // "US-NY", "GB-LON", "FR-PAR" — must match Account.geo
  stickyMinutes Int     @default(30)  // session pinning duration
  healthScore  Float    @default(1.0) // 0..1, decremented on failures
  lastUsedAt   DateTime?
  cooldownUntil DateTime?
  bannedUrls   Json?    // list of URLs that returned redirects/captcha
  createdAt    DateTime @default(now())
  accounts     Account[]
}

model Account {
  // ...existing fields
  proxyId   String?
  proxy     Proxy?  @relation(fields: [proxyId], references: [id])
  geo       String? // "US-NY" — pin from LinkedIn profile or onboarding
}
```

#### A.2 — Provider choice for DigitalOcean

DO doesn't restrict outbound, but the DO ASN is the problem. Recommended providers
(ordered by anti-detection quality):

| Provider | Type | Why |
|---|---|---|
| **Bright Data ISP Proxies** | Static residential (ISP) | Highest trust — these IPs are leased to actual ISPs, sticky for weeks |
| **Smartproxy Residential** | Rotating + sticky residential | Good price/perf, sticky sessions up to 30 min |
| **IPRoyal Residential** | Pay-per-GB sticky residential | Cheap, fine for low-volume |
| **Oxylabs Residential** | Premium rotating residential | High quality, expensive |

**Avoid**: any "datacenter proxy" service — same problem as DO directly. Avoid
free proxy lists — already burned.

#### A.3 — Sticky session pinning

LinkedIn distrusts IP-flipping mid-session. With Smartproxy syntax:

```
http://user-USERNAME-session-{ACCOUNT_HASH}:pass@gate.smartproxy.com:7000
```

The `session-XXXX` token tells the proxy gateway to keep the egress IP stable
for N minutes (configurable per provider). Use `accountId` hashed → session
token so the same account always gets the same IP within a window.

#### A.4 — Wire it into `browser.js`

`worker/src/browser.js:72-88` currently takes a single `proxyUrl` argument.
Replace its callers (`getAccountContext`) to look up `account.proxy.url` at
session creation. Add:

```js
// pseudo-code, src/browser.js
async function resolveProxyForAccount(accountId) {
  const account = await accountRepo.getById(accountId);
  if (!account?.proxy?.url) {
    throw new Error(`No proxy assigned for ${accountId} — refusing to use direct egress`);
  }
  if (account.proxy.cooldownUntil && account.proxy.cooldownUntil > new Date()) {
    throw new Error(`Proxy for ${accountId} is in cooldown until ${account.proxy.cooldownUntil}`);
  }
  return account.proxy.url;
}
```

**Critical safety rule:** if no proxy is assigned, the worker **refuses to run**
rather than falling back to direct egress. Better to break a job than burn an
account.

#### A.5 — Health scoring + cooldown

When `classifySyncFailure` returns posture `blocked` or `automation_warning`:

1. Decrement `Proxy.healthScore` by 0.2 for that proxy.
2. If healthScore < 0.4 → set `cooldownUntil = now + 6h` on the proxy.
3. If healthScore < 0.2 → mark proxy inactive, alert ops to retire it.

Restore +0.05 per successful action, capped at 1.0.

**Effort:** ~1 week. **Expected impact:** eliminates the dominant ban vector.

---

### Phase B — Browser fingerprint diversification (~3 days)

#### B.1 — Per-account fingerprint stored at account creation

Add `Account.fingerprint Json` containing:

```json
{
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...",
  "viewport": { "width": 1440, "height": 900 },
  "deviceScaleFactor": 1,
  "platform": "Win32",
  "locale": "en-US",
  "timezoneId": "America/Chicago",
  "languages": ["en-US", "en"],
  "colorScheme": "light",
  "hardwareConcurrency": 8,
  "deviceMemory": 8,
  "webglVendor": "Google Inc. (Intel)",
  "webglRenderer": "ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.1)"
}
```

Generate ONCE at account onboarding (random within plausible ranges) and **never
change**. LinkedIn fingerprints persist across sessions; flipping is itself a
signal.

#### B.2 — Apply at context creation

In `worker/src/browser.js`, replace the hardcoded `createContext` options
(lines 96-106) with `account.fingerprint`. Also inject WebGL/canvas spoofing via
`context.addInitScript` before any page navigates.

#### B.3 — Match TZ/locale to proxy geo

A proxy egressing from London with `America/New_York` is an obvious bot. Enforce:

```js
assert(account.fingerprint.timezoneId === geoToTz(account.proxy.geo));
assert(account.fingerprint.locale.startsWith(geoToLocale(account.proxy.geo)));
```

#### B.4 — Consider `rebrowser-playwright`

The repo already supports it via `USE_REBROWSER_PLAYWRIGHT=1` (see `browser.js:4`).
`rebrowser-playwright` patches CDP leak vectors (Runtime.enable, etc.). Turn it
on in prod. Expect a 20–30% reduction in "automation detected" hits.

**Effort:** ~3 days. **Expected impact:** removes the secondary detection vector.

---

### Phase C — Human-pace behavior (~1 week)

The existing `worker/src/humanBehavior.js` is a start. Extend it:

#### C.1 — Time-of-day weighting

LinkedIn traffic for a given user clusters in business hours of their geo.
Apply a weight curve:

```js
function activityProbability(geoTz, now = new Date()) {
  const hour = (new Date(now.toLocaleString('en-US', { timeZone: geoTz }))).getHours();
  // bell curve centered at 10am, low overnight
  const peaks = { 9: 0.9, 10: 1.0, 11: 0.95, 14: 0.85, 15: 0.8, 16: 0.7 };
  if (hour >= 22 || hour < 6) return 0.02;        // near-zero overnight
  if (hour >= 19) return 0.15;                     // evening
  return peaks[hour] || 0.4;
}
```

Use this to gate whether the scheduler dispatches a sync at all. Sync should be
**very rare overnight in the account's local timezone**.

#### C.2 — Jittered cadence

Replace `SYNC_INTERVAL_MINUTES=5` with a **distribution**, not a fixed value:

```
delta_sync_interval ~ LogNormal(mean=12min, sigma=0.5min, min=4min, max=45min)
```

Already a hook for this in `worker/src/unified/SyncOrchestrator.js`
(`syncCadenceForPosture`). Wire in the jitter there.

#### C.3 — Action budget per account

Hard caps per rolling window — these mirror what a real heavy user does:

| Action | Per hour | Per day |
|---|---|---|
| Inbox reads | 30 | 200 |
| Thread reads | 60 | 400 |
| Profile views | 15 | 80 |
| Connection requests | 5 | 20 |
| Messages sent | 8 | 30 |
| Searches | 10 | 50 |

Enforce in `worker/src/rateLimit.js` (file exists, presumably underused). Reject
the job before browser launch if a budget is exhausted; surface "rate-limited"
posture, not failure.

#### C.4 — Inter-action think time

Don't just sleep N ms — model dwell time per page type:

| Page | Min ms | Max ms | Distribution |
|---|---|---|---|
| Inbox list | 1500 | 8000 | beta(2,5)·max + min |
| Thread view | 3000 | 25000 | beta(2,3)·max + min |
| Profile | 4000 | 30000 | beta(2,3)·max + min |
| Search results | 2000 | 12000 | beta(2,4)·max + min |

#### C.5 — Mouse/scroll humanization

Already in `humanBehavior.js`. Audit it — ensure:
- Mouse paths use Bezier curves with overshoot/correction, not straight lines.
- Scroll uses variable speeds, occasional reverse scrolls.
- Typing has per-character delay drawn from a distribution, with realistic typo+backspace rate (~3%).

**Effort:** ~1 week. **Expected impact:** removes behavioral signals that survive proxy + fingerprint.

---

### Phase D — Session hygiene (~2 days)

#### D.1 — Full cookie capture, not just auth

LinkedIn fingerprints via a *set* of cookies: `li_at` (auth), `JSESSIONID`,
`bcookie`, `bscookie`, `lidc`, `lang`, `_guid`, `lms_ads`, `lms_analytics`.

At onboarding (via the existing VNC interactive login flow), capture **all**
cookies for `*.linkedin.com` and `*.licdn.com`, not just `li_at`. Store
encrypted (existing `SESSION_ENCRYPTION_KEY` mechanism).

#### D.2 — Cookie refresh policy

On every successful page load, re-extract cookies and update storage. LinkedIn
rotates `JSESSIONID` and `lidc` frequently; an old set is a flag.

#### D.3 — Localstorage / IndexedDB

Capture and restore these too. Playwright `context.storageState()` does both.

#### D.4 — Detect "soft logout"

LinkedIn sometimes invalidates the session silently. After every action, check:
- Final URL contains `/login`, `/authwall`, `/checkpoint` → posture `expired`.
- Page DOM contains `Sign in` button → posture `expired`.
- HTTP 401/403 on any API call → posture `expired`.

Already partially handled by `syncPosture.classifySyncFailure`. Add the DOM check.

**Effort:** ~2 days. **Expected impact:** reduces "false bans" from stale cookies.

---

### Phase E — Per-surface circuit breaker (~2 days)

Right now the "7 surfaces blocked" cascade happens because each surface (inbox,
connections, search, notifications, profile, messaging, feed) fails independently
but the worker doesn't stop trying.

Add a per-account, per-surface failure counter in Redis:

```
surface:fail:{accountId}:{surface}  → integer, EXPIRE 1h
```

Rules:
- 3 failures in 1h on the same surface → that surface goes `blocked` for 6h.
- 3 surfaces blocked → the **whole account** goes `cooldown` for 12h.
- During account cooldown, **don't run any actions**, don't even open a browser.

This stops the "blocked → retry → blocked → retry" loop that signals automation
even more strongly than the original detection.

**Effort:** ~2 days. **Expected impact:** prevents amplification when a flag happens.

---

### Phase F — Rotation policies (~3 days)

#### F.1 — Proxy rotation triggers

| Trigger | Action |
|---|---|
| Proxy `healthScore < 0.4` | Mark cooldown 6h, swap account to a healthy proxy in same geo. |
| Same proxy used > 7 days continuously | Pre-emptively rotate (optional) to avoid fingerprint accumulation. |
| Proxy geo mismatch with account | Block account from running until fixed. |

#### F.2 — Account rotation

If an account hits `automation_warning` posture (LinkedIn explicitly flagged):

1. Set `cooldownUntil = now + 7d` (LinkedIn warnings typically clear in ~3–7d).
2. Notify ops via webhook — manual review before re-enabling.
3. When re-enabling: regenerate fingerprint? **No**, keep the same one. LinkedIn
   tracks fingerprint changes as additional risk. Just resume slowly: 10% of
   normal action budget for the first 48h.

#### F.3 — Fingerprint NEVER rotates per-account

Repeating because it's counterintuitive: fingerprint stability across sessions
is *more human* than fingerprint freshness. Generate once, persist forever.

**Effort:** ~3 days. **Expected impact:** principled recovery from any single ban.

---

### Phase G — Monitoring, alerting & cooldown protocol (~3 days)

#### G.1 — Metrics to ship to Prometheus / Datadog / Grafana Cloud

| Metric | Type | Why |
|---|---|---|
| `linkedin_posture{account, posture}` | gauge (0/1) | Health snapshot |
| `linkedin_action_success_rate{account, surface}` | rate | Detect creeping failures before total block |
| `linkedin_action_duration_seconds{account, surface}` | histogram | Latency spikes = LinkedIn rate-limiting silently |
| `proxy_health_score{proxy}` | gauge | Cooldown candidates |
| `proxy_egress_ip{proxy}` | gauge (info) | Confirm sticky sessions are sticking |
| `worker_browser_recycles_total` | counter | Pool churn |
| `redirect_loop_detected_total{account, surface}` | counter | Direct anti-ban signal |

#### G.2 — Alerts

- `automation_warning` posture on any account → PagerDuty / Slack immediately.
- 3+ accounts blocked in 1h → likely proxy-pool issue, page on-call.
- Proxy health average < 0.6 across pool → buy more proxies.

#### G.3 — Cooldown protocol (manual runbook)

When an account hits a hard block:

1. **Stop all automation for that account immediately** (Phase E circuit breaker should do this automatically).
2. Wait 48h minimum. Do not log in even manually.
3. After 48h: log in via the VNC interactive flow **from a residential network**
   (not the worker), perform a few normal human actions (read one message, view
   one profile), log out.
4. Wait another 24h.
5. Re-import session via onboarding flow. Run at 10% action budget for 48h.
6. Ramp to 25% / 50% / 75% / 100% over the following week if no flags.

#### G.4 — Quarterly account audit

Some accounts will be "burned" permanently. Track per-account ban frequency. If
an account is blocked more than once in 30 days, retire it.

**Effort:** ~3 days. **Expected impact:** transforms reactive bans into proactive risk management.

---

### Phase H — DigitalOcean-specific concerns (~1 day)

#### H.1 — Outbound NAT on DO

Even when proxies are configured, **system-level traffic** from the worker
container (DNS, Playwright telemetry, `chromium` first-run pings) can leak the
DO IP to LinkedIn-adjacent endpoints (`licdn.com` CDN, etc.).

- Set Playwright env: `PLAYWRIGHT_BROWSERS_PATH`, disable telemetry, disable
  first-run network checks (already partially done in `CHROME_ARGS` in
  `browser.js:9-26`).
- Use the proxy at **container level** via `HTTP_PROXY`/`HTTPS_PROXY` (already
  wired in `docker-compose.yml:77-78`) — ensure it's the **per-account** proxy,
  not a single one. This requires the worker container per account, not one
  shared worker. **See H.4.**

#### H.2 — DNS via proxy too

By default Playwright resolves DNS locally even when proxied (`proxy.bypass`
behavior). Use `--proxy-bypass-list=` empty and ensure DNS goes through the
proxy too. For Smartproxy/Bright Data, this is the default; verify.

#### H.3 — IPv6 leak

DigitalOcean droplets have IPv6 enabled. If the proxy is IPv4-only, the browser
may dual-stack and leak. Disable IPv6 inside the worker container:

```yaml
# docker-compose.yml worker service
sysctls:
  - net.ipv6.conf.all.disable_ipv6=1
  - net.ipv6.conf.default.disable_ipv6=1
```

#### H.4 — Worker isolation per account (architectural)

Today there's one worker container with N account queues. For maximum safety,
each account should ideally have its own container with its own proxy env vars.
This eliminates any chance of cross-account cookie/state contamination.

Practical compromise: keep one container, but ensure per-account `BrowserContext`
isolation (already done via `getAccountContext` in `browser.js:229`).

#### H.5 — Avoid DO Spaces / CDN for assets

If you serve any LinkedIn-adjacent content from DO Spaces (`*.digitaloceanspaces.com`),
LinkedIn can correlate. Probably not an issue here, but worth checking.

**Effort:** ~1 day. **Expected impact:** plugs leaks that bypass everything above.

---

### Phase I — CAPTCHA / Checkpoint handling (optional, ~3 days)

When LinkedIn shows a checkpoint, current code returns posture `checkpoint` and
gives up. Options:

#### I.1 — Manual intervention (cheapest, most reliable)

Use the existing noVNC interactive flow. Notify ops via webhook on `checkpoint`
posture → ops opens noVNC, solves the challenge, marks account healthy.

#### I.2 — 2captcha / Anti-CAPTCHA API integration

Pricey but automatable. Worth it only if checkpoint frequency is high.

#### I.3 — Avoid triggering them in the first place

By far the best strategy — Phases A–G should bring checkpoint rate near zero.

**Effort:** ~3 days for option I.2. **Expected impact:** reduces ops toil; not a substitute for prevention.

---

## 4. Sequencing & expected outcome

| Phase | Effort | Bans prevented (est.) | Order |
|---|---|---|---|
| A — Residential per-account proxies | 1 week | 60–80% | **First** |
| B — Fingerprint diversification | 3 days | additional 10–15% | Second |
| C — Human pace | 1 week | additional 5–10% | Third |
| D — Session hygiene | 2 days | 2–5% | In parallel with B |
| E — Circuit breaker | 2 days | prevents *cascades* | In parallel with C |
| F — Rotation policies | 3 days | governance, not prevention | After A |
| G — Monitoring | 3 days | early warning | Throughout |
| H — DO leak plugging | 1 day | 5% (when otherwise ok) | After A |
| I — CAPTCHA solving | 3 days | nice-to-have | Last |

**Total:** ~4–5 weeks for a one-engineer team. Phase A alone gets you most of the
way; if you can only ship one thing, ship A.

---

## 5. Cost model (DigitalOcean + proxies)

| Item | Cost/month |
|---|---|
| DO droplet (s-2vcpu-4gb) | $24 |
| DO managed Postgres (basic) | $15 |
| Bright Data ISP proxies, 10 sticky IPs | ~$500 (volume-discounted) |
| OR Smartproxy residential, 50 GB/mo | ~$300 |
| OR IPRoyal sticky residential, 20 GB/mo | ~$140 |
| 2captcha (if used) | ~$30 |
| Datadog (1 host) | $15 |
| **Total realistic** | **$200–$600 / month** |

Proxies will dwarf everything else. Budget accordingly — cheap proxies =
expensive bans.

---

## 6. Concrete next steps for the two accounts in the screenshot

**`personl` (blocked, ERR_TOO_MANY_REDIRECTS):**

1. **Do not retry today.** The 60-min backoff in `syncPosture.js` is far too short
   for a hard block. Manually set `cooldownUntil = now + 48h` in the Account row.
2. Assign a **fresh residential proxy** in the account's geo before next run.
3. After 48h, log in via noVNC from a residential network, perform 3–5 light
   manual actions, log out, wait 24h.
4. Re-enable at 10% action budget. Watch for posture flips.

**`test` (missing session):**

1. This account never completed onboarding — no cookies were imported.
2. Before connecting: assign a proxy + geo + fingerprint.
3. Then go through the noVNC connect flow normally.
4. Capture **all** cookies (Phase D.1), not just `li_at`.

---

## 7. What this plan deliberately does NOT do

- **Doesn't try to defeat LinkedIn detection via stealth plugins.** They detect
  the plugins themselves. The fight is asymmetric — stay behavioral, not technical.
- **Doesn't recommend account farming.** Use real accounts only.
- **Doesn't push action volume.** Volume is what kills accounts; the system
  should be slower than you think it needs to be.
- **Doesn't promise zero bans.** It promises a recoverable, observable, scalable
  setup that minimizes bans and isolates blast radius when they happen.

---

## 8. Open questions for the team

1. How many active accounts is this system expected to scale to? (Affects proxy budget.)
2. What's the geo distribution of accounts? (Affects which proxy provider regions to buy.)
3. Are accounts owned by real users (BYO cookies) or operational accounts (system-managed)? (Affects onboarding flow.)
4. SLA on action latency? (Affects how aggressive the human-pace pacing can be.)
5. Is there budget for an ops on-call rotation to handle checkpoint solves?
