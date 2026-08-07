# Anti-ban without paying for residential proxies

A companion to `ANTI_BAN_STRATEGY.md`. This doc covers what you can and cannot
get away with on a strict zero/low-budget plan, and what to build instead.

---

## TL;DR

| Approach | Cost | LinkedIn flags it? | Scales? | Verdict |
|---|---|---|---|---|
| Direct from DigitalOcean | $0 | YES (datacenter ASN) | n/a | ❌ Current state — burning accounts |
| Tor exit nodes | $0 | YES (public exit list) | n/a | ❌ Useless for LinkedIn |
| Free proxy lists | $0 | YES + malicious | no | ❌❌ Dangerous — steals cookies |
| Cloudflare WARP | $0 | YES (CF range flagged) | no | ❌ |
| Public free VPNs | $0 | YES (datacenter ranges) | no | ❌ |
| Self-hosted VPN on another cloud | ~$5/mo | YES (still datacenter) | no | ❌ Same problem |
| **Self-hosted SOCKS on a home Raspberry Pi** | $35 one-time | NO (residential ASN) | small | ✅ For 1–5 accounts |
| **4G/LTE USB dongle + cheap SBC** | $50 one-time + $10/mo SIM | NO (mobile ASN — very trusted) | small | ✅✅ Best $/account |
| **Bring-your-own-IP (desktop agent)** | $0 marginal | NO (real user's home) | yes | ✅✅ If users exist |
| Software-only hardening (no proxy) | $0 | mitigates #2 + #3 only | n/a | ⚠️ Helps but doesn't fix root cause |

**Recommendation if you genuinely can't spend $50/mo on proxies:** build the
**Bring-Your-Own-IP agent** (Section 4) if users own these accounts, OR put **one
4G dongle on a Raspberry Pi at home/office** as the egress (Section 3). Both
beat "no proxy" by an order of magnitude.

---

## 1. Why the obvious free options don't work

### Tor

LinkedIn publishes a hardcoded block on all known Tor exit relays (the list is
public at `check.torproject.org/exit-addresses`). Tor will return `403`,
`/authwall`, or your favorite `ERR_TOO_MANY_REDIRECTS` within seconds.

### Free proxy lists (`free-proxy-list.net`, etc.)

Three independent problems:

1. **Already burned.** The same lists are scraped by every spammer on Earth.
   LinkedIn's seen them all.
2. **Short-lived.** Median uptime: hours. You'd spend more eng time on health
   checks than on the actual feature.
3. **Hostile.** Many free proxies MITM HTTPS via injected certs or just log every
   cookie that passes through. You'd be handing LinkedIn session tokens to
   unknown operators. **This is catastrophic** for anything that touches auth.

Hard "no".

### Cloudflare WARP / Tailscale Exit Nodes / Wireguard on Hetzner

Same root problem as DigitalOcean — these are *datacenter* IPs. CF WARP egress
IPs are widely published and LinkedIn flags them. Tailscale exit nodes egress
from wherever the host is (usually another datacenter). A Hetzner box has a
Hetzner ASN. None of these change the fundamental "datacenter == bot" signal.

### Self-hosted VPN on a cheaper VPS

Moves the problem, doesn't solve it. `$5/mo Hetzner` is just a different
datacenter ASN, still flagged.

---

## 2. What software-only hardening DOES buy you (no proxy)

If you're stuck on a DO IP for now, these still help — they make the existing
flag take longer to land and slow the cascade once it does. None of them stop
the eventual ban, but they extend MTBF (mean time between bans) significantly.

These are all already in `ANTI_BAN_STRATEGY.md`; restating with the **emphasis
adjusted** for "no proxy budget":

### 2.1 — Drop request volume by 70–90%

Number-one defense when your IP is the problem. With a datacenter IP, current
defaults are way too aggressive.

```yaml
# docker-compose.yml — emergency safe-mode defaults
SYNC_INTERVAL_MINUTES: "30"           # was 5
BACKFILL_INTERVAL_MINUTES: "240"      # was 60
UNIFIED_DELTA_MAX_THREADS: "1"        # was 1 — keep
UNIFIED_DELTA_THREAD_LIMIT: "4"       # was 12
UNIFIED_BACKFILL_THREAD_LIMIT: "8"    # was 30
```

### 2.2 — Hard cap actions per hour (per account)

Implement in `worker/src/rateLimit.js`. With no proxy, halve everything from
the main strategy:

| Action | Per hour | Per day |
|---|---|---|
| Inbox reads | 12 | 80 |
| Thread reads | 25 | 150 |
| Profile views | 6 | 30 |
| Connection requests | 2 | 8 |
| Messages sent | 3 | 12 |
| Searches | 4 | 20 |

### 2.3 — Strict business-hours-only operation

If your accounts are US-Eastern, run only 09:00–18:00 ET, Mon–Fri. Round-the-clock
traffic from a fixed IP is the loudest signal possible.

```js
// worker/src/scheduler.js (new)
function isWithinBusinessHours(geoTz = 'America/New_York') {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: geoTz }));
  const hour = local.getHours();
  const day = local.getDay();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}
```

Gate `scheduleAdaptiveSync` on this in `worker/src/unified/SyncOrchestrator.js`.

### 2.4 — Real fingerprint diversification

Detailed in main doc, Phase B. Critical when IP is shared/datacenter — at least
make sure two accounts behind the same IP don't share fingerprints, or LinkedIn
correlates them as "obviously the same bot operator".

### 2.5 — Full cookie capture + restore

Main doc, Phase D. With a datacenter IP, LinkedIn is *already* suspicious — a
clean, complete, long-lived cookie set is the only thing convincing it the
session is "real". A bare `li_at` token is a flag by itself.

### 2.6 — `rebrowser-playwright`

Free, drop-in replacement for `playwright`. Already supported via
`USE_REBROWSER_PLAYWRIGHT=1` in `worker/src/browser.js:4`. Patches the most
common CDP-leak detectors. **Turn this on regardless of proxy choice.**

```yaml
# docker-compose.yml
USE_REBROWSER_PLAYWRIGHT: "1"
```

### 2.7 — TLS fingerprint masking (advanced, free)

Playwright's bundled Chromium has a distinctive JA3. Mitigations:

- **`curl-impersonate` for any API calls** that don't need a real browser
  (e.g., the legacy unified-search API path). It mimics real browser TLS
  handshakes byte-for-byte. Free, MIT-licensed.
- **`uTLS` (Go) reverse proxy in front of Playwright** — overkill for most
  setups, but the option exists.

Net: ~5–10% of the fingerprinting signal goes away.

### 2.8 — Software-only realistic outcome

With **all of 2.1–2.7** but no proxy improvement, on a DigitalOcean droplet:

- Expect **2–5× longer time-to-ban** per account.
- Expect a **5–10× drop in total daily throughput** (the cost of safety).
- Expect bans to **still happen**. Just less often.

If that's an acceptable trade, skip the next sections. If it's not, read on.

---

## 3. Cheap residential egress without paying a proxy service

### 3.1 — The Raspberry Pi at home approach

If you (or a team member) have residential internet:

**Hardware:** Raspberry Pi 4 (4GB), $35 one-time. Or any old laptop.

**Setup:**

```bash
# On the Pi at home
sudo apt install dante-server   # tiny SOCKS5 server
# /etc/danted.conf
logoutput: stderr
internal: 0.0.0.0 port = 1080
external: eth0
clientmethod: username
socksmethod: username
user.privileged: root
user.unprivileged: nobody

# Add a user for the worker to authenticate as
sudo useradd -r linkedin-egress
sudo passwd linkedin-egress
sudo systemctl restart danted
```

**Expose it.** Two options:

- **Cloudflare Tunnel (free):** `cloudflared tunnel route` to expose the SOCKS
  port via a stable hostname without opening home ports. Latency cost: ~30ms.
- **Tailscale (free for personal):** put the Pi and the DO worker on the same
  tailnet; the worker connects via `linkedin-egress.tailnet:1080`.
  Latency cost: ~20ms.

**Wire it into the worker:**

```yaml
# docker-compose.yml
PROXY_URL: "socks5://linkedin-egress:CHANGEME@home-pi.your-tailnet.ts.net:1080"
HTTP_PROXY: "socks5://linkedin-egress:CHANGEME@home-pi.your-tailnet.ts.net:1080"
HTTPS_PROXY: "socks5://linkedin-egress:CHANGEME@home-pi.your-tailnet.ts.net:1080"
```

**Pros:**
- Genuinely residential ASN (Comcast, Spectrum, Verizon FiOS, etc.). LinkedIn
  treats it like a normal household.
- Sticky by definition — same IP every time unless your ISP rotates (rare for
  fiber, occasional for cable).
- One-time $35.

**Cons:**
- **Capped to ~1 IP per home.** Three accounts on one IP is fine; thirty is not.
- Your ISP's terms of service may forbid "business use" or proxying — read the
  fine print. Residential ISPs rarely enforce against light usage but can.
- **You're the egress.** If LinkedIn's lawyers ever subpoena your residential
  IP, your name is on it. For an enterprise tool, this matters.
- Reliability is your home internet's reliability. Comcast outages = worker down.

**Realistic capacity:** 1–5 LinkedIn accounts behind one Pi.

### 3.2 — 4G/LTE USB dongle (the actual best-kept-secret)

Mobile network IPs are the **most trusted IP class on LinkedIn**. They're
heavily NAT'd (CGNAT) — millions of real humans share them — so LinkedIn can't
afford to block a whole carrier. They're rated even higher than fiber-to-home.

**Hardware:**
- Cheap LTE USB modem ("Huawei E3372", "Quectel EC25") — $30–50.
- Prepaid SIM with a small data plan — $5–15/mo, often pay-as-you-go. Look for
  "data-only" SIMs.
- Optional: Raspberry Pi to host it (or any always-on machine).

**Setup:**

```bash
# Bring up the LTE interface
sudo apt install usb-modeswitch wvdial
# Configure /etc/wvdial.conf with carrier APN
sudo wvdial &
# Now you have wwan0 with a mobile IP — set up SOCKS or use as a default route
```

**Source-route SOCKS only through the LTE interface:**

```bash
# Mark LTE traffic, add a separate routing table so only proxied connections use it
ip rule add fwmark 0x1 lookup lte
ip route add default dev wwan0 table lte
```

Then run `dante` bound to `wwan0` as in 3.1.

**Pros:**
- **Mobile carrier IP** — top tier trust.
- Multiple SIMs from different carriers → multiple distinct IPs from one box.
- Cheap to scale modestly (5–10 SIMs in one box at ~$10/mo each).
- IP rotates organically when the modem reconnects (every few hours), which is
  *more* human, not less — phones move between cell towers.

**Cons:**
- Data caps. LinkedIn syncing uses ~50–200 MB/account/day. Pick plan accordingly.
- Carriers occasionally throttle or rotate IPs at inconvenient times. Build
  your scheduler to be resilient to brief egress outages.
- You still need a physical home/office to plug the dongle in. **This is the
  "no physical" exception** — there's no equivalent IP class without a SIM and
  a radio somewhere.

**Realistic capacity:** 1–3 LinkedIn accounts per SIM. 5+ SIMs in one box.
**Total per account: ~$10–15/mo, fully amortized**, vs. $50+/IP on Bright Data.

### 3.3 — Friends-and-family residential pool

Same idea as 3.1, scaled across people you know. If five teammates each host a
Pi at home, you've got 5 distinct residential ASNs across geographies for $175
one-time and no recurring cost. Tailscale stitches them into one network.

This is what proxy providers do, except they pay residential users a few
dollars a month. You can do the same internally with much less overhead.

---

## 4. Bring-Your-Own-IP (the architecturally elegant answer)

If your end users are real humans who own the LinkedIn accounts you're
operating, **make their machine the egress**.

### How it works

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  User's laptop  │     │  Your worker on  │     │   LinkedIn       │
│   (residential) │◄────┤   DigitalOcean   │     │                  │
│                 │ WS  │                  │     │                  │
│  - Tiny agent   │     │  - Browser auto  │     │                  │
│  - SOCKS5 svr   │     │  - Sends HTTP    │     │                  │
│  - Auth tunnel  │     │    via user's    ├────►│  Sees user's     │
└─────────────────┘     │    agent         │     │  real home IP    │
                        └──────────────────┘     └──────────────────┘
```

The user installs a small (~5MB) agent that:
1. Authenticates against your server (mTLS or signed token).
2. Opens an outbound WebSocket to your worker.
3. Exposes a SOCKS5 endpoint that the worker uses for that user's actions only.

The user's machine is the egress. Their LinkedIn sees their real home IP.

### What you ship

- **Desktop agent**: Tauri (Rust + tiny webview, ~5MB) or Electron (heavier).
  Embeds a SOCKS5 server, wraps it in WS-over-TLS for NAT traversal.
- **Worker change**: per-account proxy URL points at the agent's WS tunnel.
- **Reliability**: queue actions when the agent is offline; replay when it
  reconnects. Already half-built — your existing BullMQ retry logic covers
  this.

### Trade-offs

✅ Zero proxy cost. Zero IP reputation problem — it's literally the user's IP.
✅ Per-user isolation is automatic. No way for two users' actions to share an IP.
✅ Legally clean — the user is the one running automation on their own account
   and their own connection. No proxy operator in the middle.
❌ Only works if users are willing to install something.
❌ Agent maintenance burden — auto-update, crash reporting, etc.
❌ User's machine has to be on for sync to happen.

### When to choose this

If your product is "we automate LinkedIn for SMB sales teams" where each user
is a person at a company, **this is the right architecture full stop**, even
if you have proxy budget. Sales teams want their own IP doing the actions
anyway — it keeps the account safer in the long term.

If your product is "we operate accounts on behalf of a marketing agency" where
the operator and the account-owner are different people, this doesn't fit.

### Effort estimate

- 2 weeks to build a minimum-viable Tauri agent + auth.
- 1 week to wire the per-account proxy lookup into the existing
  `worker/src/browser.js` plumbing.
- Ongoing: agent ops (auto-update channel, telemetry).

---

## 5. Hybrid: zero-cost path that actually works

If you ship exactly this combination, it's a real production system at $0
recurring proxy cost:

1. **Phase 2 hardening** from main doc (browser pool, etc.) — already in main.
2. **All of Section 2** here (volume cut, rate caps, business-hours, fingerprint,
   cookies, rebrowser) — ~1 week of work.
3. **One of**:
   - **3.1** Raspberry Pi at someone's home for 1–5 accounts, OR
   - **3.2** 4G dongle for 1–3 accounts per SIM, OR
   - **4** BYO-IP agent if your users are real people.
4. **Phase E** circuit breaker from main doc — 2 days. Stops cascades.
5. **Phase G** monitoring — 3 days. Tells you early when something's wrong.

Total recurring cost: **$0–15/mo** depending on which Section 3 option.

Total one-time cost: **$35–100** for hardware (Pi or modem).

Compared to $200–600/mo on residential proxies, that's a 95% cost reduction
with — honestly — comparable LinkedIn-trust if you're operating 1–10 accounts.
At 50+ accounts, paid proxies start to win on operational simplicity.

---

## 6. What you should NOT spend time on

These keep coming up in forum threads and they're all wrong for LinkedIn
specifically:

- **`puppeteer-extra-stealth`, `playwright-stealth`** — LinkedIn fingerprints
  the plugins themselves. You're adding a signal, not removing one. The
  `rebrowser-playwright` patch (Section 2.6) is the modern, correct alternative.
- **Random user-agent rotation per request** — flips fingerprint mid-session;
  this is itself a flag. Fingerprint **stability per account** is human; rotation
  is robotic.
- **Headless detection bypass via `navigator.webdriver=undefined` tricks** —
  Playwright already does this. LinkedIn checks 30+ other vectors.
- **Datacenter proxy "premium" services** — same ASN class as DO, same problem.
- **VPN services marketed as "anti-detect"** — almost all are reselling
  datacenter IPs with shiny branding.

---

## 7. Decision tree

```
Do real human users own these LinkedIn accounts?
├── YES → Build BYO-IP agent (Section 4). This is the right answer.
└── NO  → How many accounts?
         ├── 1–10 → 4G dongle box (Section 3.2) or home Pi (Section 3.1).
         │         ~$30–60/mo all-in.
         ├── 10–50 → Pay for residential proxies. IPRoyal sticky residential
         │           is the cheapest acceptable tier (~$50–150/mo).
         └── 50+ → Bright Data ISP proxies. ~$500+/mo. Operational simplicity
                   matters more than absolute cost at this scale.
```

---

## 8. Action items for THIS week, $0 spend

1. Turn on `USE_REBROWSER_PLAYWRIGHT=1` in `docker-compose.yml`. *(15 min)*
2. Cut `SYNC_INTERVAL_MINUTES` from 5 → 30. Cut other thread limits per 2.1. *(15 min)*
3. Add the business-hours gate in 2.3 — 1 file, ~30 lines. *(2 hr)*
4. Implement per-account hourly rate caps in `rateLimit.js`. *(1 day)*
5. Implement the per-surface circuit breaker (main doc Phase E). *(2 days)*
6. Decide proxy approach for next month — BYO-IP, 4G dongle, or paid. *(meeting)*

If steps 1–5 are done by end of week, your ban rate on DO will drop
materially even before any proxy improvement. Then plan the egress upgrade
in week 2.
