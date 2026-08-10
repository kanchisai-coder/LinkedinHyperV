// FILE: worker/src/routes/export.js
// Export API endpoints for messages and activity logs

'use strict';

const express = require('express');
const { getRedis } = require('../redisClient');
const messageRepo = require('../db/repositories/MessageRepository');

const router = express.Router();
const ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

function readBody(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object');
  }
  return body;
}

function readFormat(raw) {
  const format = String(raw || 'csv').toLowerCase();
  if (!['csv', 'json'].includes(format)) {
    throw new Error('format must be "csv" or "json"');
  }
  return format;
}

function readOptionalId(raw, fieldName) {
  if (raw == null || String(raw).trim() === '') return null;
  const id = String(raw).trim();
  if (!ID_RE.test(id)) {
    throw new Error(`${fieldName} is invalid`);
  }
  return id;
}

function readOptionalLimit(raw, fallback = 1000, min = 1, max = 5000) {
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`limit must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * Convert data to CSV format
 */
function toCSV(headers, rows) {
  const escape = (val) => {
    if (val == null) return '';
    const str = String(val);
    // Escape quotes and wrap in quotes if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvHeaders = headers.join(',');
  const csvRows = rows.map(row => row.map(escape).join(',')).join('\n');
  
  return `${csvHeaders}\n${csvRows}`;
}

/**
 * POST /export/messages
 * Export messages from database as CSV or JSON
 * Body: { accountId?, format: 'csv'|'json', conversationId? }
 */
router.post('/messages', async (req, res) => {
  try {
    const body = readBody(req);
    const format = readFormat(body.format);
    const accountId = readOptionalId(body.accountId, 'accountId');
    const conversationId = readOptionalId(body.conversationId, 'conversationId');

    // Query messages from database
    const messages = await messageRepo.getMessagesForExport({
      accountId,
      conversationId,
    });

    // Transform to export format
    const allMessages = messages.map(msg => ({
      timestamp: new Date(msg.sentAt).getTime(),
      date: new Date(msg.sentAt).toLocaleDateString(),
      time: new Date(msg.sentAt).toLocaleTimeString(),
      accountId: msg.accountId,
      conversationId: msg.conversationId,
      participantName: msg.conversation?.participantName || 'Unknown',
      sender: msg.senderName,
      message: msg.text,
      isSentByMe: msg.isSentByMe,
    }));

    // Sort by timestamp
    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    if (format === 'csv') {
      const headers = ['Timestamp', 'Date', 'Time', 'Account', 'Conversation ID', 'Participant', 'Sender', 'Message', 'Sent By Me'];
      const rows = allMessages.map(msg => [
        msg.timestamp,
        msg.date,
        msg.time,
        msg.accountId,
        msg.conversationId,
        msg.participantName || '',
        msg.sender,
        msg.message,
        msg.isSentByMe ? 'Yes' : 'No',
      ]);

      const csv = toCSV(headers, rows);
      const filename = `linkedin-messages-${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } else {
      // JSON format
      const filename = `linkedin-messages-${new Date().toISOString().split('T')[0]}.json`;
      const accountsForExport = Array.from(
        new Set(allMessages.map((m) => String(m.accountId || '').trim()).filter(Boolean))
      );
      const jsonData = {
        exportedAt: new Date().toISOString(),
        totalMessages: allMessages.length,
        accounts: accountsForExport,
        messages: allMessages,
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(jsonData);
    }
  } catch (err) {
    console.error('[Export] Error:', err);
    if (err?.message) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ 
      error: process.env.NODE_ENV === 'production' ? 'Export failed' : err.message 
    });
  }
});

/**
 * POST /export/activity
 * Export activity logs as CSV or JSON
 * Body: { accountId?, format: 'csv'|'json', limit? }
 */
router.post('/activity', async (req, res) => {
  try {
    const body = readBody(req);
    const format = readFormat(body.format);
    const accountId = readOptionalId(body.accountId, 'accountId');
    const limit = readOptionalLimit(body.limit, 1000, 1, 5000);

    const redis = getRedis();
    let allActivity = [];
    let accountIds = [];

    // Determine which accounts to export
    if (accountId) {
      accountIds = [accountId];
    } else {
      accountIds = (process.env.ACCOUNT_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .filter((id) => ID_RE.test(id));
    }

    if (accountIds.length === 0) {
      return res.status(400).json({ error: 'No valid account IDs available for export' });
    }

    // Fetch activity logs from Redis
    for (const accId of accountIds) {
      try {
        const key = `activity:log:${accId}`;
        const logs = await redis.lrange(key, 0, limit - 1);
        
        const parsed = logs.map(log => {
          try {
            const entry = JSON.parse(log);
            return {
              ...entry,
              accountId: accId,
            };
          } catch {
            return null;
          }
        }).filter(Boolean);
        
        allActivity.push(...parsed);
      } catch (err) {
        console.error(`[Export] Failed to fetch activity for ${accId}:`, err.message);
      }
    }

    // Sort by timestamp (most recent first)
    allActivity.sort((a, b) => b.timestamp - a.timestamp);

    if (format === 'csv') {
      const headers = ['Timestamp', 'Date', 'Time', 'Account', 'Type', 'Target Name', 'Target Profile URL', 'Message'];
      const rows = allActivity.map(activity => [
        activity.timestamp,
        new Date(activity.timestamp).toLocaleDateString(),
        new Date(activity.timestamp).toLocaleTimeString(),
        activity.accountId,
        activity.type,
        activity.targetName || '',
        activity.targetProfileUrl || '',
        activity.message || '',
      ]);

      const csv = toCSV(headers, rows);
      const filename = `linkedin-activity-${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } else {
      // JSON format
      const filename = `linkedin-activity-${new Date().toISOString().split('T')[0]}.json`;
      const jsonData = {
        exportedAt: new Date().toISOString(),
        totalEntries: allActivity.length,
        accounts: accountIds,
        activity: allActivity,
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(jsonData);
    }
  } catch (err) {
    console.error('[Export] Error:', err);
    if (err?.message) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ 
      error: process.env.NODE_ENV === 'production' ? 'Export failed' : err.message 
    });
  }
});

module.exports = router;
