'use strict';

// Maps raw Voyager (LEGACY_INBOX) JSON into the SAME item shapes the DOM
// scraper produces, so normalizeConversation()/normalizeMessage() consume them
// unchanged. Defensive throughout — Voyager shapes vary by app version, so
// every access is optional and falls back gracefully.
//
// VALIDATE these mappings against a real capture from worker/src/voyager/
// harvest.js before trusting them in production (Phase 1 side-by-side compare).

function lastUrnSegment(urn) {
  const s = String(urn || '');
  if (!s) return '';
  // urn:li:fs_conversation:2-abc==  -> 2-abc==
  // urn:li:fsd_conversation:(urn,...) -> take innermost-ish
  const colon = s.lastIndexOf(':');
  return colon >= 0 ? s.slice(colon + 1).replace(/^\(+|\)+$/g, '') : s;
}

// A MessagingMember can appear under several wrappers depending on version.
function pickMiniProfile(member) {
  if (!member) return {};
  return (
    member.miniProfile
    || member['com.linkedin.voyager.messaging.MessagingMember']?.miniProfile
    || member.messagingMember?.miniProfile
    || {}
  );
}

function memberName(mini) {
  const first = (mini.firstName || '').trim();
  const last = (mini.lastName || '').trim();
  const full = `${first} ${last}`.trim();
  return full || mini.name || '';
}

function memberProfileUrl(mini) {
  return mini.publicIdentifier
    ? `https://www.linkedin.com/in/${mini.publicIdentifier}/`
    : '';
}

function memberAvatar(mini) {
  const root = mini.picture?.['com.linkedin.common.VectorImage']?.rootUrl
    || mini.picture?.rootUrl;
  const seg = mini.picture?.['com.linkedin.common.VectorImage']?.artifacts?.[0]?.fileIdentifyingUrlPathSegment
    || mini.picture?.artifacts?.[0]?.fileIdentifyingUrlPathSegment;
  return root && seg ? `${root}${seg}` : '';
}

function extractMessageText(event) {
  const mc = event?.eventContent
    || event?.['com.linkedin.voyager.messaging.event.MessageEvent']
    || {};
  const msg = mc['com.linkedin.voyager.messaging.event.MessageEvent'] || mc;
  return (
    msg?.attributedBody?.text
    || msg?.body
    || msg?.subject
    || ''
  );
}

/**
 * Map a conversations list response to scraper-shaped inbox items.
 * @returns {Array}
 */
function mapConversations(json, { accountId } = {}) {
  const elements = json?.elements || json?.data?.elements || json?.included || [];
  const out = [];
  for (const el of elements) {
    if (!el) continue;
    const entityUrn = el.entityUrn || el.dashEntityUrn || el.conversationUrn || '';
    const convId = lastUrnSegment(entityUrn) || el.conversationId || el.id;
    if (!convId) continue;

    // Latest event = lastMessage
    const events = el.events || el.messages || [];
    const latest = events[0] || el.lastEvent || {};
    const fromMini = pickMiniProfile(latest.from || latest.sender);

    // The "other" participant (best-effort: first non-self participant).
    const participants = el.participants || el.conversationParticipants || [];
    const otherMini = pickMiniProfile(participants.find(Boolean));

    const participantMini = Object.keys(otherMini).length ? otherMini : fromMini;

    out.push({
      conversationId: convId,
      id: convId,
      threadUrl: `https://www.linkedin.com/messaging/thread/${convId}/`,
      participant: {
        name: memberName(participantMini),
        profileUrl: memberProfileUrl(participantMini),
        avatarUrl: memberAvatar(participantMini),
      },
      lastMessage: {
        text: extractMessageText(latest),
        createdAt: latest.createdAt || el.lastActivityAt || null,
      },
      lastMessageAt: el.lastActivityAt || latest.createdAt || null,
      source: 'voyager',
    });
  }
  return out;
}

/**
 * Map a conversation events response to scraper-shaped thread items + participant.
 * @returns {{ items: Array, participant: object|null }}
 */
function mapEvents(json, { accountId, chatId } = {}) {
  const elements = json?.elements || json?.data?.elements || [];
  const items = [];
  let participant = null;

  for (const ev of elements) {
    if (!ev) continue;
    const entityUrn = ev.entityUrn || ev.eventUrn || '';
    const fromMini = pickMiniProfile(ev.from || ev.sender);
    const name = memberName(fromMini);
    const profileUrl = memberProfileUrl(fromMini);

    if (!participant && name) {
      participant = { name, profileUrl, avatarUrl: memberAvatar(fromMini) };
    }

    items.push({
      // Preserve the FULL message URN (e.g. urn:li:fsd_message:2-abc==). The
      // normalizer needs the urn: prefix to treat it as a durable id; stripping
      // to the last segment made Voyager messages fall back to weaker
      // timestamp/position dedupe keys and duplicate. (Falls back to eventId.)
      externalId: entityUrn || ev.eventId || null,
      senderName: name || 'Unknown',
      senderProfileUrl: profileUrl,
      text: extractMessageText(ev),
      createdAt: ev.createdAt || null,
      source: 'voyager',
      raw: {
        eventUrn: entityUrn,
        timeText: '',
        ...ev,
      },
    });
  }

  // Voyager returns newest-first; the scraper/normalizer expect oldest-first.
  items.reverse();
  return { items, participant };
}

module.exports = { mapConversations, mapEvents, lastUrnSegment, extractMessageText };
