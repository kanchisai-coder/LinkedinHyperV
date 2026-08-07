'use strict';

const db = require('../../../lib/db');
const { decryptToken } = require('../../../lib/linkedin/token-crypto');
const { LinkedInApiClient } = require('../../../lib/linkedin/linkedin-client');

/**
 * Worker process that scans for pending scheduled posts due for publication
 * and executes posting using the official LinkedIn REST API client.
 */
async function processPendingScheduledPosts() {
  try {
    const queryStr = `
      SELECT * FROM linkedin_scheduled_posts 
      WHERE status = 'PENDING' AND scheduled_at <= CURRENT_TIMESTAMP
      LIMIT 10;
    `;

    const result = await db.query(queryStr).catch(() => ({ rows: [] }));

    for (const post of result.rows || []) {
      try {
        const tokenRes = await db.query(
          'SELECT access_token_encrypted, iv, tag FROM linkedin_oauth_tokens WHERE linkedin_sub = $1 LIMIT 1',
          [post.account_id]
        );

        if (!tokenRes.rows || tokenRes.rows.length === 0) {
          await db.query(
            "UPDATE linkedin_scheduled_posts SET status = 'FAILED', error_message = 'No OAuth token found for account' WHERE id = $1",
            [post.id]
          );
          continue;
        }

        const tokenRow = tokenRes.rows[0];
        const accessToken = decryptToken({
          encrypted: tokenRow.access_token_encrypted,
          iv: tokenRow.iv,
          tag: tokenRow.tag,
        });

        const client = new LinkedInApiClient({ accessToken });
        const publishRes = await client.createPost({
          authorUrn: `urn:li:person:${post.account_id}`,
          text: post.content,
          title: post.title || undefined,
          targetUrl: post.target_url || undefined,
          visibility: post.visibility || 'PUBLIC',
        });

        await db.query(
          "UPDATE linkedin_scheduled_posts SET status = 'PUBLISHED', linkedin_post_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
          [publishRes.id, post.id]
        );

        console.log(`[PostPublisherService] Successfully published scheduled post ${post.id}`);
      } catch (postErr) {
        console.error(`[PostPublisherService] Failed to publish post ${post.id}:`, postErr);
        await db.query(
          "UPDATE linkedin_scheduled_posts SET status = 'FAILED', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
          [postErr.message || 'Publishing error', post.id]
        );
      }
    }
  } catch (err) {
    console.error('[PostPublisherService] Error in scheduled post processing loop:', err);
  }
}

module.exports = {
  processPendingScheduledPosts,
};
