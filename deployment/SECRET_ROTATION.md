# Secret rotation runbook — AC-Worker-06 (167.71.211.25)

**Why:** every credential for this host was exposed in cleartext (pasted into a
chat transcript): Postgres password, Redis password, `SESSION_ENCRYPTION_KEY`,
`API_SECRET`, `API_ROUTE_AUTH_TOKEN`, `JWT_SECRET`, `PROXY_AUTH_TOKENS`,
`DASHBOARD_PASSWORD`, and the **Harbor admin password**. Treat all as compromised
and rotate.

> **Do NOT commit real secret values to git.** This file contains procedure only.
> Generate values on a secure machine and load them into Nomad variables (below).

---

## 0. Generate fresh values (on a secure machine, not in chat)

```bash
gen_hex() { openssl rand -hex "$1"; }
gen_b64() { openssl rand -base64 "$1" | tr -d '\n' | tr '+/' '-_' | tr -d '='; }

REDIS_PASSWORD=$(gen_hex 20)
DB_PASSWORD=$(gen_b64 24)
SESSION_ENCRYPTION_KEY=$(gen_hex 32)   # 64 hex chars = 32 bytes (required length)
API_SECRET=$(gen_hex 32)
API_ROUTE_AUTH_TOKEN=$(gen_hex 32)
JWT_SECRET=$(gen_hex 32)
PROXY_AUTH_TOKEN=$(gen_hex 32)
DASHBOARD_PASSWORD=$(gen_b64 18)
HARBOR_ADMIN_PASSWORD=$(gen_b64 18)
```

---

## 1. Classify the secrets

| Secret | Type | Rotating it requires | Side effect |
|---|---|---|---|
| `JWT_SECRET` | app-only | redeploy frontend | dashboard users logged out |
| `API_SECRET` | app-only | redeploy worker+frontend | brief in-flight API calls fail |
| `API_ROUTE_AUTH_TOKEN` | app-only | redeploy frontend | none |
| `PROXY_AUTH_TOKENS` | app-only | redeploy frontend | proxy-auth cookies invalidated |
| `DASHBOARD_PASSWORD` | app-only | redeploy frontend | must log in with new pw |
| `SESSION_ENCRYPTION_KEY` | app-only | redeploy worker | **all stored LinkedIn cookies unreadable → every account must reconnect** |
| `DB_PASSWORD` | infra | `ALTER ROLE` on Postgres + redeploy | coordinated; app down between steps |
| `REDIS_PASSWORD` | infra | Redis `CONFIG SET` + redeploy | coordinated; queue/cache reset |
| Harbor admin pw | infra | Harbor UI/API | update Nomad `auth{}` blocks |

**Note on `SESSION_ENCRYPTION_KEY`:** rotating it invalidates every stored
session. Given `personl` is already blocked and `test` has no session, now is
actually a clean moment to rotate it — you'll re-onboard both accounts anyway
(ideally behind a residential proxy this time).

---

## 2. Store secrets in Nomad variables (stop hardcoding)

```bash
nomad var put nomad/jobs/linkedin-console \
  redis_password="$REDIS_PASSWORD" \
  db_password="$DB_PASSWORD" \
  session_encryption_key="$SESSION_ENCRYPTION_KEY" \
  api_secret="$API_SECRET" \
  api_route_auth_token="$API_ROUTE_AUTH_TOKEN" \
  jwt_secret="$JWT_SECRET" \
  proxy_auth_token="$PROXY_AUTH_TOKEN" \
  dashboard_password="$DASHBOARD_PASSWORD"
```

The job file `linkedin-console.secure.nomad.hcl` renders these via `template`
stanzas instead of hardcoding — see that file. No secret ever lands in git.

---

## 3. Ordered rotation (minimizes downtime)

### 3a. Harbor admin password (do first — it gates image pulls)

1. Log into Harbor UI → admin → Change Password → set `HARBOR_ADMIN_PASSWORD`.
2. Update the `auth {}` blocks (or the Nomad var) used by both tasks.
3. `docker login h4rb0r.acm.acumen-strategy.com -u admin` with the new pw to confirm.

### 3b. App-only secrets (low risk, do together)

1. `nomad var put …` the new values (step 2).
2. `nomad job run linkedin-console.secure.nomad.hcl`.
3. Dashboard users re-login with new `DASHBOARD_PASSWORD`.

### 3c. Postgres password (coordinated)

```bash
# On the Postgres master
psql -U postgres -c "ALTER ROLE linkedinuser WITH PASSWORD '<DB_PASSWORD>';"
# Then update the Nomad var and redeploy
nomad var put nomad/jobs/linkedin-console db_password="$DB_PASSWORD"
nomad job run linkedin-console.secure.nomad.hcl
```

App connections fail for the few seconds between ALTER and redeploy — acceptable,
or drain the job first if you want zero errored requests.

### 3d. Redis password (coordinated)

```bash
# On the Redis host (or via config management — persist to redis.conf too!)
redis-cli -a '<OLD_REDIS_PASSWORD>' CONFIG SET requirepass '<REDIS_PASSWORD>'
redis-cli -a '<REDIS_PASSWORD>' CONFIG REWRITE   # persist so it survives restart
# Update Nomad var + redeploy
nomad var put nomad/jobs/linkedin-console redis_password="$REDIS_PASSWORD"
nomad job run linkedin-console.secure.nomad.hcl
```

> If Redis is the shared `proxy.redis-production.service.consul` instance used by
> other services, **do not** rotate it unilaterally — coordinate with whoever
> owns that cluster, or move LinkedIn to its own Redis DB index / instance first.
> The current URL already uses DB index `/1`, but the password is shared.

---

## 4. Post-rotation verification

```bash
nomad job status linkedin-console
nomad alloc logs -task worker  <alloc>  | grep -i "Prisma\|Redis\|initialized"
nomad alloc logs -task frontend <alloc> | grep -i "ready\|listening"
# Confirm dashboard login with new password, confirm noVNC loads with no prompt.
```

---

## 5. Going forward

- Never paste secrets into chat, tickets, or commit messages.
- Keep all secrets in Nomad variables or Vault; the job templates render them at
  runtime.
- Rotate on a schedule (quarterly) and on any suspected exposure.
- Consider Vault dynamic DB credentials so the Postgres password is short-lived
  and never static.
