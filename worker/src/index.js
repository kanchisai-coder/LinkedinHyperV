'use strict';

const express    = require('express');
const crypto     = require('crypto');
const dns        = require('node:dns').promises;
const net        = require('node:net');
const { v4: uuidv4 } = require('uuid');
const { getQueue, getConnectQueue, getQueueEvents }   = require('./queue');
const { startWorker, ensureAccountWorkers }  = require('./worker');
const {
  saveCookies,
  loadCookies,
  sessionMeta,
  deleteSession,
  listKnownAccountIds,
  hasRequiredLinkedInSessionCookies,
} = require('./session');
const { verifySession } = require('./actions/login');
const { startLinkedInConnectSession } = require('./actions/connectSession');
const { createConnectSession, getConnectSession } = require('./connectSessions');
const { readMessages } = require('./actions/readMessages');
const { readThread } = require('./actions/readThread');
const { sendMessage } = require('./actions/sendMessage');
const { sendMessageNew } = require('./actions/sendMessageNew');
const { sendConnectionRequest } = require('./actions/connect');
const { searchPeople } = require('./actions/searchPeople');
const { getLimits }    = require('./rateLimit');
const {
  sanitizeText,
  sanitizeNote,
  validateId,
  validateProfileUrl,
  parseLimit,
} = require('./sanitizers');
const { resolveCanonicalAccountId, dedupeAccountIds } = require('./accountIdentity');
const {
  getCachedJson,
  setCachedJson,
  invalidateAccountCaches,
  invalidateSyncStatusCache,
} = require('./unifiedCache');

const app  = express();
const PORT = process.env.PORT || 3001;

// Startup validation for ACCOUNT_IDS
if (process.env.ACCOUNT_IDS) {
  const ids = process.env.ACCOUNT_IDS.split(',');
  if (ids.some(id => !id || !id.trim())) {
    throw new Error('ACCOUNT_IDS contains empty string segments. Check for trailing commas.');
  }
}

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const existing = req.headers['x-request-id'];
  const requestId = Array.isArray(existing) ? existing[0] : existing;
  req.requestId = String(requestId || crypto.randomUUID());
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// Return JSON for malformed request bodies instead of Express HTML error page.
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body. Ensure request payload is valid JSON.' });
  }
  return next(err);
});

// â”€â”€ Global request timeout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Set to 130 s so Express always responds before the BFF AbortSignal (120 s)
// fires, giving the client a meaningful 504 instead of a connection reset.
app.use((req, res, next) => {
  res.setTimeout(130_000, () => {
    if (!res.headersSent) res.status(504).json({ error: 'Request timed out' });
  });
  next();
});

// â”€â”€ Auth middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function requireApiKey(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'API_SECRET not configured' });
  }

  const provided = req.headers['x-api-key'] || '';

  if (
    provided.length !== secret.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

function isDatabaseUnavailable(err) {
  if (!err) return false;
  const code = err.code || err?.meta?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === 'DB_TIMEOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'P1001' ||
    code === 'P2021' || // table does not exist
    code === 'P2022' || // column does not exist
    message.includes('ECONNREFUSED') ||
    message.includes("Can't reach database server") ||
    message.includes('does not exist in the current database')
  );
}

async function withTimeout(promise, timeoutMs, code = 'DB_TIMEOUT') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`Operation timed out after ${timeoutMs}ms`);
      err.code = code;
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// SSRF guard lives in a shared module so the webhook delivery paths
// (services/webhookRetryService, events/webhookDispatcher) can re-validate at
// send time without a circular require on this file.
const { assertSafeWebhookTarget } = require('./security/ssrfGuard');

function toPublicOperationError(err, fallbackMessage = 'Operation failed') {
  if (process.env.NODE_ENV !== 'production') {
    return err?.message || fallbackMessage;
  }

  // Safe, actionable errors that help operators without exposing sensitive details.
  const safeCodes = new Set([
    'NO_ACTIVE_SESSION',
    'NO_SESSION',
    'SESSION_EXPIRED',
    'CHECKPOINT_INCOMPLETE',
    'LOGIN_NOT_FINISHED',
    'COOKIES_MISSING',
    'AUTHENTICATED_STATE_NOT_REACHED',
    'NOT_MESSAGEABLE',
    'SEND_NOT_CONFIRMED',
    'RATE_LIMIT_EXCEEDED',
    'QUEUE_UNAVAILABLE',
    'READ_INBOX_TIMEOUT',
  ]);

  if (err?.code && safeCodes.has(err.code) && err?.message) {
    return err.message;
  }

  return fallbackMessage;
}

function normalizeThreadId(accountId, conversationId) {
  const raw = String(conversationId || '');
  const prefix = `${accountId}:`;
  if (raw.startsWith(prefix)) {
    return raw.slice(prefix.length);
  }
  return raw;
}

function ensureConversationId(accountId, conversationId) {
  const raw = String(conversationId || '').trim();
  if (!raw) return '';
  return raw.startsWith(`${accountId}:`) ? raw : `${accountId}:${raw}`;
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function deriveLiveReachability(account, meta) {
  const sessionStatus = String(account?.sessionStatus || '');
  const storedReachability = String(account?.liveReachability || '').trim();
  if (storedReachability && storedReachability !== 'unknown') return storedReachability;
  if (sessionStatus === 'restricted') return 'automation_warning';
  if (sessionStatus === 'checkpoint') return 'checkpoint';
  if (sessionStatus === 'expired') return 'login_redirect';
  if (storedReachability === 'unknown') return 'unknown';
  if (meta) return 'unknown';
  return 'missing_session';
}

function mapDbMessagesToApiItems(messages) {
  return messages.map((msg) => {
    const hasTrustedTimestamp = Number(msg.timestampConfidence ?? 1) > 0;
    const createdAt = hasTrustedTimestamp ? new Date(msg.sentAt).toISOString() : null;
    const isSentByMe = Boolean(msg.isSentByMe);
    return {
      id: msg.id,
      chatId: msg.conversationId,
      senderId: isSentByMe ? '__self__' : (msg.senderId || 'other'),
      text: msg.text || '',
      createdAt,
      // Compatibility fields for older consumers
      sentAt: createdAt,
      isSentByMe,
      senderName: msg.senderName || (isSentByMe ? msg.accountId : 'Unknown'),
      source: msg.source || 'linkedin',
      visibilityState: msg.visibilityState || 'visible',
      isCanonical: msg.isCanonical !== false,
      senderConfidence: Number(msg.senderConfidence ?? 1),
      timestampConfidence: Number(msg.timestampConfidence ?? 1),
    };
  });
}

function mapLiveMessagesToApiItems(messages, fallbackChatId, accountId) {
  return (messages || []).map((msg, idx) => {
    const createdAt = msg.createdAt || new Date().toISOString();
    const isSentByMe = msg.senderId === '__self__' || msg.isSentByMe === true;
    return {
      id: msg.id || `live-${Date.now()}-${idx}`,
      chatId: msg.chatId || fallbackChatId,
      senderId: isSentByMe ? '__self__' : (msg.senderId || 'other'),
      text: msg.text || '',
      createdAt,
      // Compatibility fields for older consumers
      sentAt: createdAt,
      isSentByMe,
      senderName:
        msg.senderName || (isSentByMe ? accountId : 'Unknown'),
      source: msg.source || 'linkedin',
    };
  });
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isGenericUiLabel(value) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) return true;

  if (/^\d+$/.test(normalized)) return true;
  if (/^\d+\s*(notification|notifications|message|messages)(\s+total)?$/.test(normalized)) return true;
  if (/^(notification|notifications|message|messages)\s+total$/.test(normalized)) return true;

  const blocked = [
    'unknown',
    'inbox',
    'messages',
    'messaging',
    'linkedin messaging',
    'activity',
    'notifications',
    'notifications total',
    'loading',
    'linkedin',
    'feed',
    'search',
  ];
  return blocked.includes(normalized);
}

function deriveNameFromProfileUrl(profileUrl) {
  const match = String(profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match?.[1]) return '';

  return normalizeWhitespace(
    decodeURIComponent(match[1])
      .replace(/[-_]+/g, ' ')
      .replace(/\b\d+\b/g, '')
  );
}

function isOpaqueLinkedInIdentifier(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  const compact = normalized.replace(/[^A-Za-z0-9]/g, '');
  return /^ACo[A-Za-z0-9]{12,}$/i.test(compact) || /^A[A-Za-z0-9]{15,}$/i.test(compact);
}

function normalizeParticipantName(name, profileUrl) {
  const parsedName = normalizeWhitespace(name);
  if (parsedName && !isGenericUiLabel(parsedName) && !isOpaqueLinkedInIdentifier(parsedName)) {
    return parsedName;
  }
  const fromProfile = deriveNameFromProfileUrl(profileUrl);
  if (!fromProfile || isOpaqueLinkedInIdentifier(fromProfile)) {
    return 'Unknown';
  }
  return fromProfile;
}

async function resolveConversationParticipantName(messageRepo, conversation) {
  const rawName = normalizeWhitespace(conversation?.participantName || '');
  if (rawName && !isGenericUiLabel(rawName) && !isOpaqueLinkedInIdentifier(rawName)) {
    return rawName;
  }

  try {
    const messages = await withTimeout(
      messageRepo.getMessagesByConversation(String(conversation?.id || ''), 25, 0),
      4000
    );
    const firstOther = (messages || []).find((message) => {
      const senderName = normalizeWhitespace(message?.senderName || '');
      return message?.senderId !== '__self__' && senderName && !isGenericUiLabel(senderName);
    });
    if (firstOther?.senderName) {
      return normalizeWhitespace(firstOther.senderName);
    }
  } catch (err) {
    if (!isDatabaseUnavailable(err)) {
      console.warn('[Inbox] Participant name hint lookup failed:', err?.message || String(err));
    }
  }

  const previewMatch = String(conversation?.lastMessageText || '').match(/^([^:]{2,40}):\s*/);
  if (previewMatch?.[1]) {
    const candidate = normalizeWhitespace(previewMatch[1]);
    if (candidate && candidate.toLowerCase() !== 'you' && !isGenericUiLabel(candidate)) {
      return candidate;
    }
  }

  return normalizeParticipantName(conversation?.participantName, conversation?.participantProfileUrl || '');
}

function normalizeProfileUrlForCompare(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    parsed.search = '';
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = normalizedPath || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return String(url || '').trim().replace(/\/+$/, '');
  }
}

function deriveParticipantNameFromItems(items, fallbackName = 'Unknown') {
  const firstOther = Array.isArray(items)
    ? items.find((item) => {
      const senderName = normalizeWhitespace(item?.senderName || '');
      return item?.senderId !== '__self__' && senderName && !isGenericUiLabel(senderName) && !isOpaqueLinkedInIdentifier(senderName);
    })
    : null;
  if (firstOther?.senderName) {
    return normalizeWhitespace(firstOther.senderName);
  }
  return fallbackName;
}

function normalizeActivityToken(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function buildActivityDedupKey(entry) {
  const profileUrl = normalizeProfileUrlForCompare(entry?.targetProfileUrl || '');
  const participantName = normalizeParticipantName(entry?.targetName, profileUrl);
  const targetIdentity = profileUrl || normalizeActivityToken(participantName);
  const messageIdentity = normalizeActivityToken(entry?.message || entry?.textPreview || '');
  return [
    normalizeActivityToken(entry?.type || 'activity'),
    normalizeActivityToken(entry?.accountId || ''),
    targetIdentity,
    messageIdentity,
  ].join('|');
}

function dedupeRecentActivity(entries, windowMs = 10 * 60 * 1000) {
  const sorted = [...(entries || [])].sort(
    (a, b) => (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0)
  );

  const latestSeenByKey = new Map();
  const deduped = [];

  for (const entry of sorted) {
    const timestamp = Number(entry?.timestamp) || 0;
    const key = buildActivityDedupKey(entry);
    const previousTs = latestSeenByKey.get(key);

    if (typeof previousTs === 'number' && previousTs - timestamp <= windowMs) {
      continue;
    }

    latestSeenByKey.set(key, timestamp);
    deduped.push(entry);
  }

  return deduped;
}

// â”€â”€ Health (no auth) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function connectionKey(accountId, name, profileUrl) {
  const normalizedUrl = normalizeProfileUrlForCompare(profileUrl);
  const normalizedName = normalizeWhitespace(name).toLowerCase();
  return `${accountId}|${normalizedUrl || normalizedName}`;
}

function pushLatestConnection(latestByConnection, item) {
  if (!item?.accountId) return;
  const key = connectionKey(item.accountId, item.name, item.profileUrl);
  const previous = latestByConnection.get(key);
  const currentTs = Number(item.connectedAt) || 0;
  const previousTs = Number(previous?.connectedAt) || 0;
  if (!previous || currentTs >= previousTs) {
    latestByConnection.set(key, item);
  }
}

function mapActivityEntryToConnection(accountId, entry) {
  if (!entry || (entry.type !== 'connectionSent' && entry.type !== 'messageSent')) {
    return null;
  }
  const profileUrl = String(entry.targetProfileUrl || '');
  const name = normalizeParticipantName(entry.targetName, profileUrl);
  if (!name || name === 'Unknown') return null;

  return {
    accountId,
    name,
    profileUrl,
    connectedAt: Number(entry.timestamp) || Date.now(),
    source: entry.type,
  };
}

async function buildUnifiedConnections(limit = 300) {
  const ids = await listKnownAccountIds();
  const latestByConnection = new Map();
  const redis = getRedis();

  for (const accountId of ids) {
    try {
      const rows = await redis.lrange(`activity:log:${accountId}`, 0, 1000);
      for (const raw of rows) {
        try {
          const parsed = JSON.parse(raw);
          const mapped = mapActivityEntryToConnection(accountId, parsed);
          if (mapped) {
            pushLatestConnection(latestByConnection, mapped);
          }
        } catch {
          // Ignore malformed activity rows.
        }
      }
    } catch {
      // Ignore Redis activity-read issues.
    }

    try {
      const messageRepo = require('./db/repositories/MessageRepository');
      const conversations = await withTimeout(
        messageRepo.getConversationsByAccount(accountId, 500, 0),
        4000
      );
      for (const conv of conversations || []) {
        const profileUrl = String(conv?.participantProfileUrl || '');
        const name = normalizeParticipantName(conv?.participantName, profileUrl);
        if (!name || name === 'Unknown') continue;
        pushLatestConnection(latestByConnection, {
          accountId,
          name,
          profileUrl,
          connectedAt: Number(new Date(conv?.lastMessageAt || Date.now()).getTime()) || Date.now(),
          source: 'conversation',
        });
      }
    } catch (err) {
      if (!isDatabaseUnavailable(err)) {
        console.warn(`[Connections] DB fallback failed for ${accountId}:`, err?.message || String(err));
      }
    }
  }

  const connections = Array.from(latestByConnection.values())
    .sort((a, b) => (Number(b.connectedAt) || 0) - (Number(a.connectedAt) || 0))
    .slice(0, limit)
    .map(({ source, ...rest }) => rest);

  return { connections };
}

const UNIFIED_CONNECTIONS_CACHE_TTL_MS = 60_000;
let unifiedConnectionsCache = {
  expiresAt: 0,
  payload: { connections: [] },
};
let unifiedConnectionsInFlight = null;

function invalidateUnifiedViewCaches() {
  unifiedConnectionsCache = {
    expiresAt: 0,
    payload: { connections: [] },
  };
  unifiedConnectionsInFlight = null;
  unifiedInboxCache = {
    expiresAt: 0,
    payload: { conversations: [] },
  };
  unifiedInboxInFlight = null;
  void invalidateAccountCaches(null, null);
}

async function getUnifiedConnectionsWithCache(limit = 300) {
  const now = Date.now();
  if (unifiedConnectionsCache.expiresAt > now) {
    return { connections: unifiedConnectionsCache.payload.connections.slice(0, limit) };
  }

  if (unifiedConnectionsInFlight) {
    const payload = await unifiedConnectionsInFlight;
    return { connections: payload.connections.slice(0, limit) };
  }

  unifiedConnectionsInFlight = (async () => {
    const payload = await buildUnifiedConnections(limit);
    unifiedConnectionsCache = {
      expiresAt: Date.now() + UNIFIED_CONNECTIONS_CACHE_TTL_MS,
      payload,
    };
    return payload;
  })();

  try {
    const payload = await unifiedConnectionsInFlight;
    return { connections: payload.connections.slice(0, limit) };
  } finally {
    unifiedConnectionsInFlight = null;
  }
}

async function buildUnifiedInboxFromActivity(limit = 100) {
  const ids = await listKnownAccountIds();
  const redis = getRedis();
  const latestByConversation = new Map();

  for (const accountId of ids) {
    let entries = [];
    try {
      entries = await redis.lrange(`activity:log:${accountId}`, 0, 500);
    } catch {
      continue;
    }

    for (const raw of entries) {
      try {
        const item = JSON.parse(raw);
        if (item?.type !== 'messageSent') continue;

        const participantProfileUrl = String(item.targetProfileUrl || '');
        const participantName = normalizeParticipantName(item.targetName, participantProfileUrl);
        const sentAt = Number(item.timestamp) || Date.now();
        const textPreview = typeof item.textPreview === 'string' && item.textPreview.length > 0
          ? item.textPreview
          : `Sent message (${Number(item.messageLength) || 0} chars)`;

        const key = `${accountId}|${participantName}|${participantProfileUrl}`;
        const previous = latestByConversation.get(key);
        if (previous && previous.lastMessage?.sentAt >= sentAt) continue;

        latestByConversation.set(key, {
          conversationId: `activity-${Buffer.from(key).toString('base64url')}`,
          accountId,
          participant: {
            name: participantName,
            profileUrl: participantProfileUrl,
          },
          lastMessage: {
            text: textPreview,
            sentAt,
            sentByMe: true,
          },
          unreadCount: 0,
          messages: [
            {
              id: `activity-msg-${sentAt}`,
              text: textPreview,
              sentAt,
              sentByMe: true,
              senderName: accountId,
            },
          ],
        });
      } catch {
        // Ignore malformed activity rows.
      }
    }
  }

  const conversations = Array.from(latestByConversation.values())
    .sort((a, b) => (b.lastMessage?.sentAt || 0) - (a.lastMessage?.sentAt || 0))
    .slice(0, limit);

  return { conversations };
}

const UNIFIED_INBOX_CACHE_TTL_MS = 60_000;
let unifiedInboxCache = {
  expiresAt: 0,
  payload: { conversations: [] },
};
let unifiedInboxInFlight = null;

function normalizeConversationFromInboxItem(accountId, item) {
  const participantProfileUrl = String(item?.participants?.[0]?.profileUrl || '');
  const participantName = normalizeParticipantName(item?.participants?.[0]?.name, participantProfileUrl);
  const rawId = String(item?.id || `unknown-${Date.now()}`);
  const createdAt = item?.lastMessage?.createdAt || item?.createdAt || new Date().toISOString();
  const sentAt = Number(new Date(createdAt).getTime()) || Date.now();

  return {
    conversationId: `${accountId}:${rawId}`,
    accountId,
    participant: {
      name: participantName,
      profileUrl: participantProfileUrl,
    },
    lastMessage: {
      text: String(item?.lastMessage?.text || ''),
      sentAt,
      sentByMe: item?.lastMessage?.senderId === '__self__',
    },
    unreadCount: Number(item?.unreadCount) || 0,
    messages: [],
  };
}

function getConversationSentAt(conv) {
  return Number(conv?.lastMessage?.sentAt) || 0;
}

function getConversationText(conv) {
  return normalizeWhitespace(conv?.lastMessage?.text || '');
}

function getConversationProfileUrl(conv) {
  return normalizeProfileUrlForCompare(conv?.participant?.profileUrl || '');
}

function getConversationNameToken(conv) {
  return normalizeWhitespace(conv?.participant?.name || '').toLowerCase();
}

function conversationQualityScore(conv) {
  const hasProfile = Boolean(getConversationProfileUrl(conv));
  const hasText = Boolean(getConversationText(conv));
  const hasMessages = Array.isArray(conv?.messages) && conv.messages.length > 0;
  const conversationId = String(conv?.conversationId || '');
  const isFallbackId = conversationId.startsWith('fallback-');
  const isActivityId = conversationId.startsWith('activity-');

  let score = 0;
  if (hasProfile) score += 40;
  if (hasText) score += 20;
  if (hasMessages) score += 10;
  if (isActivityId) score += 5;
  if (isFallbackId) score -= 15;
  return score;
}

function isLowSignalFallbackConversation(conv) {
  const conversationId = String(conv?.conversationId || '');
  const hasProfile = Boolean(getConversationProfileUrl(conv));
  const hasText = Boolean(getConversationText(conv));
  return conversationId.startsWith('fallback-') && !hasProfile && !hasText;
}

function shouldReplaceConversation(previous, current) {
  const previousScore = conversationQualityScore(previous);
  const currentScore = conversationQualityScore(current);
  if (currentScore !== previousScore) {
    return currentScore > previousScore;
  }

  const previousSentAt = getConversationSentAt(previous);
  const currentSentAt = getConversationSentAt(current);
  if (currentSentAt !== previousSentAt) {
    return currentSentAt > previousSentAt;
  }

  const previousUnread = Number(previous?.unreadCount) || 0;
  const currentUnread = Number(current?.unreadCount) || 0;
  return currentUnread > previousUnread;
}

function dedupeAndSortConversations(conversations) {
  const profileAliasByName = new Map();

  for (const conv of conversations) {
    if (!conv?.accountId) continue;
    const profileUrl = getConversationProfileUrl(conv);
    const nameToken = getConversationNameToken(conv);
    if (!profileUrl || !nameToken) continue;

    const aliasKey = `${conv.accountId}|${nameToken}`;
    const previous = profileAliasByName.get(aliasKey);
    if (!previous || getConversationSentAt(conv) >= previous.sentAt) {
      profileAliasByName.set(aliasKey, {
        profileUrl,
        sentAt: getConversationSentAt(conv),
      });
    }
  }

  const latestByConversation = new Map();

  for (const conv of conversations) {
    if (!conv?.accountId) continue;

    const nameToken = getConversationNameToken(conv);
    const directProfileUrl = getConversationProfileUrl(conv);
    const aliasProfileUrl = nameToken
      ? profileAliasByName.get(`${conv.accountId}|${nameToken}`)?.profileUrl || ''
      : '';
    const resolvedProfileUrl = directProfileUrl || aliasProfileUrl;
    const key = resolvedProfileUrl
      ? `${conv.accountId}|profile|${resolvedProfileUrl}`
      : `${conv.accountId}|name|${nameToken || String(conv?.conversationId || '').toLowerCase()}`;

    const previous = latestByConversation.get(key);
    if (!previous || shouldReplaceConversation(previous, conv)) {
      latestByConversation.set(key, conv);
    }
  }

  const sorted = Array.from(latestByConversation.values()).sort(
    (a, b) => (Number(b?.lastMessage?.sentAt) || 0) - (Number(a?.lastMessage?.sentAt) || 0)
  );

  const hasHighSignalRows = sorted.some(
    (conv) => Boolean(getConversationProfileUrl(conv)) || Boolean(getConversationText(conv))
  );

  if (!hasHighSignalRows) {
    return sorted;
  }

  const cleaned = sorted.filter((conv) => !isLowSignalFallbackConversation(conv));
  return cleaned.length > 0 ? cleaned : sorted;
}

async function persistOptimisticSendResult({
  accountId,
  text,
  result,
  chatId = null,
  profileUrl = '',
  participantName = '',
}) {
  let messageRepo;
  try {
    messageRepo = require('./db/repositories/MessageRepository');
  } catch {
    return;
  }

  const participantProfileUrl = String(profileUrl || '');
  const resolvedParticipantName = normalizeParticipantName(participantName || '', participantProfileUrl);
  const rawChatId = String(chatId || result?.chatId || '').trim();
  const fallbackKey = `${accountId}|${resolvedParticipantName}|${participantProfileUrl}`;
  const conversationId =
    rawChatId && rawChatId !== 'new'
      ? ensureConversationId(accountId, rawChatId)
      : `activity-${Buffer.from(fallbackKey).toString('base64url')}`;

  const parsedCreatedAt = new Date(result?.createdAt || Date.now());
  const createdAt = Number.isNaN(parsedCreatedAt.getTime()) ? new Date() : parsedCreatedAt;
  const messageId = String(result?.id || `optimistic-${accountId}-${createdAt.getTime()}`);

  try {
    await withTimeout(
      messageRepo.upsertConversation({
        id: conversationId,
        accountId,
        externalId: rawChatId && rawChatId !== 'new' ? normalizeThreadId(accountId, rawChatId) : null,
        threadUrl: rawChatId && rawChatId !== 'new'
          ? `https://www.linkedin.com/messaging/thread/${normalizeThreadId(accountId, rawChatId)}/`
          : null,
        participantName: resolvedParticipantName,
        participantProfileUrl,
        participantAvatarUrl: null,
        lastMessageAt: createdAt,
        lastMessageText: text,
        lastMessageSentByMe: true,
      }),
      4000
    );

    await withTimeout(
      messageRepo.upsertMessage({
        conversationId,
        accountId,
        senderId: '__self__',
        senderName: accountId,
        text,
        sentAt: createdAt.toISOString(),
        isSentByMe: true,
        linkedinMessageId: messageId,
        externalId: messageId,
        source: 'optimistic',
      }),
      4000
    );
  } catch (err) {
    if (!isDatabaseUnavailable(err)) {
      console.warn('[send] Optimistic DB persistence failed:', err?.message || String(err));
    }
  }
}

async function buildUnifiedInboxFromLive(limit = 100) {
  const ids = await listKnownAccountIds();
  const proxyUrl = process.env.PROXY_URL || null;
  const perAccountLimit = Math.max(10, Math.ceil(limit / Math.max(ids.length, 1)) * 2);
  const conversations = [];
  const sessionFailures = [];

  for (const accountId of ids) {
    try {
      const inbox = await withTimeout(
        readMessages({ accountId, limit: perAccountLimit, proxyUrl }),
        30_000,
        'READ_INBOX_TIMEOUT'
      );
      for (const item of inbox?.items || []) {
        conversations.push(normalizeConversationFromInboxItem(accountId, item));
      }
    } catch (err) {
      const code = err?.code;
      if (code === 'NO_SESSION' || code === 'SESSION_EXPIRED') {
        sessionFailures.push({ accountId, code });
      } else if (code !== 'READ_INBOX_TIMEOUT') {
        console.warn(`[Inbox] Live read failed for ${accountId}:`, err?.message || String(err));
      }
    }
  }

  return {
    conversations: dedupeAndSortConversations(conversations).slice(0, limit),
    sessionFailures,
    attemptedAccounts: ids.length,
  };
}

async function buildUnifiedInboxWithFallback(limit = 100) {
  const now = Date.now();
  if (unifiedInboxCache.expiresAt > now) {
    return { conversations: unifiedInboxCache.payload.conversations.slice(0, limit) };
  }

  if (unifiedInboxInFlight) {
    const payload = await unifiedInboxInFlight;
    return { conversations: payload.conversations.slice(0, limit) };
  }

  unifiedInboxInFlight = (async () => {
    const activityPayload = await buildUnifiedInboxFromActivity(limit);
    let combined = activityPayload.conversations;
    let liveMeta = { sessionFailures: [], attemptedAccounts: 0 };

    if (combined.length < limit) {
      const livePayload = await buildUnifiedInboxFromLive(limit);
      liveMeta = {
        sessionFailures: livePayload.sessionFailures || [],
        attemptedAccounts: livePayload.attemptedAccounts || 0,
      };
      combined = dedupeAndSortConversations([...combined, ...livePayload.conversations]);
    } else {
      combined = dedupeAndSortConversations(combined);
    }

    if (
      combined.length === 0 &&
      liveMeta.attemptedAccounts > 0 &&
      liveMeta.sessionFailures.length === liveMeta.attemptedAccounts
    ) {
      const err = new Error('All LinkedIn sessions are missing or expired. Re-import cookies for each account.');
      err.status = 401;
      err.code = 'NO_ACTIVE_SESSION';
      throw err;
    }

    const payload = { conversations: combined.slice(0, limit) };
    unifiedInboxCache = {
      expiresAt: Date.now() + UNIFIED_INBOX_CACHE_TTL_MS,
      payload,
    };
    return payload;
  })();

  try {
    const payload = await unifiedInboxInFlight;
    return { conversations: payload.conversations.slice(0, limit) };
  } finally {
    unifiedInboxInFlight = null;
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// â”€â”€ All routes below require API key â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.use(requireApiKey);

const { getRedis } = require('./redisClient');
const { cleanupContext, getAllBrowserBudgetSnapshots, getBrowserBudgetSnapshot } = require('./browser');
const { getSyncPosture, isBlockedPosture } = require('./syncPosture');

// Unipile-shaped REST facade (provider-agnostic API over the Voyager engine).
// Mounted under /api/v1 — same auth as every other route.
try {
  const { createUnipileRouter } = require('./api/unipileRoutes');
  const { checkAndIncrement } = require('./rateLimit');
  app.use('/api/v1', createUnipileRouter({ listKnownAccountIds, getSyncPosture, checkAndIncrement }));
  console.log('[API] Unipile-shaped facade mounted at /api/v1');
} catch (err) {
  console.warn('[API] Unipile facade not mounted:', err.message);
}
const RESTRICTED_ACTION_POSTURES = new Set(['automation_warning', 'blocked', 'expired', 'checkpoint']);
const accountRepo = require('./db/repositories/AccountRepository');
const exportRoutes = require('./routes/export');
const { syncAccount, syncAllAccounts } = require('./services/messageSyncService');
const unifiedRepo = require('./db/repositories/UnifiedRepository');
const {
  syncAccountUnified,
  syncAllUnifiedAccounts,
  queueUnifiedSync,
  resolveConversationThreads,
  queueThreadResolution,
} = require('./unified/SyncOrchestrator');

// Mount export routes
app.use('/export', exportRoutes);

// POST /sync/messages - Manual message sync trigger
app.post('/sync/messages', async (req, res) => {
  try {
    const { accountId } = req.body;
    const proxyUrl = process.env.PROXY_URL || null;

    console.log('[API] Manual sync triggered', accountId ? `for account ${accountId}` : 'for all accounts');

    // Trigger sync in background (don't wait for completion)
    if (accountId) {
      syncAccount(accountId, proxyUrl)
        .then(stats => console.log('[API] Manual sync completed:', stats))
        .catch(err => console.error('[API] Manual sync failed:', err));
      
      res.json({ 
        success: true, 
        message: `Sync started for account ${accountId}`,
        accountId,
      });
    } else {
      syncAllAccounts(proxyUrl)
        .then(stats => console.log('[API] Manual sync completed:', stats))
        .catch(err => console.error('[API] Manual sync failed:', err));
      
      res.json({ 
        success: true, 
        message: 'Sync started for all accounts',
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /accounts
app.get('/accounts', async (_req, res) => {
  try {
    const ids = new Set(await listKnownAccountIds());
    const dbAccountsById = new Map();

    try {
      const dbAccounts = await withTimeout(accountRepo.getAllAccounts(), 4000);
      for (const acc of dbAccounts) {
        if (acc?.id) {
          ids.add(acc.id);
          dbAccountsById.set(acc.id, acc);
        }
      }
    } catch (dbErr) {
      if (!isDatabaseUnavailable(dbErr)) {
        console.warn('[Accounts] Could not read account list from database:', dbErr.message);
      }
    }

    const accounts = await Promise.all(
      Array.from(ids).sort((a, b) => a.localeCompare(b)).map(async (id) => {
        const meta = await sessionMeta(id).catch(() => null);
        const dbAccount = dbAccountsById.get(id);
        const liveReachability = deriveLiveReachability(dbAccount, meta);
        return {
          id,
          displayName: dbAccount?.displayName || id,
          isActive: Boolean(meta) && liveReachability === 'reachable',
          lastSeen: meta?.savedAt ?? null,
          verifiedAt: dbAccount?.verifiedAt ?? null,
          sessionStatus: dbAccount?.sessionStatus || (meta ? 'connected' : 'disconnected'),
          lastSessionSavedAt: dbAccount?.lastSessionSavedAt ?? (meta?.savedAt ?? null),
          liveReachability,
          liveReachabilityAt: dbAccount?.liveReachabilityAt ?? null,
          liveReachabilityUrl: dbAccount?.liveReachabilityUrl ?? null,
        };
      })
    );

    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// POST /accounts/:accountId/session
app.post('/accounts/:accountId/session', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    await cleanupContext(accountId).catch(() => {});
    const cookies = req.body;
    if (!Array.isArray(cookies) || cookies.length === 0 || !cookies.every(c => c && typeof c === 'object' && !Array.isArray(c))) {
      return res.status(400).json({ error: 'Body must be a non-empty array of valid cookie objects' });
    }
    if (!hasRequiredLinkedInSessionCookies(cookies)) {
      return res.status(400).json({
        error: `Required LinkedIn cookies (li_at/JSESSIONID) are missing for account ${accountId}. Re-import cookies.`,
        code: 'COOKIES_MISSING',
      });
    }
    await saveCookies(accountId, cookies, { requireAuthCookies: true, source: 'api-import' });
    try {
      await withTimeout(accountRepo.upsertAccount(accountId, accountId, {
        lastSessionSavedAt: new Date(),
        sessionStatus: 'connected',
        liveReachability: 'unknown',
        liveReachabilityAt: new Date(),
        liveReachabilityUrl: null,
      }), 4000);
    } catch (dbErr) {
      if (!isDatabaseUnavailable(dbErr)) {
        console.warn('[Session Import] Failed to upsert account in database:', dbErr.message);
      }
    }
    invalidateUnifiedViewCaches();
    res.json({ success: true, accountId, cookieCount: cookies.length });
  } catch (err) {
    console.error('[Session Import]', err.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// GET /accounts/:accountId/session/status
app.get('/accounts/:accountId/session/status', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const meta = await sessionMeta(accountId);
    if (!meta) return res.status(404).json({ exists: false });
    res.json({ exists: true, ...meta });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// DELETE /accounts/:accountId/session
app.delete('/accounts/:accountId/session', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    await cleanupContext(accountId).catch(() => {});
    await deleteSession(accountId);
    await accountRepo.updateSessionState(accountId, {
      sessionStatus: 'disconnected',
      liveReachability: 'missing_session',
      liveReachabilityAt: new Date(),
      liveReachabilityUrl: null,
    }).catch(() => {});
    invalidateUnifiedViewCaches();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// Admin: clear sync-block state for an account so it can resume immediately.
// Wipes the syncPosture entry and the antiBan circuit breaker (surface + account
// cooldowns + failure counters). Does NOT delete the session — use this when an
// account was flagged but you have reason to retry (e.g. after a proxy change).
//
//   POST /accounts/:accountId/clear-block          → clears all surfaces
//   POST /accounts/:accountId/clear-block?surface=connections  → narrows
app.post('/accounts/:accountId/clear-block', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const surface = (req.query.surface || req.body?.surface || '').trim() || null;

    const { clearSyncPosture } = require('./syncPosture');
    const { clearAccountCooldown } = require('./antiBan');

    const tasks = [
      clearSyncPosture(accountId, surface ? `Manual clear (surface=${surface})` : 'Manual clear').catch(() => null),
      clearAccountCooldown(accountId).catch(() => null),
    ];
    // Best-effort cache invalidation so the dashboard reflects new state.
    try {
      const { invalidateAccountCaches } = require('./unifiedCache');
      tasks.push(invalidateAccountCaches(accountId).catch(() => null));
    } catch { /* unifiedCache optional */ }
    await Promise.all(tasks);

    res.json({
      ok: true,
      accountId,
      surface: surface || 'all',
      message: 'Cleared sync posture and circuit breaker. The account will retry on next scheduled sync.',
      hint: 'If the underlying ban cause (datacenter IP, missing proxy) is unchanged, the block will recur.',
    });
  } catch (err) {
    res.status(500).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message,
    });
  }
});

// Proxy pool status + on-demand health refresh.
app.get('/proxy-pool', async (_req, res) => {
  try {
    const pool = require('./proxy/proxyPool');
    res.json(await pool.stats());
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});
app.post('/proxy-pool/refresh', async (_req, res) => {
  try {
    const pool = require('./proxy/proxyPool');
    const result = await pool.refresh();
    res.json({ ok: true, ...result, ...(await pool.stats()) });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// Harvest (slow full-sync) state + controls.
app.get('/accounts/:accountId/harvest', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const harvestState = require('./harvest/harvestState');
    const states = await harvestState.getAll(accountId);
    res.json({ accountId, surfaces: states });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

app.post('/accounts/:accountId/harvest/reset', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const surface = (req.query.surface || req.body?.surface || '').trim();
    const harvestState = require('./harvest/harvestState');
    if (surface) {
      await harvestState.reset(accountId, surface);
    } else {
      await Promise.all(harvestState.SURFACES.map((s) => harvestState.reset(accountId, s)));
    }
    res.json({ ok: true, accountId, surface: surface || 'all', message: 'Harvest cursor(s) reset; will re-backfill from start.' });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// Credential status (NEVER returns the password). Indicates whether stored
// credentials exist for an account, when they were captured/last used, and
// whether the stored password is marked stale (last auto-relogin returned
// wrong-password).
app.get('/accounts/:accountId/credentials', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const credentialStore = require('./auth/credentialStore');
    const status = await credentialStore.status(accountId);
    res.json({ accountId, ...status });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// Revoke / forget stored credentials. One-click revocation.
app.delete('/accounts/:accountId/credentials', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const credentialStore = require('./auth/credentialStore');
    await credentialStore.remove(accountId);
    res.json({ ok: true, accountId, message: 'Stored credentials removed.' });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// Trigger an auto-relogin on demand (respects all autoLogin guardrails — refuses
// without a proxy, frequency caps, recent-block cooldown).
app.post('/accounts/:accountId/auto-relogin', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const autoLogin = require('./auth/autoLogin');
    const result = await autoLogin.run(accountId);
    res.status(result.ok ? 200 : 409).json({ accountId, ...result });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

app.delete('/accounts/:accountId', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    await cleanupContext(accountId).catch(() => {});
    await deleteSession(accountId).catch(() => {});
    // Wipe stored credentials too — deleting an account must not leave
    // encrypted creds behind.
    try {
      const credentialStore = require('./auth/credentialStore');
      await credentialStore.remove(accountId).catch(() => null);
    } catch { /* module load failure is harmless */ }
    try {
      await withTimeout(accountRepo.deleteAccount(accountId), 4000);
    } catch (err) {
      if (err?.code !== 'P2025') {
        throw err;
      }
    }
    invalidateUnifiedViewCaches();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message,
    });
  }
});

app.post('/accounts/connect/start', async (req, res) => {
  try {
    const requestedAccountId = validateId(req.body?.accountId, { field: 'accountId' });
    const accountId = await resolveCanonicalAccountId(requestedAccountId);
    const proxyUrl = process.env.PROXY_URL || null;
    const session = await createConnectSession(accountId);

    try {
      await getConnectQueue().add('startLinkedInConnectSession', {
        connectId: session.connectId,
        accountId,
        proxyUrl,
      }, {
        jobId: `connect-${session.connectId}`,
        attempts: 1,
        removeOnComplete: { age: 3600, count: 50 },
        removeOnFail: { age: 86400, count: 100 },
      });
    } catch (queueErr) {
      console.warn('[Connect] Queue unavailable, falling back to direct async connect:', queueErr.message);
      Promise.resolve()
        .then(() => startLinkedInConnectSession({
          connectId: session.connectId,
          accountId,
          proxyUrl,
        }))
        .catch((err) => console.error('[Connect] Direct connect session failed:', err.message));
    }

    res.status(202).json({
      connectId: session.connectId,
      accountId,
      status: session.status,
      loginUrl: session.loginUrl,
      browserUrl: session.browserUrl || null,
    });
  } catch (err) {
    res.status(err.status || 400).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

app.get('/accounts/connect/:connectId/status', async (req, res) => {
  try {
    const connectId = sanitizeText(req.params.connectId, { maxLength: 128 });
    const session = await getConnectSession(connectId);
    if (!session) {
      return res.status(404).json({ error: 'Connect session not found' });
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

// GET /accounts/:accountId/limits
app.get('/accounts/:accountId/limits', async (req, res) => {
  try {
    const accountId = validateId(req.params.accountId, { field: 'accountId' });
    const limits = await getLimits(accountId);
    res.json(limits);
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

// â”€â”€ Job helper (local only â€” NOT exported) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runJob(name, data, timeoutMs = 120_000) {
  const runDirectly = process.env.DIRECT_EXECUTION === '1' || process.env.DISABLE_QUEUE === '1';
  const resolvedData = { ...(data || {}) };
  if (resolvedData.accountId && resolvedData.accountId !== 'default' && resolvedData.accountId !== 'connect') {
    resolvedData.accountId = await resolveCanonicalAccountId(resolvedData.accountId);
  }
  const restrictedJobs = new Set(['sendMessage', 'sendMessageNew', 'sendConnectionRequest', 'searchPeople']);
  if (restrictedJobs.has(name) && resolvedData.accountId) {
    const posture = await getSyncPosture(resolvedData.accountId).catch(() => ({ posture: 'healthy' }));
    if (RESTRICTED_ACTION_POSTURES.has(String(posture?.posture || 'healthy'))) {
      const blockedErr = new Error(
        posture?.posture === 'automation_warning'
          ? `LinkedIn flagged automation risk for account ${resolvedData.accountId}. Reconnect and verify manually before sending or searching again.`
          : `LinkedIn session for account ${resolvedData.accountId} is currently ${posture?.posture || 'blocked'}. Reconnect before sending or searching again.`
      );
      blockedErr.status = 409;
      blockedErr.code = posture?.posture === 'automation_warning' ? 'AUTOMATION_WARNING' : 'SESSION_RESTRICTED';
      throw blockedErr;
    }
  }

  // Anti-ban circuit breaker: even user-triggered write/search actions must honor
  // an active account cooldown or surface block (otherwise the breaker only ever
  // gated the background sync). Business hours are intentionally NOT enforced here
  // so manual actions still work at any time. Fails open on infra errors.
  if (restrictedJobs.has(name) && resolvedData.accountId) {
    try {
      const { gateAction } = require('./antiBan');
      const surface = name === 'sendConnectionRequest' ? 'invitations'
        : name === 'searchPeople' ? 'search'
        : 'messaging';
      const gate = await gateAction({
        accountId: resolvedData.accountId,
        surface,
        enforceBusinessHours: false,
      });
      if (!gate.allowed && (gate.reason === 'account_cooldown' || gate.reason === 'surface_blocked')) {
        const err = new Error(
          `Account ${resolvedData.accountId} is in an anti-ban ${gate.reason}; retry after ${gate.retryAfterSeconds || 0}s.`
        );
        err.status = 429;
        err.code = 'ANTIBAN_COOLDOWN';
        err.retryAfterSeconds = gate.retryAfterSeconds || null;
        throw err;
      }
    } catch (gateErr) {
      if (gateErr && gateErr.code === 'ANTIBAN_COOLDOWN') throw gateErr;
      // Any other error (Redis unavailable, etc.) must not block the action.
    }
  }

  if (runDirectly) {
    return runDirectJob(name, resolvedData);
  }

  const accountId   = resolvedData.accountId || 'default';
  await ensureAccountWorkers([accountId]).catch(() => {});
  const queue       = getQueue(accountId);
  const queueEvents = getQueueEvents(accountId);
  const nonIdempotentJobs = new Set(['sendMessage', 'sendMessageNew', 'sendConnectionRequest']);
  const dedupeWindowJobs = new Set(['messageSync']);

  const toQueueUnavailableError = (originalErr) => {
    const msg = originalErr instanceof Error ? originalErr.message : String(originalErr);
    const err = new Error('Background queue unavailable. Start Redis and retry.');
    err.status = 503;
    err.code = 'QUEUE_UNAVAILABLE';
    err.cause = msg;
    return err;
  };

  const isQueueConnectivityError = (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('Connection is closed') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('getaddrinfo')
    );
  };
  
  // Only dedupe periodic background jobs.
  // Verify/send/read jobs must always run fresh so cookie or UI state changes are honored immediately.
  // BullMQ forbids ':' in custom job ids — use '_' separators (accountId can be
  // canonical and contain ':').
  const jobId = dedupeWindowJobs.has(name)
    ? `${name}_${String(accountId).replace(/:/g, '_')}_${Math.floor(Date.now() / 30_000)}`
    : undefined;

  let job;
  try {
    const retryOptions = nonIdempotentJobs.has(name)
      ? { attempts: 1 }
      : {
          // Retry once with exponential backoff (5 s, then 10 s).
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
        };

    job = await queue.add(name, resolvedData, {
      ...(jobId ? { jobId } : {}),
      // Bounded job retention so Redis doesn't accumulate gigabytes of job history.
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
      ...retryOptions,
    });
  } catch (err) {
    if (isQueueConnectivityError(err)) throw toQueueUnavailableError(err);
    throw err;
  }

  try {
    return await job.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    if (isQueueConnectivityError(err)) throw toQueueUnavailableError(err);

    if (err.message && err.message.includes('timed out')) {
      await job.remove().catch(() => {});
      const toErr    = new Error(`Job ${name} timed out after ${timeoutMs}ms`);
      toErr.status   = 504;
      throw toErr;
    }
    const reason = String(job.failedReason || err?.message || 'Job failed');
    const lowerReason = reason.toLowerCase();
    const failErr  = new Error(reason);

    // Preserve explicit codes if available.
    failErr.code = err?.code || job?.failedReasonCode || undefined;
    failErr.status = err?.status || 500;

    // BullMQ often stores only failedReason (message string), so infer safe codes.
    if (!failErr.code) {
      if (
        reason.includes('CHECKPOINT_INCOMPLETE') ||
        lowerReason.includes('checkpoint/challenge is still pending')
      ) {
        failErr.code = 'CHECKPOINT_INCOMPLETE';
        failErr.status = 401;
      } else if (reason.includes('LOGIN_NOT_FINISHED') || lowerReason.includes('login is not fully completed')) {
        failErr.code = 'LOGIN_NOT_FINISHED';
        failErr.status = 401;
      } else if (reason.includes('COOKIES_MISSING') || lowerReason.includes('li_at/jsessionid')) {
        failErr.code = 'COOKIES_MISSING';
        failErr.status = 401;
      } else if (reason.includes('AUTHENTICATED_STATE_NOT_REACHED') || lowerReason.includes('authenticated linkedin member state was not reached')) {
        failErr.code = 'AUTHENTICATED_STATE_NOT_REACHED';
        failErr.status = 401;
      } else if (reason.includes('Session expired for account')) {
        failErr.code = 'SESSION_EXPIRED';
        failErr.status = 401;
      } else if (reason.includes('No session for account')) {
        failErr.code = 'NO_SESSION';
        failErr.status = 401;
      } else if (reason.includes('All LinkedIn sessions are missing or expired')) {
        failErr.code = 'NO_ACTIVE_SESSION';
        failErr.status = 401;
      } else if (
        lowerReason.includes('could not open message composer from profile') ||
        lowerReason.includes('not_messageable') ||
        lowerReason.includes('not messageable')
      ) {
        failErr.code = 'NOT_MESSAGEABLE';
        failErr.status = 400;
      } else if (
        reason.includes('Message send could not be confirmed in thread') ||
        reason.includes('Send clicked but LinkedIn thread ID was not resolved') ||
        reason.includes('Message was not found in thread after send confirmation')
      ) {
        failErr.code = 'SEND_NOT_CONFIRMED';
        failErr.status = 502;
      } else if (lowerReason.includes('operation failed')) {
        failErr.code = 'SEND_NOT_CONFIRMED';
        failErr.status = 502;
        failErr.message = 'LinkedIn UI transient failure while sending message. Please retry once with fresh cookies.';
      } else if (reason.includes('Daily limit reached:')) {
        failErr.code = 'RATE_LIMIT_EXCEEDED';
        failErr.status = 429;
      }
    }

    throw failErr;
  }
}

async function runDirectJob(name, data) {
  switch (name) {
    case 'verifySession':
      return verifySession(data);
    case 'startLinkedInConnectSession':
      return startLinkedInConnectSession(data);
    case 'readMessages':
      return readMessages(data);
    case 'readThread':
      return readThread(data);
    case 'sendMessage':
      return sendMessage(data);
    case 'sendMessageNew':
      return sendMessageNew(data);
    case 'sendConnectionRequest':
      return sendConnectionRequest(data);
    case 'searchPeople':
      return searchPeople(data);
    case 'messageSync':
      return syncAllAccounts(data.proxyUrl);
    case 'threadResolve':
      return resolveConversationThreads(data.accountId || 'default', data);
    default:
      throw new Error(`Unknown job type: ${name}`);
  }
}

// â”€â”€ LinkedIn action endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/accounts/:accountId/verify', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(validateId(req.params.accountId, { field: 'accountId' }));
    const proxyUrl = process.env.PROXY_URL || null;

    // Local dev mode: bypass BullMQ queue so verification can run without Redis.
    const useDirectVerify = process.env.DIRECT_VERIFY === '1' || process.env.DISABLE_MESSAGE_SYNC === '1';
    let result;
    if (useDirectVerify) {
      result = await verifySession({ accountId, proxyUrl });
    } else {
      try {
        result = await runJob('verifySession', { accountId, proxyUrl });
      } catch (queueErr) {
        const msg = queueErr instanceof Error ? queueErr.message : String(queueErr);
        const isRedisConnectivityError =
          msg.includes('Connection is closed') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ENOTFOUND') ||
          msg.includes('getaddrinfo');

        if (!isRedisConnectivityError) throw queueErr;

        console.warn('[Verify] Queue unavailable, falling back to direct verification:', msg);
        result = await verifySession({ accountId, proxyUrl });
      }
    }

    if (result?.ok) {
      await accountRepo.upsertAccount(accountId, accountId, {
        verifiedAt: new Date(),
        sessionStatus: 'connected',
        liveReachability: result.liveReachability || 'reachable',
        liveReachabilityAt: new Date(),
        liveReachabilityUrl: result.url || null,
      }).catch(() => {});
    }

    res.json(result);
  } catch (err) {
    const status = err.status || (err.message ? 400 : 500);
    res.status(status).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

app.get('/messages/inbox', async (req, res) => {
  try {
    const accountId = validateId(req.query.accountId, { field: 'accountId' });
    const limit     = parseLimit(req.query.limit, 20);
    const result    = await runJob('readMessages', {
      accountId, limit, proxyUrl: process.env.PROXY_URL || null,
    });
    res.json(result);
  } catch (err) {
    console.error('[Thread] messages/thread failed:', err);
    const status = err.status || (err.message ? 400 : 500);
    res.status(status).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

// GET /messages/thread â€” Query thread messages from database
app.get('/messages/thread', async (req, res) => {
  const startedAt = Date.now();
  try {
    const messageRepo = require('./db/repositories/MessageRepository');
    const accountId = await resolveCanonicalAccountId(validateId(req.query.accountId, { field: 'accountId' }));
    const chatId    = validateId(req.query.chatId,    { field: 'chatId' });
    const normalizedChatId = normalizeThreadId(accountId, chatId);
    const limit     = parseLimit(req.query.limit, 100);
    const cursor = req.query.cursor
      ? JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'))
      : null;
    const cacheParts = {
      scopes: ['global', `account:${accountId}`, `thread:${chatId}`],
      accountId,
      chatId,
      normalizedChatId,
      limit,
      cursor,
    };
    const cached = await getCachedJson('thread', cacheParts);
    if (cached) {
      return res.json(cached);
    }
    const conversationRecord = await messageRepo.getConversationById(chatId).catch(() => null)
      || (normalizedChatId !== chatId ? await messageRepo.getConversationById(normalizedChatId).catch(() => null) : null);

    let dbPage = { items: [], hasMore: false, nextCursor: null };
    try {
      dbPage = await withTimeout(
        messageRepo.getMessagesPageByConversation(chatId, { limit, cursor }),
        4000
      );

      // Support prefixed IDs from unified fallback (accountId:rawChatId).
      if (dbPage.items.length === 0 && normalizedChatId !== chatId) {
        dbPage = await withTimeout(
          messageRepo.getMessagesPageByConversation(normalizedChatId, { limit, cursor }),
          4000
        );
      }
    } catch (dbErr) {
      if (!isDatabaseUnavailable(dbErr)) throw dbErr;
    }

    if (dbPage.items.length > 0) {
      const items = mapDbMessagesToApiItems(dbPage.items);
      const participantName = deriveParticipantNameFromItems(
        items,
        await resolveConversationParticipantName(messageRepo, conversationRecord || { id: normalizedChatId, participantName: null, participantProfileUrl: null, lastMessageText: null })
      );
      const payload = {
        items,
        participant: {
          name: participantName,
          profileUrl: conversationRecord?.participantProfileUrl || '',
        },
        cursor: dbPage.nextCursor
          ? Buffer.from(JSON.stringify(dbPage.nextCursor)).toString('base64url')
          : null,
        hasMore: dbPage.hasMore,
        source: 'db',
        stale: false,
        resolutionState: conversationRecord?.resolutionState || conversationRecord?.syncState || 'available',
      };
      await setCachedJson('thread', cacheParts, payload, 20);
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 800) {
        console.info(`[ApiPerf] GET /messages/thread ${accountId}:${chatId} completed in ${durationMs}ms`);
      }
      return res.json(payload);
    }
    const participantName = await resolveConversationParticipantName(
      messageRepo,
      conversationRecord || { id: normalizedChatId, participantName: null, participantProfileUrl: null, lastMessageText: null }
    );

    // ANTI-BAN: skip the live browser fallback entirely when the account is in a
    // blocked posture. Otherwise every thread open fires a page.goto that just
    // hits ERR_TOO_MANY_REDIRECTS / authwall, burning redirect attempts against
    // an already-flagged IP and deepening the block. Serve DB-only instead.
    const livePosture = await getSyncPosture(accountId).catch(() => ({ posture: 'healthy' }));
    const liveFallbackAllowed = !isBlockedPosture(livePosture.posture);

    if (!cursor && liveFallbackAllowed) {
      try {
        const { normalizeMessage } = require('./unified/normalizer');
        const liveResult = await readThread({
          accountId,
          chatId: normalizedChatId,
          threadUrl: conversationRecord?.threadUrl || null,
          participantName,
          participantProfileUrl: conversationRecord?.participantProfileUrl || null,
          proxyUrl: process.env.PROXY_URL || null,
          limit,
        });

        const liveItems = Array.isArray(liveResult?.items) ? liveResult.items : [];
        const resolvedExternalId = normalizeThreadId(accountId, liveResult?.resolvedChatId || normalizedChatId);
        const targetConversationId = ensureConversationId(accountId, resolvedExternalId);

        if (liveItems.length > 0 && targetConversationId) {
          const normalizedMessages = liveItems.map((item) => (
            normalizeMessage(accountId, targetConversationId, item)
          ));
          const latestMessage = normalizedMessages.reduce((latest, current) => {
            if (!latest) return current;
            return new Date(current.sentAt).getTime() >= new Date(latest.sentAt).getTime()
              ? current
              : latest;
          }, null);
          const resolvedParticipantName = liveResult?.participant?.name && liveResult.participant.name !== 'Unknown'
            ? liveResult.participant.name
            : deriveParticipantNameFromItems(liveItems, participantName);
          const resolvedProfileUrl = liveResult?.participant?.profileUrl
            || conversationRecord?.participantProfileUrl
            || '';

          await messageRepo.upsertConversation({
            id: targetConversationId,
            accountId,
            externalId: resolvedExternalId,
            threadUrl: liveResult?.threadUrl || conversationRecord?.threadUrl || null,
            participantName: resolvedParticipantName,
            participantProfileUrl: resolvedProfileUrl || null,
            participantAvatarUrl: conversationRecord?.participantAvatarUrl || null,
            lastMessageAt: latestMessage?.sentAt ? new Date(latestMessage.sentAt) : (conversationRecord?.lastMessageAt || new Date()),
            lastMessageText: latestMessage?.text || conversationRecord?.lastMessageText || '',
            lastMessageSentByMe: Boolean(latestMessage?.isSentByMe ?? conversationRecord?.lastMessageSentByMe),
            syncState: 'available',
            resolutionState: 'available',
            messageCount: normalizedMessages.length,
            messageCountCanonical: normalizedMessages.filter((message) => message.visibilityState === 'visible').length,
            lastResolvedAt: new Date(),
            resolveAttempts: conversationRecord?.resolveAttempts || 0,
            resolveError: null,
            shellReason: null,
            replacedByConversationId: null,
            hiddenReason: null,
            syncCursor: liveResult?.cursor || conversationRecord?.syncCursor || null,
            hasMoreHistory: Boolean(liveResult?.hasMore),
          });

          for (const message of normalizedMessages) {
            await messageRepo.upsertMessage(message);
          }

          await messageRepo.refreshConversationStats(targetConversationId).catch(() => null);
          if (conversationRecord?.id && conversationRecord.id !== targetConversationId) {
            await messageRepo.mergeConversationInto(conversationRecord.id, targetConversationId).catch(() => null);
          }

          const refreshedPage = await withTimeout(
            messageRepo.getMessagesPageByConversation(targetConversationId, { limit, cursor: null }),
            4000
          ).catch(() => ({ items: [], hasMore: false, nextCursor: null }));

          if (refreshedPage.items.length > 0) {
            const refreshedItems = mapDbMessagesToApiItems(refreshedPage.items);
            const livePayload = {
              items: refreshedItems,
              participant: {
                name: deriveParticipantNameFromItems(refreshedItems, resolvedParticipantName),
                profileUrl: resolvedProfileUrl,
              },
              cursor: refreshedPage.nextCursor
                ? Buffer.from(JSON.stringify(refreshedPage.nextCursor)).toString('base64url')
                : null,
              hasMore: refreshedPage.hasMore,
              source: 'live',
              stale: false,
              resolutionState: 'available',
            };
            await invalidateAccountCaches(accountId, targetConversationId).catch(() => {});
            await setCachedJson('thread', cacheParts, livePayload, 20);
            const durationMs = Date.now() - startedAt;
            if (durationMs >= 800) {
              console.info(`[ApiPerf] GET /messages/thread ${accountId}:${chatId} completed in ${durationMs}ms (live fallback)`);
            }
            return res.json(livePayload);
          }
        }
      } catch (liveErr) {
        console.warn(`[thread] Live fallback failed for ${accountId}:${normalizedChatId}: ${liveErr?.message || String(liveErr)}`);
      }
    }

    const emptyPayload = {
      items: [],
      participant: {
        name: participantName,
        profileUrl: conversationRecord?.participantProfileUrl || '',
      },
      cursor: null,
      hasMore: false,
      source: 'db',
      stale: Boolean(conversationRecord),
      // Surface the block so the UI can show "reconnect required" instead of a
      // misleading empty thread when we deliberately skipped the live fallback.
      resolutionState: !liveFallbackAllowed
        ? 'blocked'
        : (conversationRecord?.resolutionState || conversationRecord?.syncState || 'shell_only'),
      ...(!liveFallbackAllowed ? { blocked: true, blockReason: livePosture.reason || 'Account session is blocked; reconnect required.' } : {}),
    };
    await setCachedJson('thread', cacheParts, emptyPayload, 10);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 800) {
      console.info(`[ApiPerf] GET /messages/thread ${accountId}:${chatId} completed in ${durationMs}ms`);
    }
    return res.json(emptyPayload);
  } catch (err) {
    const status = err.status || (err.message ? 400 : 500);
    res.status(status).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

app.post('/messages/send', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(
      validateId(req.body?.accountId, { field: 'accountId' })
    );
    const chatId    = validateId(req.body?.chatId,    { field: 'chatId' });
    const normalizedChatId = normalizeThreadId(accountId, chatId);
    const text      = sanitizeText(req.body?.text, { maxLength: 3000 });
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (normalizedChatId.startsWith('activity-')) {
      return res.status(400).json({
        error: 'This conversation is activity-only and cannot be replied yet. Run sync and retry.',
        code: 'THREAD_NOT_REPLYABLE',
      });
    }

    const result = await runJob('sendMessage', {
      accountId, chatId: normalizedChatId, text, proxyUrl: process.env.PROXY_URL || null,
    });
    await persistOptimisticSendResult({
      accountId,
      chatId: normalizedChatId,
      text,
      result,
    });
    await queueThreadResolution(accountId, {
      conversationIds: [ensureConversationId(accountId, normalizedChatId)],
      priority: 'visible',
      limit: 1,
      proxyUrl: process.env.PROXY_URL || null,
    }).catch(() => {});
    if (result?.deliveryState === 'accepted_unverified') {
      await queueUnifiedSync(accountId, {
        lane: 'delta',
        surfaces: ['inbox'],
        maxThreads: 1,
      }).catch(() => {});
    }
    await invalidateAccountCaches(accountId, ensureConversationId(accountId, normalizedChatId)).catch(() => {});
    if (!res.headersSent) {
      res.json(result);
    }
  } catch (err) {
    if (res.headersSent) return;
    const status = err.status || (err.message ? 400 : 500);
    res.status(status).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

app.post('/messages/send-new', async (req, res) => {
  try {
    const accountId  = await resolveCanonicalAccountId(
      validateId(req.body?.accountId, { field: 'accountId' })
    );
    const profileUrl = validateProfileUrl(req.body?.profileUrl);
    const text       = sanitizeText(req.body?.text, { maxLength: 3000 });
    if (!text) return res.status(400).json({ error: 'text is required' });

    let result;
    try {
      result = await runJob('sendMessageNew', {
        accountId, profileUrl, text, proxyUrl: process.env.PROXY_URL || null,
      });
    } catch (sendNewErr) {
      const reason = String(sendNewErr?.message || sendNewErr || '');

      // CRITICAL: SEND_NOT_CONFIRMED means the message was very likely delivered
      // but the thread id could not be resolved afterwards. Falling back to the
      // thread-send path here would deliver the SAME message a second time to the
      // prospect. Only fall back for unambiguous PRE-send failures.
      if (sendNewErr?.code === 'SEND_NOT_CONFIRMED') {
        console.warn(`[API] send-new not confirmed for ${accountId}; NOT re-sending to avoid a duplicate: ${reason}`);
        throw sendNewErr;
      }

      // Thread fallback helps when the profile composer flow fails BEFORE sending
      // but an existing thread works.
      console.warn(`[API] send-new failed for ${accountId}; trying thread fallback: ${reason}`);

      // Reset browser context before inbox fallback to avoid stale/half-closed sessions.
      await cleanupContext(accountId).catch(() => {});

      let inboxResult;
      try {
        inboxResult = await runJob('readMessages', {
          accountId,
          limit: 100,
          proxyUrl: process.env.PROXY_URL || null,
        });
      } catch (fallbackErr) {
        const fallbackReason = String(fallbackErr?.message || fallbackErr || '');
        console.warn(`[API] thread fallback inbox read failed for ${accountId}: ${fallbackReason}`);
        throw sendNewErr;
      }

      const normalizedTarget = normalizeProfileUrlForCompare(profileUrl);
      const matchedConversation = (inboxResult?.items || []).find((item) => {
        const participantUrl = item?.participants?.[0]?.profileUrl || '';
        return (
          participantUrl &&
          normalizeProfileUrlForCompare(participantUrl) === normalizedTarget
        );
      });

      if (!matchedConversation?.id) throw sendNewErr;

      result = await runJob('sendMessage', {
        accountId,
        chatId: matchedConversation.id,
        text,
        proxyUrl: process.env.PROXY_URL || null,
      });
    }

    await persistOptimisticSendResult({
      accountId,
      profileUrl,
      text,
      result,
    });
    if (result?.chatId && result.chatId !== 'new') {
      await queueThreadResolution(accountId, {
        conversationIds: [ensureConversationId(accountId, normalizeThreadId(accountId, result.chatId))],
        priority: 'visible',
        limit: 1,
        proxyUrl: process.env.PROXY_URL || null,
      }).catch(() => {});
    } else {
      await queueUnifiedSync(accountId, {
        lane: 'delta',
        surfaces: ['inbox'],
        maxThreads: 1,
      }).catch(() => {});
    }
    await invalidateAccountCaches(accountId, null).catch(() => {});

    if (!res.headersSent) {
      res.json(result);
    }
  } catch (err) {
    if (res.headersSent) return;
    const status = err.status || (err.message ? 400 : 500);
    res.status(status).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

app.post('/connections/send', async (req, res) => {
  try {
    const accountId  = validateId(req.body?.accountId, { field: 'accountId' });
    const profileUrl = validateProfileUrl(req.body?.profileUrl);
    const note       = req.body?.note == null ? '' : sanitizeNote(req.body.note);

    const result = await runJob('sendConnectionRequest', {
      accountId, profileUrl, note, proxyUrl: process.env.PROXY_URL || null,
    }, 90000); // shorter timeout: 90s
    res.json(result);
  } catch (err) {
    const status = err.status || (err.message ? 400 : 500);
    res.status(status).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

// GET /inbox/unified â€” Query conversations from database (all accounts)
app.get('/connections/unified', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 300, 1000);
    const payload = await getUnifiedConnectionsWithCache(limit);
    res.json(payload);
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({
        error: toPublicOperationError(err),
        code: err.code,
      });
    }

    console.error('[API] Error fetching unified connections:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

app.get('/inbox/unified', async (req, res) => {
  try {
    const messageRepo = require('./db/repositories/MessageRepository');
    const limit = parseLimit(req.query.limit, 100, 200);
    const offset = parseInt(req.query.offset) || 0;

    // Query all conversations from database
    const conversations = await withTimeout(
      messageRepo.getAllConversations(limit, offset),
      4000
    );

    // Transform to match expected frontend format
    const payload = {
      conversations: await Promise.all(conversations.map(async (conv) => ({
        conversationId: conv.id,
        accountId: conv.accountId,
        participant: {
          name: await resolveConversationParticipantName(messageRepo, conv),
          profileUrl: conv.participantProfileUrl || '',
        },
        lastMessage: {
          text: conv.lastMessageText,
          sentAt: new Date(conv.lastMessageAt).getTime(),
          sentByMe: conv.lastMessageSentByMe,
        },
        unreadCount: 0, // We don't track unread in database yet
        messages: [],
      }))),
    };

    // Merge DB-backed conversations with recent activity so newly sent messages
    // show in the UI even before full thread sync catches up.
    const activityPayload = await buildUnifiedInboxFromActivity(limit);
    const mergedConversations = dedupeAndSortConversations([
      ...payload.conversations,
      ...(activityPayload?.conversations || []),
    ]).slice(0, limit);

    if (mergedConversations.length === 0) {
      const livePayload = await buildUnifiedInboxWithFallback(limit);
      return res.json(livePayload);
    }

    res.json({ conversations: mergedConversations });
  } catch (err) {
    if (isDatabaseUnavailable(err)) {
      try {
        const livePayload = await buildUnifiedInboxWithFallback(parseLimit(req.query.limit, 100, 200));
        return res.json(livePayload);
      } catch (fallbackErr) {
        if (fallbackErr?.status) {
          return res.status(fallbackErr.status).json({
            error: toPublicOperationError(fallbackErr),
            code: fallbackErr.code,
          });
        }
        console.error('[API] Error in fallback unified inbox:', fallbackErr);
        return res.status(500).json({
          error: process.env.NODE_ENV === 'production' ? 'Internal error' : fallbackErr.message,
        });
      }
    }

    if (err?.status) {
      return res.status(err.status).json({
        error: toPublicOperationError(err),
        code: err.code,
      });
    }

    console.error('[API] Error fetching unified inbox:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

app.get('/unified/accounts', async (_req, res) => {
  try {
    const [dbAccounts, sessionIds] = await Promise.all([
      unifiedRepo.listAccounts().catch(() => []),
      listKnownAccountIds().catch(() => []),
    ]);
    const byKey = new Map();
    for (const account of dbAccounts) {
      const key = String(account.id || '').trim().toLowerCase();
      if (!key) continue;
      byKey.set(key, account);
    }
    for (const id of dedupeAccountIds(sessionIds)) {
      const key = String(id || '').trim().toLowerCase();
      if (!key || byKey.has(key)) continue;
      byKey.set(key, { id, displayName: id, status: 'session_only' });
    }

    const accounts = await Promise.all(Array.from(byKey.values()).map(async (account) => {
      const canonicalId = await resolveCanonicalAccountId(account.id);
      const meta = await sessionMeta(canonicalId).catch(() => null);
      return {
        ...account,
        id: canonicalId,
        displayName: account.displayName || canonicalId,
        hasSession: Boolean(meta),
        sessionSavedAt: meta?.savedAt || null,
        verifiedAt: account.verifiedAt || null,
        lastSessionSavedAt: account.lastSessionSavedAt || meta?.savedAt || null,
        status: account.sessionStatus || account.status || (meta ? 'connected' : 'disconnected'),
      };
    }));

    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/inbox', async (req, res) => {
  const startedAt = Date.now();
  try {
    const messageRepo = require('./db/repositories/MessageRepository');
    const limit = parseLimit(req.query.limit, 100, 500);
    const accountId = req.query.accountId
      ? await resolveCanonicalAccountId(validateId(req.query.accountId, { field: 'accountId' }))
      : undefined;
    const state = sanitizeText(req.query.state || 'all', { maxLength: 32 });
    const q = sanitizeText(req.query.q || '', { maxLength: 255 });
    const cursor = req.query.cursor
      ? JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'))
      : null;
    const cacheParts = {
      scopes: ['global', 'inbox', ...(accountId ? [`account:${accountId}`, `inbox:${accountId}`] : [])],
      accountId: accountId || null,
      state,
      q,
      cursor,
      limit,
    };
    const cached = await getCachedJson('inbox', cacheParts);
    if (cached) {
      return res.json(cached);
    }
    const conversations = await messageRepo.getAllConversations({
      limit: (limit * 3) + 1,
      cursor,
      accountId,
      state,
      search: q,
    });

    const qualityScore = (conv) => {
      const externalId = String(conv.externalId || '');
      const normalizedName = normalizeWhitespace(conv.participantName || '').toLowerCase();
      let score = 0;
      if (conv.participantProfileUrl) score += 50;
      if (conv.threadUrl) score += 25;
      if (conv.lastMessageText) score += 25;
      if (!externalId.startsWith('fallback-')) score += 15;
      if (conv.syncState === 'available') score += 10;
      if ((conv._count?.messages || conv.messageCount || 0) > 0) score += 20;
      if (conv.lastMessageAt) score += 5;
      if (conv.replacedByConversationId || conv.hiddenReason === 'replaced') score -= 200;
      if (['messaging', 'unknown', 'linkedin'].includes(normalizedName)) score -= 40;
      if (typeof conv.sourceQuality === 'number') score += conv.sourceQuality;
      return score;
    };

    const dedupedByParticipant = new Map();
    for (const conv of conversations) {
      if (conv.replacedByConversationId || conv.hiddenReason === 'replaced') {
        continue;
      }
      const participantKey = String(conv.participantProfileUrl || '').trim().toLowerCase();
      const externalKey = String(conv.externalId || '').trim().toLowerCase();
      const key = [
        String(conv.accountId || '').trim().toLowerCase(),
        participantKey || externalKey || String(conv.id || '').trim().toLowerCase(),
      ].join('|');
      const previous = dedupedByParticipant.get(key);
      if (!previous || qualityScore(conv) > qualityScore(previous)) {
        dedupedByParticipant.set(key, conv);
      }
    }

    const selectedRows = Array.from(dedupedByParticipant.values()).sort((a, b) => {
      const aTs = new Date(a.lastMessageAt).getTime();
      const bTs = new Date(b.lastMessageAt).getTime();
      if (bTs !== aTs) return bTs - aTs;
      return String(b.id).localeCompare(String(a.id));
    });
    const hasMore = selectedRows.length > limit;
    const pagedRows = selectedRows.slice(0, limit);

    const normalized = await Promise.all(pagedRows.map(async (conv) => {
      const messageCount = conv._count?.messages || conv.messageCount || 0;
      const messageCountCanonical = conv.messageCountCanonical || messageCount || 0;
      const shell = conv.syncState === 'shell_only'
        || String(conv.externalId || '').startsWith('fallback-')
        || (!conv.participantProfileUrl && !conv.lastMessageText);
      const participantName = await resolveConversationParticipantName(messageRepo, conv);
      return {
        id: conv.id,
        conversationId: conv.id,
        externalId: conv.externalId,
        accountId: conv.accountId,
        threadUrl: conv.threadUrl || null,
        participant: {
          name: participantName,
          profileUrl: conv.participantProfileUrl || '',
        },
        lastMessage: {
          text: conv.lastMessageText || '',
          sentAt: new Date(conv.lastMessageAt).getTime(),
          sentByMe: Boolean(conv.lastMessageSentByMe),
        },
        unreadCount: 0,
        messages: [],
        shell,
        syncState: conv.syncState || (shell ? 'shell_only' : 'available'),
        resolutionState: conv.resolutionState || conv.syncState || (shell ? 'shell_only' : 'available'),
        shellReason: conv.shellReason || conv.resolveError || (shell ? 'LinkedIn exposed this row before the worker could resolve a concrete thread.' : null),
        messageCount: messageCountCanonical,
        messageCountCanonical,
        lastResolvedAt: conv.lastResolvedAt || null,
        resolveAttempts: conv.resolveAttempts || 0,
        sourceQuality: typeof conv.sourceQuality === 'number' ? conv.sourceQuality : qualityScore(conv),
      };
    }));

    const nextRow = pagedRows[pagedRows.length - 1];
    const nextCursor = hasMore && nextRow
      ? Buffer.from(JSON.stringify({
        id: nextRow.id,
        lastMessageAt: new Date(nextRow.lastMessageAt).toISOString(),
      })).toString('base64url')
      : null;

    const payload = {
      conversations: normalized,
      nextCursor,
      hasMore,
      stale: false,
      source: 'db',
    };
    await setCachedJson('inbox', cacheParts, payload, 15);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 800) {
      console.info(`[ApiPerf] GET /unified/inbox ${accountId || 'all'} completed in ${durationMs}ms`);
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.post('/unified/thread-resolution', async (req, res) => {
  try {
    const accountId = req.body?.accountId
      ? await resolveCanonicalAccountId(validateId(req.body.accountId, { field: 'accountId' }))
      : null;
    const conversationIds = Array.isArray(req.body?.conversationIds)
      ? req.body.conversationIds.map((id) => validateId(id, { field: 'conversationId', max: 255 }))
      : [];
    const priority = sanitizeText(req.body?.priority || 'recent', { maxLength: 24 });
    const limit = parseLimit(req.body?.limit, priority === 'visible' ? 25 : 18);

    if (req.body?.wait === true && accountId) {
      const result = await resolveConversationThreads(accountId, {
        conversationIds,
        priority,
        limit,
        proxyUrl: process.env.PROXY_URL || null,
      });
      return res.json({ queued: false, ...result });
    }

    if (accountId) {
      await queueThreadResolution(accountId, {
        conversationIds,
        priority,
        limit,
        proxyUrl: process.env.PROXY_URL || null,
      });
      return res.json({ queued: true, accountId, count: conversationIds.length || limit });
    }

    const ids = dedupeAccountIds(await listKnownAccountIds());
    const outcomes = await Promise.all(ids.map(async (id) => {
      try {
        await queueThreadResolution(id, {
          priority,
          limit,
          proxyUrl: process.env.PROXY_URL || null,
        });
        return { accountId: id, queued: true };
      } catch (queueErr) {
        if (queueErr?.code === 'SYNC_BLOCKED') {
          return { accountId: id, queued: false, blocked: true, error: queueErr.message };
        }
        throw queueErr;
      }
    }));
    res.json({ queued: true, count: ids.length, outcomes });
  } catch (err) {
    console.error('[Worker] thread-resolution failed', {
      requestId: req.requestId,
      accountId: req.body?.accountId || null,
      conversationIds: Array.isArray(req.body?.conversationIds) ? req.body.conversationIds.length : 0,
      priority: req.body?.priority || null,
      error: err?.message || String(err),
      code: err?.code || null,
    });
    res.status(err.status || 500).json({
      error: toPublicOperationError(err),
      code: err.code,
      requestId: req.requestId,
    });
  }
});

app.get('/unified/chats/:id', async (req, res) => {
  try {
    const messageRepo = require('./db/repositories/MessageRepository');
    const id = validateId(req.params.id, { field: 'chat id', allowColon: true });
    const limit = parseLimit(req.query.limit, 100, 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const [conversation, messages] = await Promise.all([
      messageRepo.getConversationById(id),
      messageRepo.getMessagesByConversation(id, limit, offset),
    ]);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ conversation, messages });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/messages', async (req, res) => {
  try {
    const messageRepo = require('./db/repositories/MessageRepository');
    const limit = parseLimit(req.query.limit, 100, 1000);
    const offset = parseInt(req.query.offset || '0', 10);
    const messages = await messageRepo.getMessagesForExport({
      accountId: req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : undefined,
      conversationId: req.query.conversationId ? validateId(req.query.conversationId, { field: 'conversationId', allowColon: true }) : undefined,
      limit,
      offset,
    });
    res.json({ messages });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/profiles/:id', async (req, res) => {
  try {
    const profile = await unifiedRepo.getProfile(
      req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : null,
      req.params.id
    );
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/profiles', async (req, res) => {
  try {
    const profiles = await unifiedRepo.listProfiles({
      accountId: req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : undefined,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    res.json({ profiles });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/connections', async (req, res) => {
  try {
    const connections = await unifiedRepo.listConnections({
      accountId: req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : undefined,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    res.json({ connections });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/invitations', async (req, res) => {
  try {
    const invitations = await unifiedRepo.listInvitations({
      accountId: req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : undefined,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    res.json({ invitations });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/notifications', async (req, res) => {
  try {
    const notifications = await unifiedRepo.listNotifications({
      accountId: req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : undefined,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    res.json({ notifications });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/posts', async (req, res) => {
  try {
    const posts = await unifiedRepo.listPosts({
      accountId: req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : undefined,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    res.json({ posts });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/unified/sync-status', async (req, res) => {
  const startedAt = Date.now();
  try {
    const accountId = req.query.accountId ? validateId(req.query.accountId, { field: 'accountId' }) : undefined;
    const cacheParts = {
      scopes: ['global', 'sync-status', ...(accountId ? [`account:${accountId}`, `sync-status:${accountId}`] : [])],
      accountId: accountId || null,
    };
    const cached = await getCachedJson('sync-status', cacheParts);
    if (cached) {
      return res.json(cached);
    }
    const status = await unifiedRepo.listSyncStatus(accountId);
    const messageRepo = require('./db/repositories/MessageRepository');
    const threadResolution = await messageRepo.getThreadResolutionStats(accountId);
    const readMetric = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    };
    const inboxMetrics = (status.cursors || [])
      .filter((cursor) => cursor.surface === 'inbox')
      .reduce((acc, cursor) => {
        const metadata = cursor.metadata && typeof cursor.metadata === 'object' ? cursor.metadata : {};
        acc.threadsAttempted += readMetric(metadata.threadsAttempted);
        acc.threadsRefreshed += readMetric(metadata.threadsRefreshed);
        acc.threadFailures += readMetric(metadata.threadFailures);
        acc.browserRecycles += readMetric(metadata.browserRecycles);
        return acc;
      }, {
        threadsAttempted: 0,
        threadsRefreshed: 0,
        threadFailures: 0,
        browserRecycles: 0,
      });
    const accountIds = accountId
      ? [accountId]
      : dedupeAccountIds([
          ...status.cursors.map((cursor) => cursor.accountId),
          ...status.runs.map((run) => run.accountId),
          ...(await listKnownAccountIds().catch(() => [])),
        ]);
    const [postures, browser] = await Promise.all([
      Promise.all(accountIds.map(async (id) => ({
        accountId: id,
        ...(await getSyncPosture(id)),
      }))),
      Promise.resolve(accountId ? [getBrowserBudgetSnapshot(accountId)] : getAllBrowserBudgetSnapshots()),
    ]);
    const queueCounts = accountId
      ? await getQueue(accountId).getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed').catch(() => ({
          active: 0,
          waiting: 0,
          delayed: 0,
          failed: 0,
          completed: 0,
        }))
      : (await Promise.all(accountIds.map(async (id) => (
          getQueue(id).getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed').catch(() => ({
            active: 0,
            waiting: 0,
            delayed: 0,
            failed: 0,
            completed: 0,
          }))
        )))).reduce((acc, counts) => ({
          active: acc.active + (counts.active || 0),
          waiting: acc.waiting + (counts.waiting || 0),
          delayed: acc.delayed + (counts.delayed || 0),
          failed: acc.failed + (counts.failed || 0),
          completed: acc.completed + (counts.completed || 0),
        }), { active: 0, waiting: 0, delayed: 0, failed: 0, completed: 0 });
    const payload = {
      ...status,
      threadResolution,
      queue: {
        active: queueCounts.active || 0,
        waiting: queueCounts.waiting || 0,
        delayed: queueCounts.delayed || 0,
        failed: queueCounts.failed || 0,
        lag: (queueCounts.waiting || 0) + (queueCounts.delayed || 0),
      },
      syncPosture: accountId
        ? (postures[0]?.posture || 'healthy')
        : (postures.some((entry) => isBlockedPosture(entry.posture)) ? 'degraded' : 'healthy'),
      nextAllowedAt: accountId ? (postures[0]?.nextAllowedAt || null) : null,
      lastAuthFailure: accountId ? (postures[0]?.reason || null) : null,
      blockedAccounts: postures.filter((entry) => isBlockedPosture(entry.posture)).length,
      safetyPosture: accountId
        ? (postures[0]?.posture || 'healthy')
        : (postures.some((entry) => entry.posture === 'automation_warning') ? 'automation_warning' : null),
      lastSafetyWarning: accountId
        ? (postures[0]?.posture === 'automation_warning' ? (postures[0]?.reason || null) : null)
        : (postures.find((entry) => entry.posture === 'automation_warning')?.reason || null),
      lastWarningUrl: accountId
        ? (postures[0]?.warningUrl || null)
        : (postures.find((entry) => entry.posture === 'automation_warning')?.warningUrl || null),
      safetyPausedSurfaces: accountId && RESTRICTED_ACTION_POSTURES.has(String(postures[0]?.posture || ''))
        ? ['inbox', 'notifications', 'connections', 'invitations', 'search', 'send']
        : [],
      postures,
      browser,
      runsSummary: status.runsSummary || [],
      browserMinutesEstimate: browser.reduce((sum, entry) => sum + Number(entry.browserMinutesEstimate || 0), 0),
      browserRecycles: browser.reduce((sum, entry) => sum + Number(entry.browserRecycles || 0), 0) + inboxMetrics.browserRecycles,
      lastBrowserFatalError: browser.find((entry) => entry.lastBrowserFatalError)?.lastBrowserFatalError || null,
      threadsAttempted: inboxMetrics.threadsAttempted,
      threadsRefreshed: inboxMetrics.threadsRefreshed,
      threadFailures: inboxMetrics.threadFailures,
    };
    await setCachedJson('sync-status', cacheParts, payload, 10);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 800) {
      console.info(`[ApiPerf] GET /unified/sync-status ${accountId || 'all'} completed in ${durationMs}ms`);
    }
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.post('/unified/sync', async (req, res) => {
  try {
    const accountId = req.body?.accountId
      ? await resolveCanonicalAccountId(validateId(req.body.accountId, { field: 'accountId' }))
      : null;
    const lane = sanitizeText(req.body?.lane || 'delta', { maxLength: 24 });
    const surfaces = Array.isArray(req.body?.surfaces)
      ? req.body.surfaces.map((surface) => sanitizeText(surface, { maxLength: 40 })).filter(Boolean)
      : undefined;

    if (req.body?.wait === true) {
      const result = accountId
        ? await syncAccountUnified(accountId, { lane, surfaces, proxyUrl: process.env.PROXY_URL || null })
        : await syncAllUnifiedAccounts({ lane, surfaces, proxyUrl: process.env.PROXY_URL || null });
      return res.json(result);
    }

    if (accountId) {
      await queueUnifiedSync(accountId, { lane, surfaces, proxyUrl: process.env.PROXY_URL || null });
    } else {
      const ids = dedupeAccountIds(await listKnownAccountIds());
      const outcomes = await Promise.all(ids.map(async (id) => {
        try {
          await queueUnifiedSync(id, { lane, surfaces, proxyUrl: process.env.PROXY_URL || null });
          return { accountId: id, queued: true };
        } catch (queueErr) {
          if (queueErr?.code === 'SYNC_BLOCKED') {
            return { accountId: id, queued: false, blocked: true, error: queueErr.message };
          }
          throw queueErr;
        }
      }));
      return res.json({ success: true, queued: true, lane, surfaces, outcomes });
    }

    res.json({ success: true, queued: true, accountId, lane, surfaces });
  } catch (err) {
    console.error('[Worker] unified sync failed', {
      requestId: req.requestId,
      accountId: req.body?.accountId || null,
      lane: req.body?.lane || null,
      surfaces: Array.isArray(req.body?.surfaces) ? req.body.surfaces : null,
      error: err?.message || String(err),
      code: err?.code || null,
    });
    res.status(err.status || 500).json({
      error: toPublicOperationError(err),
      code: err.code,
      requestId: req.requestId,
    });
  }
});

app.post('/maintenance/messages/dedupe', async (req, res) => {
  try {
    const messageRepo = require('./db/repositories/MessageRepository');
    const accountId = req.body?.accountId
      ? await resolveCanonicalAccountId(validateId(req.body.accountId, { field: 'accountId' }))
      : null;
    const conversationId = req.body?.conversationId
      ? validateId(req.body.conversationId, { field: 'conversationId' })
      : null;
    const dryRun = parseBooleanFlag(req.body?.dryRun, true);
    const result = await withTimeout(
      messageRepo.repairMessageDuplicates({ accountId, conversationId, dryRun }),
      60_000,
      'MESSAGE_DEDUPE_TIMEOUT'
    );
    invalidateUnifiedViewCaches();
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.status || (err.message ? 400 : 500);
    res.status(status).json({
      error: toPublicOperationError(err),
      code: err.code,
    });
  }
});

app.post('/unified/messages', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(
      validateId(req.body?.accountId, { field: 'accountId' })
    );
    const text = sanitizeText(req.body?.text, { maxLength: 8000 });
    if (!text) return res.status(400).json({ error: 'text is required' });

    if (req.body?.profileUrl) {
      const result = await runJob('sendMessageNew', {
        accountId,
        profileUrl: validateProfileUrl(req.body.profileUrl),
        text,
        proxyUrl: process.env.PROXY_URL || null,
      });
      return res.json(result);
    }

    const chatId = validateId(req.body?.chatId || req.body?.conversationId, { field: 'chatId', allowColon: true });
    const result = await runJob('sendMessage', {
      accountId,
      chatId: normalizeThreadId(accountId, chatId),
      text,
      proxyUrl: process.env.PROXY_URL || null,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.post('/unified/invitations', async (req, res) => {
  try {
    const accountId = await resolveCanonicalAccountId(
      validateId(req.body?.accountId, { field: 'accountId' })
    );
    const profileUrl = validateProfileUrl(req.body?.profileUrl);
    const note = req.body?.note == null ? '' : sanitizeNote(req.body.note);
    const result = await runJob('sendConnectionRequest', {
      accountId,
      profileUrl,
      note,
      proxyUrl: process.env.PROXY_URL || null,
    }, 90000);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.post('/webhooks/subscriptions', async (req, res) => {
  try {
    const targetUrl = String(req.body?.targetUrl || '').trim();
    const eventTypes = Array.isArray(req.body?.eventTypes)
      ? req.body.eventTypes.map((event) => sanitizeText(event, { maxLength: 80 })).filter(Boolean)
      : [];
    await assertSafeWebhookTarget(targetUrl);
    if (eventTypes.length === 0) {
      return res.status(400).json({ error: 'eventTypes must contain at least one event name' });
    }

    const subscription = {
      id: uuidv4(),
      targetUrl,
      eventTypes,
      secret: req.body?.secret ? String(req.body.secret) : crypto.randomBytes(32).toString('hex'),
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    await unifiedRepo.createWebhookSubscription({
      ...subscription,
      createdAt: new Date(subscription.createdAt),
    });
    res.status(201).json({
      subscription: {
        ...subscription,
        secretPreview: `${subscription.secret.slice(0, 6)}...${subscription.secret.slice(-4)}`,
        secret: undefined,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.get('/webhooks/subscriptions', async (_req, res) => {
  try {
    const subscriptions = await unifiedRepo.listWebhookSubscriptions();
    res.json({
      subscriptions: subscriptions.map((subscription) => ({
        id: subscription.id,
        targetUrl: subscription.targetUrl,
        eventTypes: subscription.eventTypes,
        status: subscription.status,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
        secretPreview: `${subscription.secret.slice(0, 6)}...${subscription.secret.slice(-4)}`,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

app.delete('/webhooks/subscriptions/:id', async (req, res) => {
  try {
    const id = validateId(req.params.id, { field: 'subscription id', min: 8, max: 128 });
    await unifiedRepo.deactivateWebhookSubscription(id);
    res.status(204).send();
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

// !! IMPORTANT: /stats/all/summary MUST be declared BEFORE /stats/:accountId/summary
// Express matches top-down; 'all' would be captured as accountId parameter otherwise

app.get('/stats/all/summary', async (_req, res) => {
  try {
    const ids   = (process.env.ACCOUNT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const redis = getRedis();

    let totalMessages    = 0;
    let totalConnections = 0;

    const accountStats = await Promise.all(
      ids.map(async (id) => {
        const [msgs, conns] = await Promise.all([
          redis.get(`stats:messages:${id}`).catch(() => '0'),
          redis.get(`stats:connections:${id}`).catch(() => '0'),
        ]);
        const parsedMsgs  = parseInt(msgs  || '0', 10);
        const parsedConns = parseInt(conns || '0', 10);
        totalMessages    += parsedMsgs;
        totalConnections += parsedConns;
        return { id, totalActivity: parsedMsgs + parsedConns };
      })
    );

    res.json({
      accounts: Object.fromEntries(accountStats.map(a => [a.id, a])),
      totalMessages,
      totalConnections,
    });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

app.get('/stats/:accountId/summary', async (req, res) => {
  try {
    const { accountId } = req.params;
    const redis = getRedis();
    const key   = `activity:log:${accountId}`;
    const total = await redis.llen(key).catch(() => 0);
    res.json({ accountId, totalActivity: total });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

app.get('/stats/:accountId/activity', async (req, res) => {
  try {
    const accountId = validateId(req.params.accountId, { field: 'accountId' });
    const page  = parseInt(req.query.page  ?? '0',  10);
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    const redis = getRedis();
    const key   = `activity:log:${accountId}`;
    const total = await redis.llen(key).catch(() => 0);
    const start = page * limit;
    const stop  = start + limit - 1;
    const raw   = await redis.lrange(key, start, stop).catch(() => []);

    const entries = raw.map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean).map((entry) => {
      const profileUrl = String(entry.targetProfileUrl || '');
      return {
        ...entry,
        targetName: normalizeParticipantName(entry.targetName, profileUrl),
      };
    });

    const optimizedEntries = dedupeRecentActivity(entries).slice(0, limit);

    res.json({ entries: optimizedEntries, total });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message });
  }
});

app.get('/people/search', async (req, res) => {
  try {
    const accountId = validateId(req.query.accountId, { field: 'accountId' });
    const { limit } = req.query;
    const q = sanitizeText(req.query.q, { maxLength: 200 });
    if (!q) return res.status(400).json({ error: 'q is required' });

    const result = await runJob('searchPeople', {
      accountId, query: q, limit: parseInt(limit || '10', 10),
      proxyUrl: process.env.PROXY_URL || null,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: toPublicOperationError(err), code: err.code });
  }
});

// â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const http = require('http');
const { initializeWebSocket } = require('./utils/websocket');
const { startWebhookRetryService } = require('./services/webhookRetryService');

// Lazy-loaded so a broken module in voyager/bootstrap can NEVER prevent the
// worker from binding the HTTP listener (which is what causes the dashboard 502).
let voyagerBootstrap = null;
try { voyagerBootstrap = require('./voyager/bootstrap'); }
catch (e) { console.warn('[bootstrap] voyager bootstrap unavailable (continuing without it):', e.message); }

// Last-resort safety net so a stray async error in a background subsystem
// (proxy pool refresh, realtime reconnect, etc.) never crashes the process
// and triggers Nomad's restart loop → permanent dashboard 502.
process.on('unhandledRejection', (err) => {
  console.error('[process] unhandledRejection (continuing):', err && err.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException (continuing):', err && err.message || err);
});

function startServer() {
  try { startWorker(); } catch (e) { console.error('[startServer] startWorker error (continuing):', e.message); }
  try { startWebhookRetryService(); } catch (e) { console.error('[startServer] webhook retry service error (continuing):', e.message); }
  // Phases 2–3 + harvest + proxy pool — fully optional. Errors here MUST NOT
  // prevent the HTTP server from binding.
  if (voyagerBootstrap && voyagerBootstrap.boot) {
    Promise.resolve()
      .then(() => voyagerBootstrap.boot())
      .catch((e) => console.error('[bootstrap] voyager boot failed (worker continues):', e.message));
  }

  const server = http.createServer(app);
  try { initializeWebSocket(server); } catch (e) { console.error('[startServer] websocket init error (continuing):', e.message); }

  // A bind failure (e.g. EADDRINUSE) must crash the process so the orchestrator
  // restarts it. Without this handler the error becomes an uncaughtException,
  // which the global handler above swallows — leaving a live-but-unbound process
  // that health checks can't recover (permanent 502).
  server.on('error', (err) => {
    console.error(`[API] HTTP server error — exiting for restart: ${err && err.message || err}`);
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[API] Worker API listening on port ${PORT}`);
    console.log(`[WebSocket] WebSocket server ready on port ${PORT}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  assertSafeWebhookTarget,
  startServer,
};
