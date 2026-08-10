// FILE: worker/src/utils/websocket.js
// WebSocket server management using Socket.IO

const { Server } = require('socket.io');
const crypto = require('crypto');
const { listKnownAccountIds } = require('../session');

let io = null;
let knownAccountCache = { ids: new Set(), expiresAt: 0 };
const inboxRefreshTimers = new Map();
const syncRefreshTimers = new Map();

function normalizeOrigin(value) {
  try {
    return new URL(String(value || '').trim()).origin;
  } catch {
    return '';
  }
}

function configuredSocketOrigins() {
  return new Set(
    [
      ...(process.env.FRONTEND_URL || '').split(','),
      ...(process.env.TRUSTED_ORIGINS || '').split(','),
    ]
      .map((value) => normalizeOrigin(value))
      .filter(Boolean)
  );
}

function parseCookies(cookieHeader) {
  const parsed = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      parsed[key] = decodeURIComponent(value);
    } catch {
      parsed[key] = value;
    }
  }
  return parsed;
}

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

function verifySocketJwt(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  try {
    const header = JSON.parse(decodeBase64Url(headerB64).toString('utf8'));
    if (header?.alg !== 'HS256') return null;

    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const providedSig = decodeBase64Url(sigB64);

    if (
      expectedSig.length !== providedSig.length ||
      !crypto.timingSafeEqual(expectedSig, providedSig)
    ) {
      return null;
    }

    const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload?.exp === 'number' && payload.exp <= now) return null;
    if (payload?.authenticated !== true) return null;

    return payload;
  } catch {
    return null;
  }
}

function isValidAccountId(accountId) {
  return (
    typeof accountId === 'string' &&
    accountId.length > 0 &&
    accountId.length <= 128 &&
    /^[a-zA-Z0-9._:-]+$/.test(accountId)
  );
}

async function getKnownAccountIds() {
  if (Date.now() < knownAccountCache.expiresAt) {
    return knownAccountCache.ids;
  }

  try {
    const ids = await listKnownAccountIds();
    knownAccountCache = {
      ids: new Set((ids || []).map((id) => String(id).trim()).filter(Boolean)),
      expiresAt: Date.now() + 30_000,
    };
  } catch {
    knownAccountCache = { ids: new Set(), expiresAt: Date.now() + 5_000 };
  }

  return knownAccountCache.ids;
}

/**
 * Initialize WebSocket server
 * @param {Object} httpServer - HTTP server instance
 * @returns {Object} Socket.IO instance
 */
function initializeWebSocket(httpServer) {
  const allowedOrigins = configuredSocketOrigins();
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        const normalizedOrigin = normalizeOrigin(origin);
        if (allowedOrigins.size === 0 || allowedOrigins.has(normalizedOrigin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Socket origin not allowed: ${normalizedOrigin}`));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    const cookies = parseCookies(socket.handshake?.headers?.cookie || '');
    const payload = verifySocketJwt(cookies.app_session);
    if (!payload || payload.role !== 'admin') {
      socket.emit('auth:error', { error: 'Unauthorized socket session' });
      socket.disconnect(true);
      return;
    }

    socket.data.authenticated = true;
    socket.data.authPayload = payload;
    console.log('[WebSocket] Client connected:', socket.id);

    // Handle client joining account-specific rooms
    socket.on('join:account', async (accountId) => {
      if (!isValidAccountId(accountId)) {
        socket.emit('auth:error', { error: 'Invalid account room' });
        return;
      }

      const knownIds = await getKnownAccountIds();
      if (!knownIds.has(accountId)) {
        socket.emit('auth:error', { error: 'Forbidden account room' });
        return;
      }

      socket.join(`account:${accountId}`);
      console.log(`[WebSocket] Client ${socket.id} joined room: account:${accountId}`);
    });

    // Handle client leaving account rooms
    socket.on('leave:account', (accountId) => {
      if (accountId) {
        socket.leave(`account:${accountId}`);
        console.log(`[WebSocket] Client ${socket.id} left room: account:${accountId}`);
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log('[WebSocket] Client disconnected:', socket.id);
    });

    // Send welcome message
    socket.emit('connected', {
      message: 'Connected to LinkedIn Automation WebSocket',
      timestamp: new Date().toISOString(),
    });
  });

  console.log('[WebSocket] Server initialized');
  return io;
}

/**
 * Get the Socket.IO instance
 * @returns {Object|null} Socket.IO instance
 */
function getIO() {
  if (!io) {
    console.warn('[WebSocket] Socket.IO not initialized');
  }
  return io;
}

/**
 * Emit event to all connected clients
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
function broadcastEvent(event, data) {
  const socketIO = getIO();
  if (socketIO) {
    socketIO.emit(event, {
      ...data,
      timestamp: new Date().toISOString(),
    });
    console.log(`[WebSocket] Broadcast event: ${event}`);
  }
}

/**
 * Emit event to specific account room
 * @param {string} accountId - Account ID
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
function emitToAccount(accountId, event, data) {
  const socketIO = getIO();
  if (socketIO && accountId) {
    socketIO.to(`account:${accountId}`).emit(event, {
      ...data,
      accountId,
      timestamp: new Date().toISOString(),
    });
    console.log(`[WebSocket] Emit to account:${accountId} - ${event}`);
  }
}

function scheduleInboxRefresh(accountId, data = {}, delayMs = 750) {
  if (!accountId) return;
  const existing = inboxRefreshTimers.get(accountId);
  if (existing) clearTimeout(existing);
  inboxRefreshTimers.set(accountId, setTimeout(() => {
    inboxRefreshTimers.delete(accountId);
    emitToAccount(accountId, 'inbox:updated', {
      accountId,
      conversationId: data.conversationId || null,
      source: data.source || 'sync',
    });
  }, delayMs));
}

function scheduleSyncStatusRefresh(accountId, data = {}, delayMs = 1000) {
  const scope = accountId || 'global';
  const existing = syncRefreshTimers.get(scope);
  if (existing) clearTimeout(existing);
  syncRefreshTimers.set(scope, setTimeout(() => {
    syncRefreshTimers.delete(scope);
    if (accountId) {
      emitToAccount(accountId, 'sync:updated', {
        accountId,
        lane: data.lane || null,
        surface: data.surface || null,
      });
      return;
    }
    broadcastEvent('sync:updated', {
      lane: data.lane || null,
      surface: data.surface || null,
    });
  }, delayMs));
}

/**
 * Emit inbox update event
 * @param {string} accountId - Account ID
 * @param {Object} inboxData - Inbox data
 */
function emitInboxUpdate(accountId, inboxData) {
  emitToAccount(accountId, 'inbox:updated', inboxData);
}

/**
 * Emit new message event
 * @param {string} accountId - Account ID
 * @param {Object} message - Message data
 */
function emitNewMessage(accountId, message) {
  emitToAccount(accountId, 'inbox:new_message', message);
}

/**
 * Emit account status change event
 * @param {string} accountId - Account ID
 * @param {Object} status - Status data
 */
function emitAccountStatus(accountId, status) {
  emitToAccount(accountId, 'account:status', status);
}

/**
 * Emit rate limit update event
 * @param {string} accountId - Account ID
 * @param {Object} rateLimit - Rate limit data
 */
function emitRateLimitUpdate(accountId, rateLimit) {
  emitToAccount(accountId, 'rate_limit:updated', rateLimit);
}

module.exports = {
  initializeWebSocket,
  getIO,
  broadcastEvent,
  emitToAccount,
  emitInboxUpdate,
  emitNewMessage,
  emitAccountStatus,
  emitRateLimitUpdate,
  scheduleInboxRefresh,
  scheduleSyncStatusRefresh,
};
