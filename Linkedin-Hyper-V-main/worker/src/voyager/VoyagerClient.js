'use strict';

// Production Voyager (LinkedIn internal JSON API) client — the engine that lets
// this app fetch the EXACT same data, by the EXACT same method, as Unipile:
// LinkedIn's own /voyager/api REST + GraphQL endpoints, driven through the
// account's authenticated browser context so cookies, proxy, and TLS
// fingerprint match the real web client.
//
// Everything here issues the same calls the linkedin.com SPA makes for data the
// authenticated user already has access to. Rate-limited by the caller
// (voyagerProvider / antiBan). GraphQL queryIds are version-pinned and harvested
// live (queryIdCache) so the client self-heals across LinkedIn web releases.

const crypto = require('crypto');
const { getAuthedContext, voyagerHeaders } = require('./session');
let queryIdCache = null;
try { queryIdCache = require('./queryIdCache'); } catch { /* optional */ }

const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';
const GRAPHQL_PATH = '/graphql';

// Fallback GraphQL queryIds. LinkedIn rotates these every few web releases, so
// they are intentionally placeholders — the harvester (harvest.js) captures the
// LIVE queryIds from real traffic into queryIdCache, which overrides these, and
// a 4xx "unknown query" triggers a re-harvest. Treat a null/placeholder lookup
// as "must harvest first", never as a working id.
const DEFAULT_QUERY_IDS = {
  searchClusters: null,
  profilePosts: null,
};

function cryptoRandomTrackingId() {
  return crypto.randomBytes(16).toString('base64');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class VoyagerError extends Error {
  constructor(message, { status, code, surface, retryAfter } = {}) {
    super(message);
    this.name = 'VoyagerError';
    this.status = status;
    this.code = code || (status === 401 || status === 403 || status === 999 ? 'BLOCKED'
      : status === 429 ? 'RATE_LIMITED'
      : 'VOYAGER_ERROR');
    this.surface = surface;
    this.retryAfter = retryAfter || null;
  }
}

class VoyagerClient {
  constructor(accountId, options = {}) {
    this.accountId = accountId;
    this.options = options;
    this._ctx = null;
    this._maxRetries = options.maxRetries ?? 2;
  }

  // Resolve (and cache) the account's fingerprint timezone so the Voyager REST
  // header matches the in-page Playwright timezone. Falls back to New York.
  _timezoneId() {
    if (this._tz === undefined) {
      try {
        const { fingerprintForAccount } = require('../antiBan');
        this._tz = fingerprintForAccount(this.accountId).timezoneId || 'America/New_York';
      } catch {
        this._tz = 'America/New_York';
      }
    }
    return this._tz;
  }

  async _ctxReady() {
    if (!this._ctx) {
      this._ctx = await getAuthedContext(this.accountId, this.options);
      if (!this._ctx.hasSession) {
        throw new VoyagerError(`No LinkedIn session for ${this.accountId}`, { status: 401, code: 'NO_SESSION' });
      }
    }
    return this._ctx;
  }

  async _request(method, path, { headers = {}, surface = 'voyager', body } = {}) {
    const { context, csrfToken } = await this._ctxReady();
    const url = path.startsWith('http') ? path : `${VOYAGER_BASE}${path}`;
    const reqHeaders = voyagerHeaders(csrfToken,
      method === 'POST' ? { 'content-type': 'application/json; charset=UTF-8', ...headers } : headers,
      { timezone: this._timezoneId() });

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await context.request.fetch(url, {
        method,
        headers: reqHeaders,
        timeout: 30000,
        failOnStatusCode: false,
        ...(body != null ? { data: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      });
      const status = res.status();

      // 429 — respect Retry-After, bounded retries, then surface as RATE_LIMITED.
      if (status === 429 && attempt < this._maxRetries) {
        const ra = parseInt(res.headers()['retry-after'] || '0', 10);
        const waitMs = (Number.isFinite(ra) && ra > 0 ? ra : 5 * (attempt + 1)) * 1000;
        await sleep(Math.min(waitMs, 30000));
        attempt += 1;
        continue;
      }
      return this._handle(res, surface, url);
    }
  }

  get(path, opts = {}) { return this._request('GET', path, opts); }
  post(path, body, opts = {}) { return this._request('POST', path, { ...opts, body }); }

  async _handle(res, surface, url) {
    const status = res.status();
    if (status === 401 || status === 403 || status === 999) {
      throw new VoyagerError(`Voyager auth/block ${status} on ${surface}`, { status, code: 'BLOCKED', surface });
    }
    if (status === 429) {
      const ra = parseInt(res.headers()['retry-after'] || '0', 10);
      throw new VoyagerError(`Voyager rate-limited on ${surface}`, { status, code: 'RATE_LIMITED', surface, retryAfter: ra || null });
    }
    if (status >= 400) {
      const text = await res.text().catch(() => '');
      // A 4xx "unknown query" on GraphQL means the queryId drifted → invalidate cache.
      if (queryIdCache && surface.startsWith('gql:') && /unknown|queryId/i.test(text)) {
        await queryIdCache.invalidate(surface.slice(4)).catch(() => null);
      }
      throw new VoyagerError(`Voyager ${status} on ${surface}: ${text.slice(0, 200)}`, { status, surface });
    }
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return {};
    return res.json().catch(() => ({}));
  }

  async _queryId(surface) {
    if (queryIdCache) {
      const cached = await queryIdCache.get(surface).catch(() => null);
      if (cached) return cached;
    }
    return DEFAULT_QUERY_IDS[surface] || null;
  }

  // ── Account / identity ─────────────────────────────────────────────────

  /** The authenticated member's own identity (mirrors Unipile GET /accounts/:id). */
  async getMe() {
    return this.get('/me', { surface: 'me' });
  }

  /** Own profile detail. */
  async getOwnProfile() {
    return this.get('/identity/dash/profiles?q=memberIdentity&memberIdentity=me&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101', { surface: 'own_profile' });
  }

  // ── Messaging ──────────────────────────────────────────────────────────

  async getConversations({ count = 20, createdBefore = null } = {}) {
    // The legacy inbox paginates by createdBefore (epoch ms of the oldest item
    // seen so far). Omit it for the first page; pass it to walk backwards.
    let path = `/messaging/conversations?keyVersion=LEGACY_INBOX&count=${count}`;
    if (createdBefore) path += `&createdBefore=${encodeURIComponent(createdBefore)}`;
    return this.get(path, { surface: 'inbox' });
  }

  async getConversationEvents(threadId, { count = 50, createdBefore = null } = {}) {
    const enc = encodeURIComponent(threadId);
    let path = `/messaging/conversations/${enc}/events?count=${count}`;
    if (createdBefore) path += `&createdBefore=${encodeURIComponent(createdBefore)}`;
    return this.get(path, { surface: 'thread' });
  }

  /** Send a message into an existing thread (Unipile POST /chats/:id/messages). */
  async sendMessage(threadId, text, { mailboxUrn } = {}) {
    const enc = encodeURIComponent(threadId);
    const body = {
      message: { body: text, attachments: [], attributedBody: { text, attributes: [] } },
      dedupeByClientGeneratedToken: false,
    };
    if (mailboxUrn) body.mailboxUrn = mailboxUrn;
    return this.post(`/messaging/conversations/${enc}/events?action=create`, body, { surface: 'send_message' });
  }

  /** Start a NEW conversation with a recipient profile urn (first-touch DM). */
  async createConversation(recipientProfileUrn, text, { mailboxUrn } = {}) {
    const body = {
      keyVersion: 'LEGACY_INBOX',
      conversationCreate: {
        eventCreate: { value: { 'com.linkedin.voyager.messaging.create.MessageCreate': {
          body: text, attachments: [], attributedBody: { text, attributes: [] },
        } } },
        recipients: [recipientProfileUrn],
        subtype: 'MEMBER_TO_MEMBER',
      },
    };
    if (mailboxUrn) body.mailboxUrn = mailboxUrn;
    return this.post('/messaging/conversations?action=create', body, { surface: 'create_conversation' });
  }

  /** React to a message with an emoji. */
  async reactToMessage(threadId, messageUrn, emoji = '👍') {
    const enc = encodeURIComponent(threadId);
    const ev = encodeURIComponent(messageUrn);
    return this.post(
      `/messaging/conversations/${enc}/events/${ev}?action=reactWithEmoji`,
      { emoji },
      { surface: 'react' }
    );
  }

  /** Mark a conversation read. */
  async markConversationRead(threadId) {
    const enc = encodeURIComponent(threadId);
    return this.post(`/messaging/conversations/${enc}?action=markRead`, { read: true }, { surface: 'mark_read' });
  }

  // ── People / profiles ────────────────────────────────────────────────────

  /** Profile by public identifier (vanity) — Unipile GET /users/:identifier. */
  async getProfile(publicId) {
    const enc = encodeURIComponent(publicId);
    return this.get(`/identity/profiles/${enc}/profileView`, { surface: 'profile' });
  }

  /** People search (GraphQL). keywords + optional network/title filters. */
  async searchPeople({ keywords, start = 0, count = 10 } = {}) {
    const queryId = await this._queryId('searchClusters');
    if (!queryId) throw new VoyagerError('No searchClusters queryId (run harvester)', { status: 424, code: 'NO_QUERY_ID', surface: 'search' });
    const variables = `(start:${start},count:${count},query:(keywords:${encodeURIComponent(keywords)},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE)))))`;
    return this.get(`${GRAPHQL_PATH}?variables=${variables}&queryId=${queryId}`, { surface: 'gql:searchClusters' });
  }

  // ── Network / invitations ────────────────────────────────────────────────

  async getInvitations({ count = 50 } = {}) {
    return this.get(`/relationships/invitationViews?count=${count}&q=receivedInvitation`, { surface: 'invitations' });
  }

  async getConnections({ count = 40, start = 0 } = {}) {
    return this.get(
      `/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=${count}&q=search&start=${start}&sortType=RECENTLY_ADDED`,
      { surface: 'connections' }
    );
  }

  /** Send a connection invitation to a profile urn. */
  async sendInvitation(profileUrn, { message } = {}) {
    const body = {
      invitee: { 'com.linkedin.voyager.growth.invitation.InviteeProfile': { profileId: profileUrn } },
      trackingId: cryptoRandomTrackingId(),
    };
    if (message) body.message = message;
    return this.post('/growth/normInvitations', body, { surface: 'send_invitation' });
  }

  /** Accept a received invitation. */
  async acceptInvitation(invitationId, sharedSecret) {
    const enc = encodeURIComponent(invitationId);
    return this.post(
      `/relationships/invitations/${enc}?action=accept`,
      { invitationId, sharedSecret, isGenericInvitation: false },
      { surface: 'accept_invitation' }
    );
  }

  // ── Content ────────────────────────────────────────────────────────────

  async getNotifications({ count = 50 } = {}) {
    return this.get(
      `/voyagerIdentityDashNotificationCards?count=${count}&q=filterVanityName&filterVanityName=all`,
      { surface: 'notifications' }
    );
  }

  /** A profile's recent posts/activity. */
  async getProfilePosts(profileUrn, { count = 20, start = 0 } = {}) {
    const enc = encodeURIComponent(profileUrn);
    return this.get(
      `/identity/profileUpdatesV2?profileUrn=${enc}&q=memberShareFeed&count=${count}&start=${start}`,
      { surface: 'profile_posts' }
    );
  }

  async close() { this._ctx = null; }
}

module.exports = { VoyagerClient, VoyagerError, VOYAGER_BASE, DEFAULT_QUERY_IDS };
