'use strict';

// Provider-compatible adapter: exposes readInbox()/readThread() with the EXACT
// return contract of LinkedInProvider, but backed by the Voyager JSON API
// instead of DOM scraping. Drop-in for the orchestrator's read paths.

const { VoyagerClient } = require('./VoyagerClient');
const { mapConversations, mapEvents } = require('./voyagerMapper');
const { checkAndIncrement } = require('../rateLimit');

async function readInbox({ accountId, limit = 25 }) {
  // Same rate-limit accounting as the scraper path.
  await checkAndIncrement(accountId, 'inboxReads');

  const client = new VoyagerClient(accountId);
  const json = await client.getConversations({ count: limit });
  const items = mapConversations(json, { accountId });

  return {
    surface: 'inbox',
    coverage: 'available',
    items,
    cursor: null,
    hasMore: items.length >= limit,
    via: 'voyager',
  };
}

async function readThread({ accountId, chatId, threadUrl, limit = 50 }) {
  const client = new VoyagerClient(accountId);
  const json = await client.getConversationEvents(chatId, { count: limit });
  const { items, participant } = mapEvents(json, { accountId, chatId });

  return {
    surface: 'thread',
    coverage: items.length ? 'available' : 'partial',
    items,
    participant,
    resolvedChatId: chatId,
    threadUrl: threadUrl || `https://www.linkedin.com/messaging/thread/${chatId}/`,
    code: 'OK',
    diagnostics: null,
    partialParticipant: null,
    cursor: null,
    hasMore: items.length >= limit,
    via: 'voyager',
  };
}

/**
 * Read first-degree connections via the Voyager API (avoids the DOM connections
 * page that redirect-loops with ERR_TOO_MANY_REDIRECTS). Returns the same
 * { surface, coverage, items, ... } contract as the scraper path. Items are the
 * raw Voyager connection elements; the orchestrator already runs them through
 * normalizeConnection.
 */
async function readConnections({ accountId, limit = 40, start = 0 }) {
  const client = new VoyagerClient(accountId);
  const json = await client.getConnections({ count: limit, start });
  const elements = json?.elements || json?.data?.elements || [];
  // Map each element into the shape normalizeConnection expects.
  const items = elements.map((el) => {
    const mp = el.connectedMemberResolutionResult
      || el.miniProfile
      || el['com.linkedin.voyager.dash.identity.profile.Profile']
      || el;
    const publicId = mp.publicIdentifier || mp.publicId;
    return {
      profileUrl: publicId ? `https://www.linkedin.com/in/${publicId}/` : (el.profileUrl || ''),
      name: `${mp.firstName || ''} ${mp.lastName || ''}`.trim() || mp.name || '',
      firstName: mp.firstName,
      lastName: mp.lastName,
      headline: mp.occupation || mp.headline || el.headline,
      publicIdentifier: publicId,
      connectedAt: el.createdAt || el.connectedAt || null,
      status: 'connected',
      source: 'voyager',
      raw: el,
    };
  });
  return {
    surface: 'connections',
    coverage: 'available',
    items,
    cursor: null,
    hasMore: items.length >= limit,
    via: 'voyager',
  };
}

// ── Writes (Phase 4) — gated by the same human-pace caps as the scraper. ────

async function sendMessage({ accountId, chatId, text, mailboxUrn }) {
  await checkAndIncrement(accountId, 'messagesSent');
  const client = new VoyagerClient(accountId);
  const res = await client.sendMessage(chatId, text, { mailboxUrn });
  return { ok: true, via: 'voyager', raw: res };
}

async function sendInvitation({ accountId, profileUrn, message }) {
  await checkAndIncrement(accountId, 'connectRequests');
  const client = new VoyagerClient(accountId);
  const res = await client.sendInvitation(profileUrn, { message });
  return { ok: true, via: 'voyager', raw: res };
}

module.exports = { readInbox, readThread, readConnections, sendMessage, sendInvitation };
