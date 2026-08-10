# Auth capture + auto-relogin — master plan

**Idea:** users already type their LinkedIn email + password into the noVNC
browser during the connect flow. We can observe the login form submission,
encrypt and store the credentials, and use them later to **re-authenticate
programmatically** when cookies expire — eliminating most "Reconnect required"
manual interventions.

**Status:** plan + opt-in skeleton shipped. Default OFF — must be explicitly
enabled per environment via `ENABLE_CRED_CAPTURE=1`.

---

## 1. Why this matters

Today's pain (from the `personl` incident):

```
LinkedIn cookies expire (every ~30d) or LinkedIn invalidates a session
   ↓
posture → 'expired'  →  UI shows "Reconnect required"
   ↓
ops manually opens noVNC → user types email+password → cookies captured
   ↓
done — until the next expiry, when this whole cycle repeats
```

Multiply that by N accounts × M cookie rotations and it's a permanent ops cost.
**Worse**, because the noVNC browser egresses from the datacenter IP, every
manual reconnect risks re-triggering the same IP ban.

**With auto-relogin:**

```
posture → 'expired'
   ↓
AutoLoginService finds stored credentials for this account
   ↓
runs headless login flow via the worker browser (same proxy, same fingerprint)
   ↓
cookies refreshed automatically  →  posture cleared  →  syncing resumes
```

Manual reconnect only required when:
- LinkedIn shows a real checkpoint (CAPTCHA, "verify it's you", new-device)
- 2FA challenge (if no TOTP secret stored)
- Password changed elsewhere and ours is stale

---

## 2. The security / trust commitment

This is **the biggest trust step in the system**. Cookies were already
sensitive; storing passwords is *more* sensitive. The plan only works if we
treat that seriously.

### Non-negotiable rules

| Rule | Implementation |
|---|---|
| Never log a password, ever | Logger redaction list includes `session_password`, `password`, and the captured value before any log line is emitted |
| Encrypted at rest | AES-256-GCM via `SESSION_ENCRYPTION_KEY` (same mechanism as cookies); decrypts only at use-time, never sits in memory longer than the login attempt |
| Never travel cleartext | TLS to LinkedIn (their HTTPS), TLS to webhook consumers — and the credential is *never* in any webhook payload, log, or API response we expose |
| Never returned via API | `GET /accounts/:id/credentials` does NOT exist. We expose `hasStoredCredentials: true/false`, nothing more |
| Per-account opt-in | The user must explicitly consent during connect. Default OFF, no surprise capture |
| Easy to revoke | `DELETE /accounts/:id/credentials` wipes them everywhere; auto-wipe on account deletion |
| Rotate-aware | If a programmatic login returns "wrong password" we mark `needs_password_update`, surface in UI, and stop trying |
| Memory hygiene | After use, overwrite the buffer; do not leave the plaintext on `process.env`, in JS strings retained by closures, or in stack traces |

### Threat model (what we are and aren't defending against)

| Threat | Defended? |
|---|---|
| Disk theft of the Redis/Postgres data → can't read credentials without `SESSION_ENCRYPTION_KEY` | Yes |
| Disk theft + the env file with the encryption key | No — same as cookies today. Mitigate by storing the key in Vault/Nomad variables, not on disk |
| Malicious internal user with API access | Partially — they can call admin endpoints but can't read credentials back; they CAN trigger autoLogin (so audit logs) |
| Malicious operator with shell on the worker host | No — they can patch the code to leak. Same risk as any system with stored credentials |
| Compromised SESSION_ENCRYPTION_KEY → all credentials AND all cookies decrypt | Yes — rotate the key on suspected leak; clears everything |

This is no worse than how `1Password`, `LastPass`, or your browser stores
passwords. It's no *better* either — make peace with that and document it for
users.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  noVNC connect flow (per account)                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  page = await context.newPage()                          │   │
│  │  await credentialCapture.attach(page, accountId)  ◄── NEW │   │
│  │  await page.goto(LOGIN_URL)                              │   │
│  │  …user types email + password…                           │   │
│  │  page POSTs /checkpoint/lg/login-submit                  │   │
│  │     ↓                                                     │   │
│  │   request listener reads session_key + session_password  │   │
│  │     ↓                                                     │   │
│  │   credentialStore.save(accountId, {email, password})     │   │
│  │     ↓ encrypted with SESSION_ENCRYPTION_KEY               │   │
│  │     ↓ stored at credentials:{accountId} in Redis          │   │
│  │   redacted from logs                                      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│             Later — sync detects posture = 'expired'             │
│                                                                  │
│  syncPosture.classifySyncFailure → posture 'expired'             │
│      ↓                                                            │
│  if (autoLogin.canAttempt(accountId)) {                          │
│     await autoLogin.run(accountId)                               │
│     // navigate to login, fill fields, submit, save cookies      │
│     if (success) → posture cleared, sync resumes                 │
│     if (checkpoint) → leave for human, mark `needs_human`        │
│     if (wrong pw)   → mark `needs_password_update`, alert        │
│  }                                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Components

| Module | Responsibility |
|---|---|
| `worker/src/auth/credentialCapture.js` | Playwright `page.on('request')` interceptor; extracts `session_key`/`session_password` from the login form POST and hands to the store. |
| `worker/src/auth/credentialStore.js` | Encrypt with SESSION_ENCRYPTION_KEY, save/load/delete in Redis at `credentials:{accountId}`. Mirrors the cookie store API. |
| `worker/src/auth/autoLogin.js` | Programmatic login: refuse if no proxy, refuse if recently blocked, navigate, fill via humanBehavior, submit, classify outcome. |
| `worker/src/actions/connectSession.js` | Calls `credentialCapture.attach(page, accountId)` if `ENABLE_CRED_CAPTURE=1` and the account has consented. |
| `worker/src/unified/SyncOrchestrator.js` | On posture `expired`, optionally invoke `autoLogin.run()` before giving up. |

---

## 4. Why programmatic login is the HARDEST endpoint on LinkedIn

This is important and counterintuitive: the steady-state Voyager API + realtime
stream are *easier* to use without detection than the **login form** itself.
LinkedIn invests the most anti-bot effort exactly at login because that's where
account takeover happens.

What that means in practice:

- **Auto-login from a fresh / datacenter IP → near-100% captcha or "verify it's you" challenge.** Must run from the same sticky residential/mobile IP as the original login. If the IP differs, treat it as a guaranteed failure and skip.
- **Auto-login during business hours of the account's local timezone.** A US-East account logging in at 3am Indian time looks robotic — even a human wouldn't do that.
- **Bounded frequency.** A second auto-relogin within 24h of a successful one is itself a signal. Hard cap: max 1 auto-relogin per account per 24h, max 3 per 7 days.
- **Refuse on any recent "blocked" or "automation_warning" posture.** The account is already on thin ice — logging in again will burn it.

If any of these guardrails fail, fall back to the human noVNC flow.

---

## 5. 2FA / MFA strategy

If the account has 2FA enabled, programmatic login fails at the OTP step. Three
options, in order of cost/benefit:

1. **No 2FA support (v1).** Detect 2FA prompt → mark `needs_human`, surface in UI. Most accounts don't have 2FA enabled; this covers ~70% of cases.
2. **TOTP secret capture (v2).** When the user enables 2FA in their LinkedIn settings, they get a TOTP secret (QR code). If we offer a one-time "enroll 2FA with us" step that captures that secret, we can compute the code with `otplib`. Stored alongside the password, same encryption.
3. **Push-to-phone (v3).** Use SMS APIs or a tiny user-installed agent to forward OTP. Operationally messy.

v1 only; v2 as a follow-up if it becomes the biggest blocker.

---

## 6. Detection guardrails (built into AutoLoginService)

`autoLogin.run(accountId)` walks this gate before doing anything:

```
1. Are credentials stored for this account?              no → bail
2. Is a per-account residential/mobile proxy configured? no → bail
3. Is the egress IP the SAME as the last successful login?
   (compare via api.ipify through the same context)      no → bail
4. Has there been a hard block in the last 7 days?       yes → bail
5. Is it within business hours for the account's TZ?     no → bail (queue for later)
6. Has an auto-relogin run in the last 24h?              yes → bail
7. Has an auto-relogin succeeded ≥3 times in the last 7d? yes → bail (something's off, escalate)
```

Bailing isn't failure — it's "fall back to human reconnect via noVNC." Better to
ask a human once than burn an account.

---

## 7. UX flow

### During noVNC connect (capture)
1. Banner above the noVNC pane: *"Save credentials for automatic re-login? Stored encrypted, used only by you. \[ Enable ]"*
2. User clicks Enable → frontend POSTs `/accounts/:id/credentials/consent`.
3. Worker enables capture for that connect session.
4. When the user submits the login form, credentials are captured silently.
5. Confirmation banner: *"Credentials saved encrypted. Auto-relogin enabled."*

### Status indicators (Account list)
- 🔒 **Credentials saved** — auto-relogin enabled, last used 3d ago.
- ⚠️ **Password may have changed** — last auto-relogin returned wrong-password.
- 🚫 **Manual reconnect required** — checkpoint/2FA blocked auto-relogin.

### Revocation
- One-click "Forget credentials" on the account row. Calls `DELETE /accounts/:id/credentials`.

---

## 8. Implementation phases

| Phase | Effort | Notes |
|---|---|---|
| A — capture + encrypted store (no autoLogin yet) | 1 day | Safe to ship: captures and stores, never uses |
| B — `autoLogin.run()` with all the gates above | 3 days | Skeleton ready; needs live testing under residential proxy |
| C — wire into syncPosture flow (posture=expired triggers autoLogin) | 1 day | Behind `ENABLE_AUTO_RELOGIN=1` |
| D — UI consent + status indicators in the dashboard | 2 days | Surfaces hasStoredCredentials, last-used, errors |
| E — 2FA TOTP capture (v2) | 2–3 days | Optional |

This master plan ships Phases A + B skeleton + the integration points. C (orchestrator wiring) is one well-placed call, gated by the env flag, no surprises. D is frontend work. E is future.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Captured creds leaked via logs | Centralized redaction list; lint rule blocks logging captured fields |
| Encryption key rotated → all creds unreadable | Key versioning; reconnect prompts users to re-enter; do not silently delete |
| LinkedIn changes login form (`session_key`/`session_password` rename) | Capture is opportunistic; if the field is missing, we just don't store — no breakage |
| Programmatic login triggers checkpoint cascade | All the §6 guardrails; conservative defaults |
| Wrong-password loops triggering account lockouts | Stop after 1 failure; mark `needs_password_update` and never retry until user re-enters |
| User assumes "saved" means "stored forever" | TTL the stored creds (90d default); prompt to re-confirm before expiry |
| ToS / legal | This is "automation on behalf of an account that consented" — same legal posture as the rest of the system, just explicit. Get sign-off |

---

## 10. ToS reality check (again)

LinkedIn's User Agreement prohibits credentials being shared with third parties.
If we operate the account on behalf of the *real user* (their account, their
consent, their data), this is functionally equivalent to a password manager
auto-filling their login. It is **not** equivalent to scraping someone else's
data with stolen credentials. The line is consent.

Concrete requirements before enabling in production:
- Explicit, time-stamped consent record per account.
- Privacy policy + ToS update disclosing credential storage.
- Encryption + access-control audit.
- Legal sign-off.

This document is the technical "how." The "should we" is a business call.

---

## 11. First-week tactical plan

1. Ship the capture + store modules **with capture default OFF** and no
   `autoLogin.run()` call sites. We can run it in shadow mode (capture, store,
   never use) to validate the encryption + persistence end-to-end.
2. Validate the encrypted blob round-trips (`save → load → use to fill form`)
   on a staging account in a private branch.
3. Wire the per-account proxy first (the §6 IP guardrail is mandatory).
4. Enable `ENABLE_AUTO_RELOGIN=1` for **one** account, monitor for 7 days, look
   at the checkpoint rate and login success rate.
5. If clean, roll out to other accounts with the same proxy class.

If checkpoint rate is high → the IP is suspect, not the code. Don't keep
retrying; fix the egress.
