# Unipile parity — exact data, exact method, exact API shape

This documents how the app now fetches **the same things Unipile fetches, by the
same method**, and exposes a **Unipile-shaped REST API** so it can drop in as a
replacement. Sources: Unipile's own docs (linkedin-api guide, real-time webhooks,
node SDK).

---

## 1. The method (how Unipile and now we fetch)

Unipile does **not** scrape the rendered DOM. It drives LinkedIn's internal
**Voyager API** (`https://www.linkedin.com/voyager/api/...`, REST + GraphQL) using
the member's own authenticated session, plus the **realtime stream**
(`/realtime/connect`) for push, and runs each account behind **built-in
proxy + quota management** ("we handle LinkedIn's restrictions for you").

We now do exactly this:
- `worker/src/voyager/VoyagerClient.js` — authenticated Voyager REST + GraphQL,
  driven through the account's browser context (cookies/proxy/TLS match the real
  client). 429/Retry-After handling, GraphQL queryId cache + 4xx re-harvest.
- `worker/src/voyager/RealtimeConnector.js` — holds `/realtime/connect` open,
  emits message/read/typing/invitation events.
- `worker/src/events/*` — event bus + signed webhooks + persistence consumer.
- `worker/src/antiBan.js` + `PROXY_FOR_<id>` — the proxy/quota layer (you supply
  the residential IPs; Unipile bundles them — see §4).

---

## 2. Exact Voyager endpoints (what we call)

| Capability | Voyager endpoint (method) | Client method |
|---|---|---|
| Own identity | `GET /voyager/api/me` | `getMe()` |
| Own profile | `GET /identity/dash/profiles?q=memberIdentity&memberIdentity=me` | `getOwnProfile()` |
| Conversations | `GET /messaging/conversations?keyVersion=LEGACY_INBOX` | `getConversations()` |
| Thread messages | `GET /messaging/conversations/{id}/events` | `getConversationEvents()` |
| Send message | `POST /messaging/conversations/{id}/events?action=create` | `sendMessage()` |
| New conversation | `POST /messaging/conversations?action=create` | `createConversation()` |
| React to message | `POST /messaging/conversations/{id}/events/{urn}?action=reactWithEmoji` | `reactToMessage()` |
| Mark read | `POST /messaging/conversations/{id}?action=markRead` | `markConversationRead()` |
| Profile (vanity) | `GET /identity/profiles/{publicId}/profileView` | `getProfile()` |
| People search | `GET /graphql?queryId=<searchClusters>&variables=...` | `searchPeople()` |
| Received invitations | `GET /relationships/invitationViews?q=receivedInvitation` | `getInvitations()` |
| Connections | `GET /relationships/dash/connections?q=search&sortType=RECENTLY_ADDED` | `getConnections()` |
| Send invitation | `POST /growth/normInvitations` | `sendInvitation()` |
| Accept invitation | `POST /relationships/invitations/{id}?action=accept` | `acceptInvitation()` |
| Notifications | `GET /voyagerIdentityDashNotificationCards` | `getNotifications()` |
| Profile posts | `GET /identity/profileUpdatesV2?q=memberShareFeed` | `getProfilePosts()` |

Auth on every call: `li_at` cookie + `csrf-token` header (= `JSESSIONID` value),
`x-restli-protocol-version: 2.0.0`, `x-li-track` device descriptor, real UA.

> GraphQL queryIds (search, some feed surfaces) rotate per LinkedIn release. The
> harvester (`harvest.js`) captures the live ids into `queryIdCache`; a 4xx
> "unknown query" auto-invalidates and re-harvests. **People search needs one
> probe/harvest run before it works** — that's expected, not a bug.

---

## 3. The API shape (how YOU/consumers call us) — Unipile-shaped

Mounted at `/api/v1`, x-api-key auth. Maps 1:1 onto Unipile's mental model so
downstream integrations (n8n, CRM, your app) don't change if you swap backends.

| Our endpoint | Unipile analogue |
|---|---|
| `GET /api/v1/accounts` | list connected accounts |
| `GET /api/v1/accounts/:id` | account detail |
| `GET /api/v1/accounts/:id/chats` | list chats |
| `GET /api/v1/accounts/:id/chats/:chatId/messages` | list messages |
| `POST /api/v1/accounts/:id/chats/:chatId/messages` `{text}` | send message |
| `POST /api/v1/accounts/:id/chats` `{recipient_urn,text}` | start chat |
| `GET /api/v1/accounts/:id/users/:identifier` | get profile |
| `GET /api/v1/accounts/:id/search?keywords=` | people search |
| `GET /api/v1/accounts/:id/relations` | connections |
| `GET /api/v1/accounts/:id/invitations` | received invites |
| `POST /api/v1/accounts/:id/invitations` `{profile_urn,message?}` | send invite |
| `POST /api/v1/accounts/:id/invitations/:invitationId/accept` | accept invite |

Plus the realtime/webhook side (already built): subscribe a `WEBHOOK_ENDPOINTS`
URL and receive signed `message.received` / `invitation.received` events with
HMAC `X-LI-Signature` — Unipile's webhook contract.

Writes are gated through the same `rateLimit` human-pace caps; errors map to
Unipile-ish statuses (423 blocked, 429 rate-limited, 401 no session).

---

## 4. The ONE thing Unipile gives that we still don't: the managed IP layer

Per Unipile's docs, their differentiator is **"built-in proxy & quota
management… we handle LinkedIn's restrictions for you."** That is the layer that
keeps accounts alive at scale — a pool of residential/ISP IPs, country-matched
per account, with reputation management, all absorbed by them.

We have the *hooks* for it (`PROXY_FOR_<id>`, per-account fingerprint,
business-hours + circuit-breaker pacing) but **you supply the IPs**. On the bare
datacenter IP `167.71.211.25` the account is blocked on sight — which is exactly
what the dashboard shows today.

**To match Unipile operationally you must provide one residential/mobile sticky
IP per account.** Everything else — the fetch method, the endpoints, the API
shape, the realtime/webhooks — is now in place. Options + costs:
`ANTI_BAN_FREE_TIER.md`. Validation: `node src/voyager/probe.js <id> 30`.

---

## 5. Honest parity scorecard

| Dimension | Unipile | This app |
|---|---|---|
| Fetch method (Voyager API) | ✅ | ✅ (built; validate per §2 note) |
| Realtime push + webhooks | ✅ | ✅ (built, flag-gated) |
| REST API surface | ✅ | ✅ (`/api/v1`, this change) |
| Messaging/invites/search/profiles | ✅ | ✅ (endpoints in §2) |
| Hosted white-label auth | ✅ | ⚠️ noVNC connect (functional, not white-label) |
| **Managed proxy / IP reputation** | ✅ | ❌ you supply (`PROXY_FOR_<id>`) |
| Multi-tenant SaaS, billing, SLA | ✅ | ❌ single-tenant tool |
| Maintenance treadmill absorbed | ✅ | ❌ you own it |

**Verdict:** as a *self-hosted Unipile-equivalent for your own accounts*, the
code is now there end-to-end. The gap to a true drop-in replacement is
**operational** (proxies + the maintenance treadmill), not feature coverage.
