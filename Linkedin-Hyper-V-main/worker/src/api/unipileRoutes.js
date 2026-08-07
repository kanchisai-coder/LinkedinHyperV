'use strict';

// Unipile-shaped REST facade. Gives consumers (n8n, CRMs, your own app) a stable
// provider-agnostic API that mirrors Unipile's surface — so you can swap this in
// for Unipile without rewriting downstream integrations. Each route maps to the
// VoyagerClient (same data, same method LinkedIn's own web app uses).
//
// Mounted under /api/v1 behind the worker's existing x-api-key auth.
// All routes are best-effort over the live Voyager API with graceful errors;
// reads fall back to DB-backed data where the orchestrator already persists it.

const express = require('express');
const { VoyagerClient, VoyagerError } = require('../voyager/VoyagerClient');
const mapper = require('../voyager/voyagerMapper');

function ok(res, data) { return res.json({ object: 'Result', data }); }
function fail(res, err) {
  const status = err instanceof VoyagerError
    ? (err.code === 'BLOCKED' ? 423 : err.code === 'RATE_LIMITED' ? 429 : err.code === 'NO_SESSION' ? 401 : 502)
    : 500;
  return res.status(status).json({
    object: 'Error',
    type: err.code || 'error',
    title: err.message || 'error',
    ...(err.retryAfter ? { retry_after: err.retryAfter } : {}),
  });
}

function createUnipileRouter({ listKnownAccountIds, getSyncPosture, checkAndIncrement } = {}) {
  const router = express.Router();
  const client = (accountId) => new VoyagerClient(accountId);

  // ── Accounts ───────────────────────────────────────────────────────────
  // GET /api/v1/accounts  → connected LinkedIn accounts + live posture
  router.get('/accounts', async (_req, res) => {
    try {
      const ids = listKnownAccountIds ? await listKnownAccountIds() : [];
      const accounts = await Promise.all(
        ids.filter((a) => a && a !== 'connect').map(async (id) => {
          const posture = getSyncPosture ? await getSyncPosture(id).catch(() => ({ posture: 'unknown' })) : {};
          return { id, provider: 'LINKEDIN', status: posture.posture || 'unknown' };
        })
      );
      return ok(res, accounts);
    } catch (err) { return fail(res, err); }
  });

  // GET /api/v1/accounts/:id  → the account's own LinkedIn identity (live)
  router.get('/accounts/:id', async (req, res) => {
    try {
      const me = await client(req.params.id).getMe();
      return ok(res, { id: req.params.id, provider: 'LINKEDIN', me });
    } catch (err) { return fail(res, err); }
  });

  // ── Chats / messages ─────────────────────────────────────────────────────
  // GET /api/v1/accounts/:id/chats  → conversations
  router.get('/accounts/:id/chats', async (req, res) => {
    try {
      const count = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
      const json = await client(req.params.id).getConversations({ count });
      return ok(res, mapper.mapConversations(json, { accountId: req.params.id }));
    } catch (err) { return fail(res, err); }
  });

  // GET /api/v1/accounts/:id/chats/:chatId/messages
  router.get('/accounts/:id/chats/:chatId/messages', async (req, res) => {
    try {
      const count = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
      const json = await client(req.params.id).getConversationEvents(req.params.chatId, { count });
      const { items, participant } = mapper.mapEvents(json, { accountId: req.params.id, chatId: req.params.chatId });
      return ok(res, { items, participant });
    } catch (err) { return fail(res, err); }
  });

  // POST /api/v1/accounts/:id/chats/:chatId/messages  { text }
  router.post('/accounts/:id/chats/:chatId/messages', async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ object: 'Error', title: 'text required' });
      if (checkAndIncrement) await checkAndIncrement(req.params.id, 'messagesSent');
      const result = await client(req.params.id).sendMessage(req.params.chatId, text);
      return ok(res, { sent: true, result });
    } catch (err) { return fail(res, err); }
  });

  // POST /api/v1/accounts/:id/chats  { recipient_urn, text }  → start a new chat
  router.post('/accounts/:id/chats', async (req, res) => {
    try {
      const { recipient_urn: recipient, text } = req.body || {};
      if (!recipient || !text) return res.status(400).json({ object: 'Error', title: 'recipient_urn and text required' });
      if (checkAndIncrement) await checkAndIncrement(req.params.id, 'messagesSent');
      const result = await client(req.params.id).createConversation(recipient, String(text));
      return ok(res, { created: true, result });
    } catch (err) { return fail(res, err); }
  });

  // ── Users / profiles ───────────────────────────────────────────────────
  // GET /api/v1/accounts/:id/users/:identifier  → profile by vanity/public id
  router.get('/accounts/:id/users/:identifier', async (req, res) => {
    try {
      const json = await client(req.params.id).getProfile(req.params.identifier);
      return ok(res, json);
    } catch (err) { return fail(res, err); }
  });

  // GET /api/v1/accounts/:id/search?keywords=...
  router.get('/accounts/:id/search', async (req, res) => {
    try {
      const keywords = String(req.query.keywords || '').trim();
      if (!keywords) return res.status(400).json({ object: 'Error', title: 'keywords required' });
      if (checkAndIncrement) await checkAndIncrement(req.params.id, 'searchQueries');
      const json = await client(req.params.id).searchPeople({
        keywords,
        start: parseInt(req.query.start || '0', 10) || 0,
        count: Math.min(parseInt(req.query.limit || '10', 10) || 10, 25),
      });
      return ok(res, json);
    } catch (err) { return fail(res, err); }
  });

  // ── Relations / invitations ──────────────────────────────────────────────
  // GET /api/v1/accounts/:id/relations  → first-degree connections
  router.get('/accounts/:id/relations', async (req, res) => {
    try {
      const count = Math.min(parseInt(req.query.limit || '40', 10) || 40, 80);
      const start = parseInt(req.query.start || '0', 10) || 0;
      const json = await client(req.params.id).getConnections({ count, start });
      return ok(res, json);
    } catch (err) { return fail(res, err); }
  });

  // GET /api/v1/accounts/:id/invitations  → received invitations
  router.get('/accounts/:id/invitations', async (req, res) => {
    try {
      const json = await client(req.params.id).getInvitations({ count: Math.min(parseInt(req.query.limit || '50', 10) || 50, 100) });
      return ok(res, json);
    } catch (err) { return fail(res, err); }
  });

  // POST /api/v1/accounts/:id/invitations  { profile_urn, message? }  → send invite
  router.post('/accounts/:id/invitations', async (req, res) => {
    try {
      const { profile_urn: profileUrn, message } = req.body || {};
      if (!profileUrn) return res.status(400).json({ object: 'Error', title: 'profile_urn required' });
      if (checkAndIncrement) await checkAndIncrement(req.params.id, 'connectRequests');
      const result = await client(req.params.id).sendInvitation(profileUrn, { message });
      return ok(res, { sent: true, result });
    } catch (err) { return fail(res, err); }
  });

  // POST /api/v1/accounts/:id/invitations/:invitationId/accept  { shared_secret }
  router.post('/accounts/:id/invitations/:invitationId/accept', async (req, res) => {
    try {
      const result = await client(req.params.id).acceptInvitation(req.params.invitationId, req.body?.shared_secret);
      return ok(res, { accepted: true, result });
    } catch (err) { return fail(res, err); }
  });

  return router;
}

module.exports = { createUnipileRouter };
