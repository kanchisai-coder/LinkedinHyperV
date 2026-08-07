# Rotating proxy pool

A health-gated, self-rotating proxy pool. Feed it candidate proxies; it
health-checks them, keeps only the ones that actually work for LinkedIn, assigns
a sticky proxy per account, and rotates away from any that fail.

## ⚠️ Security warning (read this)
Free/public proxies can MITM HTTPS and **log the LinkedIn session cookies**
(`li_at`) passing through them. The health-gate filters dead/datacenter/burned
proxies but **cannot detect a malicious-but-working proxy**. For anything beyond
throwaway testing, use **paid residential/ISP proxies**. The pool works with any
source — "free" is just a weak, risky source.

## How it decides a proxy is usable (the gate)
A candidate enters the healthy set only if it:
1. is reachable (egress IP resolves),
2. is **not** a hosting/datacenter IP (`ip-api` hosting/proxy flag false) — relax with `PROXY_POOL_ALLOW_HOSTING=1`,
3. loads `linkedin.com` without redirect to authwall/login.

Scored 0–100 (reachable +30, linkedin-ok +40, residential +20, fast +10);
highest score wins. **Most free proxies fail this gate** — that's the gate
working, not a bug.

## Configure
```hcl
# Provide candidates (any/all):
PROXY_POOL      = "http://1.2.3.4:8080,http://user:pass@5.6.7.8:3128"   # comma/newline list
PROXY_POOL_URL  = "https://your-list-endpoint/proxies.txt"             # newline host:port list
# (PROXY_POOL_FILE = /path/to/list also supported)

# Route accounts through the pool:
PROXY_POOL_MODE = "1"          # all accounts use the pool
#   …or per-account:  PROXY_FOR_PERSONL = "pool"

# Optional:
PROXY_POOL_ALLOW_HOSTING = "0" # 1 = accept datacenter IPs too (will get blocked)
PROXY_POOL_REFRESH_MS    = "600000"   # re-health-check every 10 min
```

## Operate
```bash
ALLOC=$(nomad job allocs -json linkedin-console | jq -r '.[0].ID')
# See the healthy set + scores:
nomad alloc exec -task worker "$ALLOC" sh -c 'curl -s -H "x-api-key: $API_SECRET" http://127.0.0.1:3001/proxy-pool'
# Force an immediate re-check:
nomad alloc exec -task worker "$ALLOC" sh -c 'curl -s -X POST -H "x-api-key: $API_SECRET" http://127.0.0.1:3001/proxy-pool/refresh'
```

## How it behaves
- **Sticky:** an account keeps the same healthy proxy for `PROXY_POOL_ASSIGN_TTL_S`
  (30 min) — IP-flipping mid-session is itself a ban signal.
- **Rotates on failure:** a proxy that errors gets cooled down (`PROXY_POOL_COOLDOWN_S`)
  and the account is reassigned.
- **Self-heals:** the refresher re-checks candidates every 10 min; dead ones drop out.
- **Auth-aware:** `http://user:pass@host:port` credentials are split into
  Playwright's username/password fields (Chromium ignores embedded creds).
  Authenticated SOCKS5 is NOT supported by Chromium — use http(s) or
  IP-whitelisted SOCKS5.

## Honest expectation with FREE proxies
You will likely see `healthy: 0` or a tiny number that churns constantly, and
accounts will still get blocked, because free LinkedIn-usable proxies are rare
and short-lived. This is the reality the gate surfaces. The system is correct;
the source is the limitation. When you can, switch `PROXY_POOL` to a paid
residential gateway (one URL, thousands of rotating residential IPs) and the
same pool logic gives you a reliable, healthy set.
