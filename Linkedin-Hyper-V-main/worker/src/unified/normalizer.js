'use strict';

const crypto = require('crypto');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanLinkedInMessageText(value) {
  let normalized = normalizeWhitespace(value);
  normalized = normalized.replace(/^(?:[^\p{L}\p{N}]{0,16}\s*)?Open Emoji Keyboard\s*/iu, '');
  normalized = normalized.replace(/\s+Download$/i, '').trim();
  return normalized;
}

function accountNameMatchesSender(accountId, senderName) {
  const accountToken = normalizeWhitespace(accountId).toLowerCase();
  const senderToken = normalizeWhitespace(senderName).toLowerCase();
  if (!accountToken || !senderToken) return false;
  if (senderToken === accountToken) return true;
  return senderToken.includes(accountToken);
}

function nullableString(value) {
  const normalized = normalizeWhitespace(value);
  return normalized || null;
}

function isDurableLinkedInMessageId(value) {
  const id = normalizeWhitespace(value);
  if (!id) return false;
  if (/^(msg-row-|repair-|optimistic-|live-)/i.test(id)) return false;
  return id.startsWith('urn:li:msg_message') || id.startsWith('urn:li:fsd_message') || id.length > 24;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://www.linkedin.com');
    parsed.hash = '';
    parsed.searchParams.sort?.();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

function publicIdentifierFromUrl(profileUrl) {
  const normalized = normalizeUrl(profileUrl);
  const match = normalized.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function stableHash(input) {
  const canonicalize = (value) => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
          acc[key] = canonicalize(value[key]);
          return acc;
        }, {});
    }
    return value;
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex');
}

function toDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function toDateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseClockTime(value) {
  const normalized = normalizeWhitespace(value).toUpperCase();
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || '0');
  const meridiem = match[3];
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  if (meridiem === 'PM' && hours < 12) hours += 12;
  return { hours, minutes };
}

function inferDateFromDayLabel(dayLabel, timeText) {
  const normalizedDay = normalizeWhitespace(dayLabel).toUpperCase();
  const parsedTime = parseClockTime(timeText);
  if (!normalizedDay) return null;

  const now = new Date();
  const applyTime = (date) => {
    if (!parsedTime) return date;
    const next = new Date(date);
    next.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
    if (next.getTime() > now.getTime() + 5 * 60 * 1000) {
      next.setDate(next.getDate() - 1);
    }
    return next;
  };

  const weekdayIndex = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].indexOf(normalizedDay);
  if (weekdayIndex >= 0) {
    const candidate = new Date(now);
    candidate.setHours(12, 0, 0, 0);
    const delta = (candidate.getDay() - weekdayIndex + 7) % 7;
    candidate.setDate(candidate.getDate() - delta);
    return applyTime(candidate);
  }

  const explicitDate = new Date(`${normalizedDay}${parsedTime ? ` ${timeText}` : ''}`);
  if (!Number.isNaN(explicitDate.getTime())) {
    if (explicitDate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
      explicitDate.setFullYear(explicitDate.getFullYear() - 1);
    }
    return explicitDate;
  }

  return null;
}

function bestEffortMessageDate(raw, accountId, conversationId, identitySeed) {
  const inferred = inferDateFromDayLabel(raw?.dayLabel || '', raw?.timeText || '');
  if (inferred) {
    return {
      sentAt: inferred,
      timestampConfidence: 0.55,
      observedAt: new Date(),
    };
  }
  return {
    sentAt: new Date(),
    timestampConfidence: 0,
    observedAt: new Date(),
  };
}

function computeSenderConfidence({ senderId, senderName, isSentByMe, profileUrl }) {
  if (isSentByMe) return 1;
  if (senderId && senderId !== 'other' && senderName && senderName !== 'Unknown') return 0.95;
  if (profileUrl && senderName && senderName !== 'Unknown') return 0.8;
  if (senderName && senderName !== 'Unknown') return 0.45;
  return 0;
}

function computeIdentityConfidence({
  durableExternalId,
  senderConfidence,
  timestampConfidence,
  text,
  profileUrl,
}) {
  if (durableExternalId) return 1;
  let score = 0;
  if (text) score += 0.2;
  if (profileUrl) score += 0.2;
  score += Math.min(senderConfidence, 0.4);
  score += Math.min(timestampConfidence, 0.2);
  return Math.max(0, Math.min(0.95, score));
}

function conversationExternalId(accountId, conversationId) {
  const raw = String(conversationId || '');
  const prefix = `${accountId}:`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function messageTimeBucket(value, bucketMs = 5 * 60 * 1000) {
  const date = toDateOrNull(value);
  if (!date) return '';
  return String(Math.floor(date.getTime() / bucketMs));
}

function buildMessageDedupeKey({
  accountId,
  conversationId,
  externalId,
  senderId,
  senderName,
  text,
  sentAt,
  createdAt,
  timeText,
  positionHint,
  isOptimistic = false,
  source = 'linkedin',
}) {
  const normalizedText = cleanLinkedInMessageText(text || '');
  const normalizedSender = normalizeWhitespace(senderId || senderName || 'unknown').toLowerCase();
  const normalizedConversation = String(conversationId || '').trim();
  const stableExternalId = isDurableLinkedInMessageId(externalId) ? nullableString(externalId) : null;
  const exactDate = toDateOrNull(createdAt || sentAt);
  const normalizedTimeText = normalizeWhitespace(timeText || '').toLowerCase();
  const normalizedPosition = Number.isFinite(Number(positionHint)) ? String(Number(positionHint)) : '';

  if (stableExternalId) {
    return `linkedin:${stableHash({
      accountId,
      conversationId: normalizedConversation,
      externalId: stableExternalId,
    })}`;
  }

  if (exactDate && normalizedText) {
    return `timestamp:${stableHash({
      accountId,
      conversationId: normalizedConversation,
      sender: normalizedSender,
      text: normalizedText,
      sentAt: exactDate.toISOString(),
    })}`;
  }

  if (isOptimistic && normalizedText) {
    return `optimistic:${stableHash({
      accountId,
      conversationId: normalizedConversation,
      sender: normalizedSender || '__self__',
      text: normalizedText,
      bucket: messageTimeBucket(sentAt || createdAt, 2 * 60 * 1000),
    })}`;
  }

  return `fallback:${stableHash({
    accountId,
    conversationId: normalizedConversation,
    sender: normalizedSender,
    text: normalizedText,
    timeText: normalizedTimeText,
    positionHint: normalizedPosition,
    source,
  })}`;
}

function normalizeProfile(accountId, input = {}) {
  const profileUrl = normalizeUrl(input.profileUrl || input.url || '');
  const publicIdentifier = nullableString(input.publicIdentifier) || publicIdentifierFromUrl(profileUrl);
  const name = normalizeWhitespace(input.name || input.participantName || publicIdentifier || 'Unknown');

  return {
    accountId,
    externalId: nullableString(input.externalId || input.id || publicIdentifier),
    profileUrl: profileUrl || `urn:linkedin:unknown:${stableHash({ accountId, name }).slice(0, 16)}`,
    publicIdentifier,
    name,
    headline: nullableString(input.headline),
    location: nullableString(input.location),
    avatarUrl: nullableString(input.avatarUrl),
    company: nullableString(input.company),
    raw: input.raw || input,
    source: input.source || 'linkedin',
    contentHash: stableHash({
      accountId,
      profileUrl,
      publicIdentifier,
      name,
      headline: input.headline || '',
      location: input.location || '',
      company: input.company || '',
    }),
  };
}

function normalizeConversation(accountId, input = {}) {
  const participant = input.participant || input.participants?.[0] || {};
  const profileUrl = normalizeUrl(participant.profileUrl || input.participantProfileUrl || '');
  const participantName = normalizeWhitespace(
    participant.name ?? participant.displayName ?? input.participantName ?? 'Unknown'
  );
  const lastMessage = input.lastMessage || {};
  const sentAt = toDate(lastMessage.createdAt || lastMessage.sentAt || input.lastMessageAt || input.createdAt || Date.now());
  const externalId = conversationExternalId(accountId, input.conversationId || input.id);
  const threadUrl = normalizeUrl(input.threadUrl || input.url || '');
  const syncState = nullableString(input.syncState)
    || (externalId.startsWith('fallback-') || (!profileUrl && !normalizeWhitespace(lastMessage.text || input.lastMessageText || ''))
      ? 'shell_only'
      : 'available');

  return {
    id: `${accountId}:${externalId}`,
    externalId,
    accountId,
    threadUrl: threadUrl || null,
    participantName,
    participantProfileUrl: profileUrl || null,
    participantAvatarUrl: nullableString(participant.avatarUrl || input.participantAvatarUrl),
    lastMessageAt: sentAt,
    lastMessageText: normalizeWhitespace(lastMessage.text || input.lastMessageText || ''),
    lastMessageSentByMe: Boolean(lastMessage.sentByMe || lastMessage.senderId === '__self__' || input.lastMessageSentByMe),
    syncState,
    messageCount: Number.isFinite(Number(input.messageCount)) ? Number(input.messageCount) : 0,
    lastResolvedAt: input.lastResolvedAt ? toDate(input.lastResolvedAt) : null,
    resolveAttempts: Number.isFinite(Number(input.resolveAttempts)) ? Number(input.resolveAttempts) : 0,
    resolveError: nullableString(input.resolveError),
    source: input.source || 'linkedin',
    lastSeenAt: new Date(),
    syncCursor: nullableString(input.cursor),
    hasMoreHistory: Boolean(input.hasMoreHistory),
    contentHash: stableHash({
      accountId,
      externalId,
      threadUrl,
      participantName,
      profileUrl,
      lastMessageText: lastMessage.text || input.lastMessageText || '',
      sentAt: sentAt.toISOString(),
    }),
  };
}

function normalizeMessage(accountId, conversationId, input = {}) {
  const inferredSelf = accountNameMatchesSender(accountId, input.senderName || '');
  const isSentByMe = Boolean(input.isSentByMe || input.sentByMe || input.senderId === '__self__' || inferredSelf);
  const text = cleanLinkedInMessageText(input.text || '');
  const raw = input.raw || input;
  const senderId = isSentByMe ? '__self__' : (input.senderId || 'other');
  const senderName = input.senderName || (isSentByMe ? accountId : 'Unknown');
  const senderProfileUrl = normalizeUrl(raw.senderProfileUrl || input.senderProfileUrl || '');
  const externalId = nullableString(
    input.externalId
    || input.linkedinMessageId
    || input.id
    || raw.eventUrn
    || raw.domId
  );
  const durableExternalId = isDurableLinkedInMessageId(externalId) ? externalId : null;
  const timeText = normalizeWhitespace(raw.timeText || '');
  const positionHint = Number.isFinite(Number(raw.positionHint)) ? Number(raw.positionHint) : null;
  const identitySeed = {
    externalId: durableExternalId,
    senderId,
    senderName,
    text,
    timeText,
    positionHint,
    isSentByMe,
  };
  const parsedSentAt = toDateOrNull(input.createdAt || input.sentAt);
  const dateResolution = parsedSentAt
    ? { sentAt: parsedSentAt, timestampConfidence: 1, observedAt: new Date() }
    : bestEffortMessageDate(raw, accountId, conversationId, identitySeed);
  const sentAt = dateResolution.sentAt;
  const senderConfidence = computeSenderConfidence({
    senderId,
    senderName,
    isSentByMe,
    profileUrl: senderProfileUrl,
  });
  const identityConfidence = computeIdentityConfidence({
    durableExternalId,
    senderConfidence,
    timestampConfidence: dateResolution.timestampConfidence,
    text,
    profileUrl: senderProfileUrl,
  });
  const visibilityState = identityConfidence >= 0.7 && senderConfidence >= 0.45
    ? 'visible'
    : 'pending_repair';
  const dedupeKey = buildMessageDedupeKey({
    accountId,
    conversationId,
    externalId: durableExternalId,
    senderId,
    senderName,
    text,
    sentAt,
    createdAt: input.createdAt || input.sentAt,
    timeText,
    positionHint,
    isOptimistic: Boolean(input.isOptimistic || input.source === 'optimistic'),
    source: input.source || 'linkedin',
  });
  const contentHash = stableHash({
    accountId,
    conversationId,
    externalId: durableExternalId || null,
    senderId,
    senderName,
    text,
    timeText,
    positionHint,
    isSentByMe,
  });

  return {
    conversationId,
    accountId,
    externalId: durableExternalId,
    senderId,
    senderName,
    text,
    sentAt,
    isSentByMe,
    linkedinMessageId: durableExternalId,
    raw,
    source: input.source || 'linkedin',
    dedupeKey,
    contentHash,
    observedAt: input.observedAt || dateResolution.observedAt,
    timestampConfidence: dateResolution.timestampConfidence,
    senderConfidence,
    identityConfidence,
    visibilityState,
    isCanonical: visibilityState === 'visible',
  };
}

function normalizeConnection(accountId, input = {}) {
  const profile = normalizeProfile(accountId, input);
  const connectedAt = input.connectedAt ? toDate(input.connectedAt) : null;

  return {
    accountId,
    profileUrl: profile.profileUrl,
    name: profile.name,
    headline: nullableString(input.headline),
    connectedAt,
    status: input.status || 'connected',
    source: input.source || 'linkedin',
    raw: input.raw || input,
    contentHash: stableHash({
      accountId,
      profileUrl: profile.profileUrl,
      name: profile.name,
      status: input.status || 'connected',
    }),
    profile,
  };
}

function normalizeInvitation(accountId, input = {}) {
  const profile = normalizeProfile(accountId, input);
  return {
    accountId,
    profileUrl: profile.profileUrl,
    name: profile.name,
    note: nullableString(input.note || input.message),
    direction: input.direction || 'sent',
    status: input.status || 'pending',
    sentAt: input.sentAt ? toDate(input.sentAt) : null,
    receivedAt: input.receivedAt ? toDate(input.receivedAt) : null,
    source: input.source || 'linkedin',
    raw: input.raw || input,
    contentHash: stableHash({
      accountId,
      profileUrl: profile.profileUrl,
      direction: input.direction || 'sent',
      status: input.status || 'pending',
      note: input.note || input.message || '',
    }),
    profile,
  };
}

function normalizeNotification(accountId, input = {}) {
  const occurredAt = toDate(input.occurredAt || input.timestamp || Date.now());
  const title = normalizeWhitespace(input.title || input.type || 'LinkedIn activity');
  const text = nullableString(input.text || input.message);
  const url = normalizeUrl(input.url || input.targetProfileUrl || '');

  return {
    accountId,
    externalId: nullableString(input.externalId || input.id),
    type: input.type || 'activity',
    title,
    text,
    url: url || null,
    occurredAt,
    seenAt: input.seenAt ? toDate(input.seenAt) : null,
    source: input.source || 'linkedin',
    raw: input.raw || input,
    contentHash: stableHash({
      accountId,
      type: input.type || 'activity',
      title,
      text,
      url,
      occurredAt: occurredAt.toISOString(),
    }),
    profile: input.targetProfileUrl || input.targetName
      ? normalizeProfile(accountId, {
          profileUrl: input.targetProfileUrl,
          name: input.targetName,
          source: input.source || 'linkedin',
        })
      : null,
  };
}

function normalizePost(accountId, input = {}) {
  const postedAt = input.postedAt || input.timestamp ? toDate(input.postedAt || input.timestamp) : null;
  const authorUrl = normalizeUrl(input.authorUrl || input.profileUrl || '');
  const text = nullableString(input.text || input.message);

  return {
    accountId,
    externalId: nullableString(input.externalId || input.id),
    authorName: normalizeWhitespace(input.authorName || input.name || 'Unknown'),
    authorUrl: authorUrl || null,
    text,
    url: nullableString(normalizeUrl(input.url || '')),
    postedAt,
    source: input.source || 'linkedin',
    raw: input.raw || input,
    contentHash: stableHash({
      accountId,
      externalId: input.externalId || input.id || '',
      authorUrl,
      text,
      postedAt: postedAt?.toISOString() || '',
    }),
  };
}

module.exports = {
  cleanLinkedInMessageText,
  normalizeWhitespace,
  normalizeUrl,
  isDurableLinkedInMessageId,
  publicIdentifierFromUrl,
  stableHash,
  buildMessageDedupeKey,
  toDate,
  normalizeProfile,
  normalizeConversation,
  normalizeMessage,
  normalizeConnection,
  normalizeInvitation,
  normalizeNotification,
  normalizePost,
};
