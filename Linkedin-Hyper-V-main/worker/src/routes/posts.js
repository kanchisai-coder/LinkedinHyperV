'use strict';

const express = require('express');
const router = express.Router();

/**
 * Route handler for creating a new post immediately or scheduling it for later.
 */
router.post('/posts', async (req, res) => {
  const { accountId, text, title, targetUrl, scheduledAt, visibility } = req.body;

  if (!accountId || !text) {
    return res.status(400).json({ error: 'accountId and text are required fields' });
  }

  try {
    const db = require('../../../lib/db');
    
    if (scheduledAt) {
      // Insert into linkedin_scheduled_posts table
      const insertQuery = `
        INSERT INTO linkedin_scheduled_posts (
          account_id, content, title, target_url, visibility, scheduled_at, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
        RETURNING id, account_id, status, scheduled_at;
      `;

      const result = await db.query(insertQuery, [
        accountId, text, title || null, targetUrl || null, visibility || 'PUBLIC', new Date(scheduledAt)
      ]);

      return res.status(201).json({
        message: 'Post scheduled successfully',
        post: result.rows[0],
      });
    }

    // Immediate post creation using official LinkedIn API client if access token exists
    const tokenResult = await db.query(
      'SELECT access_token_encrypted, iv, tag FROM linkedin_oauth_tokens WHERE linkedin_sub = $1 LIMIT 1',
      [accountId]
    ).catch(() => ({ rows: [] }));

    if (tokenResult.rows.length > 0) {
      const { decryptToken } = require('../../../lib/linkedin/token-crypto');
      const { LinkedInApiClient } = require('../../../lib/linkedin/linkedin-client');

      const row = tokenResult.rows[0];
      const accessToken = decryptToken({ encrypted: row.access_token_encrypted, iv: row.iv, tag: row.tag });
      const client = new LinkedInApiClient({ accessToken });

      const postRes = await client.createPost({
        authorUrn: `urn:li:person:${accountId}`,
        text,
        title,
        targetUrl,
        visibility,
      });

      return res.status(200).json({
        message: 'Post published via LinkedIn REST API',
        postId: postRes.id,
        status: postRes.status,
      });
    }

    return res.status(400).json({
      error: 'No active OAuth access token found for this account. Please authenticate via LinkedIn OAuth.',
    });
  } catch (err) {
    console.error('Error handling post request:', err);
    res.status(500).json({ error: err.message || 'Failed to process post' });
  }
});

/**
 * List scheduled posts for an account.
 */
router.get('/posts/scheduled', async (req, res) => {
  const { accountId } = req.query;

  try {
    const db = require('../../../lib/db');
    const queryStr = accountId
      ? 'SELECT * FROM linkedin_scheduled_posts WHERE account_id = $1 ORDER BY scheduled_at ASC'
      : 'SELECT * FROM linkedin_scheduled_posts ORDER BY scheduled_at ASC';
    const params = accountId ? [accountId] : [];

    const result = await db.query(queryStr, params).catch(() => ({ rows: [] }));

    res.json({ items: result.rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
