'use strict';

const crypto = require('crypto');
const { getRedis } = require('./redisClient');

const CONNECT_SESSION_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.CONNECT_SESSION_TIMEOUT_MS || '300000', 10) || 300_000
);
const CONNECT_SESSION_TTL_SECONDS = Math.ceil(CONNECT_SESSION_TTL_MS / 1000);
const LOGIN_URL = 'https://www.linkedin.com/login';
const memorySessions = new Map();

function getBrowserUrl() {
  const configuredBase = String(process.env.NOVNC_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const base = configuredBase
    || (process.env.NODE_ENV === 'production' ? '/novnc' : 'http://127.0.0.1:6080');
  return `${base}/vnc.html?autoconnect=1&resize=scale&view_only=0`;
}

function withDerivedUrls(session) {
  if (!session) return null;
  return {
    ...session,
    browserUrl: session.browserUrl || getBrowserUrl(),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function makeKey(connectId) {
  return `connect:session:${connectId}`;
}

function isTerminal(status) {
  return ['connected', 'failed', 'expired'].includes(String(status || ''));
}

function normalizeSession(session) {
  if (!session) return null;
  const expiresAt = new Date(session.expiresAt).getTime();
  if (Number.isFinite(expiresAt) && Date.now() > expiresAt && !isTerminal(session.status)) {
    return {
      ...session,
      status: 'expired',
      message: session.message || 'The LinkedIn connect session expired before login completed.',
      updatedAt: nowIso(),
    };
  }
  return session;
}

async function persistSession(session) {
  const redis = getRedis();
  const serialized = JSON.stringify(session);
  memorySessions.set(session.connectId, session);
  await redis.set(makeKey(session.connectId), serialized, 'EX', CONNECT_SESSION_TTL_SECONDS).catch(() => {});
  return session;
}

async function createConnectSession(accountId) {
  const connectId = crypto.randomUUID();
  const now = nowIso();
  const session = {
    connectId,
    accountId,
    status: 'waiting_for_login',
    loginUrl: LOGIN_URL,
    browserUrl: getBrowserUrl(),
    message: 'Open the worker-controlled LinkedIn browser and finish signing in.',
    currentUrl: LOGIN_URL,
    syncQueued: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + CONNECT_SESSION_TTL_MS).toISOString(),
  };
  await persistSession(session);
  return withDerivedUrls(session);
}

async function getConnectSession(connectId) {
  const redis = getRedis();
  const raw = await redis.get(makeKey(connectId)).catch(() => null);
  const parsed = raw ? JSON.parse(raw) : memorySessions.get(connectId) || null;
  const normalized = normalizeSession(parsed);
  if (normalized && normalized.status === 'expired') {
    await persistSession(normalized);
  }
  return withDerivedUrls(normalized);
}

async function updateConnectSession(connectId, patch) {
  const existing = await getConnectSession(connectId);
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  };
  await persistSession(next);
  return withDerivedUrls(next);
}

module.exports = {
  CONNECT_SESSION_TTL_MS,
  LOGIN_URL,
  createConnectSession,
  getConnectSession,
  updateConnectSession,
};
