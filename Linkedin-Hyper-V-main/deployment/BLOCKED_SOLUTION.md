# The "connections blocked / reconnect required" — full solution

This consolidates every fix for the recurring block, separating **what code can
do** from **the one thing only a proxy can do**.

## Root cause (one sentence)
The worker egresses from the DigitalOcean datacenter IP `167.71.211.25`, which
LinkedIn has on its bot blocklist — so the connections HTML page redirect-loops
(`ERR_TOO_MANY_REDIRECTS`) and the account shows "Reconnect required".

## What we fixed in CODE (shipped)
1. **Connections via Voyager API, not the DOM page.** `syncConnections` now calls
   the JSON API (`reads.readConnections` → `voyagerProvider.readConnections`)
   instead of `page.goto(/mynetwork/connections/)`. The API returns clean
   `401/999` instead of an infinite redirect cascade — no more redirect-burning,
   and on a *good* IP it just works. Flag: `USE_VOYAGER_READS=1`. Scraper stays
   as fallback (but NOT when the API says BLOCKED — we don't re-trigger the loop).
2. **Blocked accounts stop hammering.** Live thread fallback is skipped when
   posture is blocked; backoff lifted to 48h; circuit breaker pauses surfaces.
3. **Clear-block endpoint** to reset a stuck cooldown once the IP is fixed.
4. **proxyCheck tool** to objectively verify a proxy before trusting it.

## What ONLY a proxy can do (the remaining 5%)
None of the above makes a datacenter IP residential. Even via the Voyager API,
LinkedIn can return `999/401` for a flagged IP. The block clears for good only
when the account egresses from a residential/mobile IP.

## The exact recovery procedure
```bash
ALLOC=$(nomad job allocs -json linkedin-console | jq -r '.[0].ID')

# 1. Confirm the problem (expect hosting? YES, RESULT: PROBLEM):
nomad alloc exec -task worker "$ALLOC" node src/tools/proxyCheck.js --direct

# 2. Get a residential/mobile proxy. Verify it (expect hosting? no, PASS):
nomad alloc exec -task worker "$ALLOC" node src/tools/proxyCheck.js --proxy="socks5://user:pass@host:1080"

# 3. Wire it into the Nomad worker env, redeploy:
#      PROXY_FOR_PERSONL  = "socks5://user:pass@host:1080"
#      ANTIBAN_TZ_PERSONL = "America/New_York"
#      USE_VOYAGER_READS  = "1"

# 4. Clear the stuck block:
nomad alloc exec -task worker "$ALLOC" \
  sh -c 'curl -s -X POST -H "x-api-key: $API_SECRET" http://127.0.0.1:3001/accounts/personl/clear-block'

# 5. Reconnect via noVNC FROM that residential egress, do 3-5 light actions, wait 24h, ramp slowly.
```

## If you have NO proxy and just want it to stop erroring (testing phase)
- Set `USE_VOYAGER_READS=1` — connections stop redirect-looping (clean error instead).
- Leave `personl` on its 48h cooldown; it will self-pause instead of spamming.
- The dashboard will still say "blocked" — that is *correct*; it reflects reality.
  It cannot say "healthy" until the IP is fixed. There is no code that makes
  LinkedIn unblock a datacenter IP.
