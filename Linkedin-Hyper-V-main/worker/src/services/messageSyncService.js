// FILE: worker/src/services/messageSyncService.js
// Message synchronization service - fetches from LinkedIn and stores in database

'use strict';

const { readMessages } = require('../actions/readMessages');
const { readThread } = require('../actions/readThread');
const accountRepo = require('../db/repositories/AccountRepository');
const messageRepo = require('../db/repositories/MessageRepository');
const { emitInboxUpdate, emitNewMessage } = require('../utils/websocket');
const { getRedis } = require('../redisClient');

function isDatabaseUnavailable(err) {
  if (!err) return false;
  const code = err.code || err?.meta?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === 'DB_TIMEOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'P1001' ||
    code === 'P2021' ||
    code === 'P2022' ||
    message.includes('ECONNREFUSED') ||
    message.includes("Can't reach database server") ||
    message.includes('does not exist in the current database') ||
    message.includes('timeout expired') ||
    message.includes('Connection terminated unexpectedly')
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

/**
 * Sync messages for a single account
 * @param {string} accountId - Account ID to sync
 * @param {string|null} proxyUrl - Proxy URL if configured
 * @returns {Promise<Object>} Sync stats
 */
async function syncAccount(accountId, proxyUrl = null) {
  console.log(`[MessageSync] Starting sync for account: ${accountId}`);
  
  const stats = {
    accountId,
    conversationsProcessed: 0,
    newMessages: 0,
    updatedConversations: 0,
    errors: [],
    startedAt: new Date(),
  };

  try {
    // Ensure account exists in database
    try {
      await withTimeout(accountRepo.upsertAccount(accountId, accountId), 4000);
    } catch (dbErr) {
      if (isDatabaseUnavailable(dbErr)) {
        const message = `[MessageSync] Database unavailable for ${accountId}; skipping persistence sync.`;
        console.warn(message);
        stats.errors.push({
          fatal: true,
          code: dbErr.code || 'DB_UNAVAILABLE',
          error: dbErr.message || String(dbErr),
        });
        stats.completedAt = new Date();
        stats.durationMs = stats.completedAt - stats.startedAt;
        return stats;
      }
      throw dbErr;
    }

    // Fetch conversations from LinkedIn
    console.log(`[MessageSync] Fetching conversations for ${accountId}...`);
    const inboxData = await readMessages({ accountId, proxyUrl, limit: 50 });
    
    if (!inboxData || !inboxData.items || inboxData.items.length === 0) {
      console.log(`[MessageSync] No conversations found for ${accountId}`);
      return stats;
    }

    console.log(`[MessageSync] Found ${inboxData.items.length} conversations for ${accountId}`);

    // Process each conversation
    for (const conv of inboxData.items) {
      try {
        stats.conversationsProcessed++;

        // Extract conversation data
        const conversationId = conv.id;
        let participantName = conv.participants[0]?.name || 'Unknown';
        let participantProfileUrl = conv.participants[0]?.profileUrl || null;
        const participantAvatarUrl = conv.participants[0]?.avatarUrl || null;
        const initialLastMessageAt = new Date(conv.lastMessage?.createdAt || conv.createdAt || Date.now());
        const initialLastMessageText = conv.lastMessage?.text || '';
        const initialLastMessageSentByMe = conv.lastMessage?.senderId === '__self__';

        // Upsert conversation
        await withTimeout(messageRepo.upsertConversation({
          id: conversationId,
          accountId,
          participantName,
          participantProfileUrl,
          participantAvatarUrl,
          lastMessageAt: initialLastMessageAt,
          lastMessageText: initialLastMessageText,
          lastMessageSentByMe: initialLastMessageSentByMe,
        }), 4000);
        stats.updatedConversations++;

        // Fetch thread messages
        console.log(`[MessageSync] Fetching messages for conversation ${conversationId}...`);
        const threadData = await readThread({ accountId, chatId: conversationId, proxyUrl, limit: 100 });

        // Enrich missing participant metadata from thread page.
        const threadParticipantName = threadData?.participant?.name;
        const threadParticipantProfileUrl = threadData?.participant?.profileUrl || null;
        if (threadParticipantName && threadParticipantName !== 'Unknown' && participantName === 'Unknown') {
          participantName = threadParticipantName;
        }
        if (threadParticipantProfileUrl && !participantProfileUrl) {
          participantProfileUrl = threadParticipantProfileUrl;
        }
        if ((!participantName || participantName === 'Unknown') && Array.isArray(threadData?.items)) {
          const firstOther = threadData.items.find(
            (msg) => msg?.senderId !== '__self__' && msg?.senderName && msg.senderName !== 'Unknown'
          );
          if (firstOther?.senderName) {
            participantName = firstOther.senderName;
          }
        }

        // Persist enriched metadata if we improved anything.
        if (
          participantName !== (conv.participants[0]?.name || 'Unknown') ||
          participantProfileUrl !== (conv.participants[0]?.profileUrl || null)
        ) {
          await withTimeout(messageRepo.upsertConversation({
            id: conversationId,
            accountId,
            participantName,
            participantProfileUrl,
            participantAvatarUrl,
            lastMessageAt: initialLastMessageAt,
            lastMessageText: initialLastMessageText,
            lastMessageSentByMe: initialLastMessageSentByMe,
          }), 4000);
        }

        if (threadData && threadData.items && threadData.items.length > 0) {
          // Get existing message count before sync
          const existingCount = await withTimeout(
            messageRepo.countMessagesByConversation(conversationId),
            4000
          );

          // Upsert each message
          let newMessagesInThread = 0;
          for (const msg of threadData.items) {
            try {
              const result = await withTimeout(messageRepo.upsertMessage({
                conversationId,
                accountId,
                senderId: msg.senderId || '__unknown__',
                senderName: msg.senderName || 'Unknown',
                text: msg.text || '',
                sentAt: new Date(msg.createdAt || Date.now()),
                isSentByMe: msg.senderId === '__self__',
                linkedinMessageId: msg.id || null,
                source: 'legacy-sync',
              }), 4000);

              // If message was newly created (not a duplicate)
              if (result) {
                newMessagesInThread++;
              }
            } catch (msgError) {
              console.error(`[MessageSync] Error upserting message in ${conversationId}:`, msgError.message);
              stats.errors.push({
                conversationId,
                messageError: msgError.message,
              });
            }
          }

          // Update conversation preview from latest thread message when available.
          const latestThreadMessage = threadData.items[threadData.items.length - 1];
          if (latestThreadMessage) {
            await withTimeout(messageRepo.updateConversationLastMessage(conversationId, {
              sentAt: latestThreadMessage.createdAt || Date.now(),
              text: latestThreadMessage.text || initialLastMessageText,
              sentByMe: latestThreadMessage.senderId === '__self__',
            }), 4000);
          }

          stats.newMessages += newMessagesInThread;
          
          // Get new count after sync
          const newCount = await withTimeout(
            messageRepo.countMessagesByConversation(conversationId),
            4000
          );
          const actualNew = newCount - existingCount;

          if (actualNew > 0) {
            console.log(`[MessageSync] Added ${actualNew} new messages to conversation ${conversationId}`);
            
            // Emit WebSocket event for new messages
            emitNewMessage(accountId, {
              conversationId,
              participantName,
              newMessagesCount: actualNew,
            });
          }
        }

        // Small delay to avoid rate limits
        await delay(500, 1000);

      } catch (convError) {
        if (isDatabaseUnavailable(convError)) {
          stats.errors.push({
            fatal: true,
            code: convError.code || 'DB_UNAVAILABLE',
            error: convError.message || String(convError),
          });
          stats.completedAt = new Date();
          stats.durationMs = stats.completedAt - stats.startedAt;
          console.warn(`[MessageSync] Stopping sync for ${accountId} due to database unavailability.`);
          return stats;
        }
        console.error(`[MessageSync] Error processing conversation ${conv.id}:`, convError.message);
        stats.errors.push({
          conversationId: conv.id,
          error: convError.message,
        });
      }
    }

    // Update account's last synced timestamp
    await withTimeout(accountRepo.updateLastSyncedAt(accountId), 4000);

    // Emit WebSocket event for completed sync
    emitInboxUpdate(accountId, {
      conversationsCount: stats.conversationsProcessed,
      newMessagesCount: stats.newMessages,
      syncedAt: new Date().toISOString(),
    });

    stats.completedAt = new Date();
    stats.durationMs = stats.completedAt - stats.startedAt;
    
    console.log(`[MessageSync] Completed sync for ${accountId}:`, {
      conversations: stats.conversationsProcessed,
      newMessages: stats.newMessages,
      duration: `${stats.durationMs}ms`,
      errors: stats.errors.length,
    });

    // Log to Redis activity log
    const redis = getRedis();
    await redis.lpush(
      `activity:log:${accountId}`,
      JSON.stringify({
        type: 'sync',
        accountId,
        timestamp: Date.now(),
        stats: {
          conversations: stats.conversationsProcessed,
          newMessages: stats.newMessages,
          errors: stats.errors.length,
        },
      })
    );
    await redis.ltrim(`activity:log:${accountId}`, 0, 999); // Keep last 1000 entries

    return stats;

  } catch (error) {
    console.error(`[MessageSync] Fatal error syncing account ${accountId}:`, error);
    stats.errors.push({
      fatal: true,
      error: error.message,
      stack: error.stack,
    });
    stats.completedAt = new Date();
    return stats;
  }
}

/**
 * Sync messages for all configured accounts (staggered)
 * @param {string|null} proxyUrl - Proxy URL if configured
 * @returns {Promise<Object>} Aggregated sync stats
 */
async function syncAllAccounts(proxyUrl = null) {
  console.log('[MessageSync] Starting sync for all accounts...');
  
  const accountIds = (process.env.ACCOUNT_IDS ?? '').split(',').filter(Boolean);
  
  if (accountIds.length === 0) {
    console.warn('[MessageSync] No accounts configured in ACCOUNT_IDS');
    return {
      totalAccounts: 0,
      results: [],
    };
  }

  const results = [];
  
  // Sync accounts sequentially with staggered timing to respect rate limits
  for (const accountId of accountIds) {
    try {
      const accountStats = await syncAccount(accountId, proxyUrl);
      results.push(accountStats);
      
      // Stagger syncs: wait 2-3 minutes between accounts
      if (accountIds.indexOf(accountId) < accountIds.length - 1) {
        const staggerDelay = 120000 + Math.random() * 60000; // 2-3 minutes
        console.log(`[MessageSync] Waiting ${Math.round(staggerDelay/1000)}s before next account...`);
        await delay(staggerDelay);
      }
    } catch (error) {
      console.error(`[MessageSync] Failed to sync account ${accountId}:`, error);
      results.push({
        accountId,
        error: error.message,
        errors: [{ fatal: true, error: error.message }],
      });
    }
  }

  const aggregated = {
    totalAccounts: accountIds.length,
    successfulAccounts: results.filter(r => !r.errors || r.errors.length === 0).length,
    totalConversations: results.reduce((sum, r) => sum + (r.conversationsProcessed || 0), 0),
    totalNewMessages: results.reduce((sum, r) => sum + (r.newMessages || 0), 0),
    totalErrors: results.reduce((sum, r) => sum + (r.errors?.length || 0), 0),
    results,
    syncedAt: new Date().toISOString(),
  };

  console.log('[MessageSync] All accounts sync completed:', aggregated);
  
  return aggregated;
}

/**
 * Delay helper function
 * @param {number} minMs - Minimum delay in milliseconds
 * @param {number} maxMs - Maximum delay in milliseconds (optional)
 * @returns {Promise<void>}
 */
function delay(minMs, maxMs) {
  const delayMs = maxMs ? minMs + Math.random() * (maxMs - minMs) : minMs;
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

module.exports = {
  syncAccount,
  syncAllAccounts,
};
