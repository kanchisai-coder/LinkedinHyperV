// FILE: worker/src/db/repositories/MessageRepository.js
// Repository for Conversation and Message database operations

'use strict';

const { getPrisma } = require('../prisma');
const { buildMessageDedupeKey, isDurableLinkedInMessageId, stableHash } = require('../../unified/normalizer');

function normalizeConversationName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

function isGenericConversationName(name) {
  const normalized = normalizeConversationName(name).toLowerCase();
  return [
    '',
    'unknown',
    'messaging',
    'linkedin',
    'linkedin messaging',
    'messages',
  ].includes(normalized);
}

function computeConversationQuality(data) {
  const externalId = String(data?.externalId || '');
  const participantName = normalizeConversationName(data?.participantName);
  let score = 0;
  if (data?.participantProfileUrl) score += 50;
  if (data?.threadUrl) score += 30;
  if (data?.lastMessageText) score += 20;
  if (!externalId.startsWith('fallback-')) score += 25;
  if ((data?.messageCount || 0) > 0) score += 30;
  if (data?.syncState === 'available') score += 20;
  if (data?.syncState === 'partial') score += 10;
  if (participantName && !isGenericConversationName(participantName)) score += 15;
  if (data?.replacedByConversationId) score -= 100;
  return score;
}

function normalizeMessageText(text) {
  let normalized = String(text || '').replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/^(?:[^\p{L}\p{N}]{0,16}\s*)?Open Emoji Keyboard\s*/iu, '');
  normalized = normalized.replace(/\s+Download$/i, '').trim();
  return normalized;
}

function markPersistResult(row, created) {
  if (!row) return row;
  Object.defineProperty(row, '__created', {
    value: Boolean(created),
    enumerable: false,
    configurable: true,
  });
  return row;
}

function safeConfidence(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function isVisibleMessage(message) {
  return String(message?.visibilityState || 'visible') === 'visible' && message?.isCanonical !== false;
}

function rankMessageForSurvival(message) {
  return (
    (isDurableLinkedInMessageId(message.externalId || message.linkedinMessageId) ? 100 : 0) +
    (safeConfidence(message.identityConfidence) * 30) +
    (safeConfidence(message.senderConfidence) * 20) +
    (safeConfidence(message.timestampConfidence) * 10) +
    (message.raw?.eventUrn ? 12 : 0) +
    (message.raw?.domId ? 6 : 0) +
    (message.source === 'optimistic' ? -5 : 0) +
    (message.senderName && message.senderName !== 'Unknown' ? 3 : 0)
  );
}

function dedupeMessageRows(rows, limit) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = row.dedupeKey
      ? `dedupe:${row.dedupeKey}`
      : isDurableLinkedInMessageId(row.externalId)
        ? `external:${row.externalId}`
        : row.contentHash
          ? `hash:${row.contentHash}`
          : `legacy:${row.senderId}|${normalizeMessageText(row.text)}|${new Date(row.sentAt).toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

class MessageRepository {
  /**
   * Upsert a conversation (create if not exists, update if exists)
   * @param {Object} data - Conversation data
   * @returns {Promise<Object>} Conversation object
   */
  async upsertConversation(data) {
    const prisma = getPrisma();
    
    const {
      id,
      accountId,
      participantName,
      threadUrl,
      participantProfileUrl,
      participantAvatarUrl,
      lastMessageAt,
      lastMessageText,
      lastMessageSentByMe,
      syncState,
      resolutionState,
      messageCount,
      messageCountCanonical,
      lastResolvedAt,
      resolveAttempts,
      resolveError,
      shellReason,
      replacedByConversationId,
      hiddenReason,
      sourceQuality,
      lastResolveDurationMs,
      externalId,
      contentHash,
      source,
      lastSeenAt,
      syncCursor,
      hasMoreHistory,
    } = data;

    const hasResolveError = Object.prototype.hasOwnProperty.call(data, 'resolveError');

    return await prisma.conversation.upsert({
      where: { id },
      update: {
        participantName,
        threadUrl: threadUrl || undefined,
        participantProfileUrl,
        participantAvatarUrl,
        // Do NOT let a shell/empty delta item blank an existing preview or jump
        // lastMessageAt to now(). Only write these when the incoming item
        // actually carries message text (Prisma undefined = no change).
        lastMessageAt: lastMessageText ? lastMessageAt : undefined,
        lastMessageText: lastMessageText ? lastMessageText : undefined,
        lastMessageSentByMe: lastMessageText ? lastMessageSentByMe : undefined,
        syncState: syncState || undefined,
        resolutionState: resolutionState || syncState || undefined,
        messageCount: typeof messageCount === 'number' ? messageCount : undefined,
        messageCountCanonical: typeof messageCountCanonical === 'number' ? messageCountCanonical : undefined,
        lastResolvedAt: lastResolvedAt || undefined,
        resolveAttempts: typeof resolveAttempts === 'number' ? resolveAttempts : undefined,
        resolveError: hasResolveError ? (resolveError || null) : undefined,
        shellReason: Object.prototype.hasOwnProperty.call(data, 'shellReason')
          ? (shellReason || null)
          : undefined,
        replacedByConversationId: Object.prototype.hasOwnProperty.call(data, 'replacedByConversationId')
          ? (replacedByConversationId || null)
          : undefined,
        hiddenReason: Object.prototype.hasOwnProperty.call(data, 'hiddenReason')
          ? (hiddenReason || null)
          : undefined,
        sourceQuality: typeof sourceQuality === 'number'
          ? sourceQuality
          : computeConversationQuality({
            externalId,
            participantName,
            participantProfileUrl,
            threadUrl,
            lastMessageText,
            messageCount,
            syncState,
            replacedByConversationId,
          }),
        lastResolveDurationMs: typeof lastResolveDurationMs === 'number' ? lastResolveDurationMs : undefined,
        externalId: externalId || undefined,
        contentHash: contentHash || undefined,
        source: source || undefined,
        lastSeenAt: lastSeenAt || new Date(),
        syncCursor: syncCursor || undefined,
        hasMoreHistory: typeof hasMoreHistory === 'boolean' ? hasMoreHistory : undefined,
        updatedAt: new Date(),
      },
      create: {
        id,
        accountId,
        externalId: externalId || null,
        threadUrl: threadUrl || null,
        participantName,
        participantProfileUrl: participantProfileUrl || null,
        participantAvatarUrl: participantAvatarUrl || null,
        lastMessageAt,
        lastMessageText,
        lastMessageSentByMe,
        syncState: syncState || 'shell_only',
        resolutionState: resolutionState || syncState || 'shell_only',
        messageCount: typeof messageCount === 'number' ? messageCount : 0,
        messageCountCanonical: typeof messageCountCanonical === 'number' ? messageCountCanonical : 0,
        lastResolvedAt: lastResolvedAt || null,
        resolveAttempts: typeof resolveAttempts === 'number' ? resolveAttempts : 0,
        resolveError: typeof resolveError === 'string' ? resolveError : null,
        shellReason: typeof shellReason === 'string' ? shellReason : null,
        replacedByConversationId: replacedByConversationId || null,
        hiddenReason: hiddenReason || null,
        sourceQuality: typeof sourceQuality === 'number'
          ? sourceQuality
          : computeConversationQuality({
            externalId,
            participantName,
            participantProfileUrl,
            threadUrl,
            lastMessageText,
            messageCount,
            syncState,
            replacedByConversationId,
          }),
        lastResolveDurationMs: typeof lastResolveDurationMs === 'number' ? lastResolveDurationMs : null,
        contentHash: contentHash || null,
        source: source || 'linkedin',
        lastSeenAt: lastSeenAt || new Date(),
        syncCursor: syncCursor || null,
        hasMoreHistory: Boolean(hasMoreHistory),
      },
    });
  }

  /**
   * Upsert a message (create if not exists, ignore if duplicate)
   * Uses composite unique constraint: conversationId + sentAt + text
   * @param {Object} data - Message data
   * @returns {Promise<Object>} Message object
   */
  async upsertMessage(data) {
    const prisma = getPrisma();
    
    const {
      conversationId,
      accountId,
      senderId,
      senderName,
      text,
      sentAt,
      isSentByMe,
      linkedinMessageId,
      externalId,
      dedupeKey,
      contentHash,
      raw,
      source,
      visibilityState,
      isCanonical,
      identityConfidence,
      senderConfidence,
      timestampConfidence,
      observedAt,
      sourceRunId,
    } = data;

    const normalizedText = normalizeMessageText(text);
    const sentAtDate = new Date(sentAt);
    const observedAtDate = observedAt ? new Date(observedAt) : new Date();
    const nextVisibilityState = visibilityState || 'visible';
    const nextIsCanonical = isCanonical !== false && nextVisibilityState === 'visible';
    const nextIdentityConfidence = safeConfidence(identityConfidence, nextIsCanonical ? 1 : 0);
    const nextSenderConfidence = safeConfidence(senderConfidence, nextIsCanonical ? 1 : 0);
    const nextTimestampConfidence = safeConfidence(timestampConfidence, nextIsCanonical ? 1 : 0);
    const tenMinutesMs = 10 * 60 * 1000;
    const durableExternalId = isDurableLinkedInMessageId(externalId || linkedinMessageId)
      ? (externalId || linkedinMessageId)
      : null;
    const canonicalDedupeKey = dedupeKey || buildMessageDedupeKey({
      accountId,
      conversationId,
      externalId: durableExternalId,
      senderId,
      senderName,
      text: normalizedText,
      sentAt: sentAtDate,
      createdAt: sentAtDate,
      timeText: raw?.timeText || '',
      positionHint: raw?.positionHint,
      isOptimistic: source === 'optimistic' || String(externalId || linkedinMessageId || '').startsWith('optimistic-'),
      source: source || 'linkedin',
    });

    const observationPayload = {
      accountId,
      conversationId,
      externalId: durableExternalId,
      senderId,
      senderName,
      text: normalizedText,
      observedAt: observedAtDate,
      sentAt: Number.isNaN(sentAtDate.getTime()) ? null : sentAtDate,
      identityConfidence: nextIdentityConfidence,
      senderConfidence: nextSenderConfidence,
      timestampConfidence: nextTimestampConfidence,
      visibilityState: nextVisibilityState === 'visible' ? 'visible' : 'pending_repair',
      // NOTE: observedAt is intentionally EXCLUDED from the content hash. The
      // row is keyed by @@unique([accountId, contentHash]); including the
      // per-sync observedAt made every re-observation hash uniquely, so a new
      // row was inserted on every sync (unbounded growth + write amplification).
      // Excluding it lets an identical re-observation update the same row.
      contentHash: stableHash({
        accountId,
        conversationId,
        externalId: durableExternalId,
        senderId,
        senderName,
        text: normalizedText,
        source: source || 'linkedin',
        raw,
      }),
      payload: raw || {},
      source: source || 'linkedin',
    };

    const persistObservation = async (messageId = null) => {
      await prisma.messageObservation.upsert({
        where: {
          accountId_contentHash: {
            accountId,
            contentHash: observationPayload.contentHash,
          },
        },
        update: {
          conversationId,
          messageId: messageId || undefined,
          externalId: durableExternalId || undefined,
          senderId,
          senderName,
          text: normalizedText,
          observedAt: observedAtDate,
          sentAt: Number.isNaN(sentAtDate.getTime()) ? undefined : sentAtDate,
          identityConfidence: nextIdentityConfidence,
          senderConfidence: nextSenderConfidence,
          timestampConfidence: nextTimestampConfidence,
          visibilityState: observationPayload.visibilityState,
          payload: raw || {},
          source: source || 'linkedin',
        },
        create: {
          ...observationPayload,
          messageId,
        },
      }).catch(() => null);
    };

    const buildUpdateData = (existing = {}) => ({
      conversationId,
      accountId,
      senderId,
      senderName,
      text: normalizedText,
      // Never let a re-observed message with no real timestamp overwrite a
      // stored sentAt with a fresh now(). Undated messages (timestampConfidence
      // 0) get sentAtDate=now() from bestEffortMessageDate; on every subsequent
      // sync that would re-stamp the row and float it to the top of the inbox.
      // Only overwrite when this observation carries a real timestamp; otherwise
      // keep the existing value (a brand-new row still gets now() on create).
      sentAt: nextTimestampConfidence > 0 ? sentAtDate : (existing.sentAt || sentAtDate),
      isSentByMe,
      linkedinMessageId: linkedinMessageId || existing.linkedinMessageId || null,
      externalId: externalId || linkedinMessageId || existing.externalId || null,
      dedupeKey: canonicalDedupeKey || existing.dedupeKey || null,
      contentHash: contentHash || existing.contentHash || null,
      raw: raw || existing.raw || null,
      source: source || existing.source || 'linkedin',
      visibilityState: nextVisibilityState,
      isCanonical: nextIsCanonical,
      identityConfidence: nextIdentityConfidence,
      senderConfidence: nextSenderConfidence,
      timestampConfidence: nextTimestampConfidence,
      observedAt: observedAtDate,
      sourceRunId: sourceRunId || existing.sourceRunId || null,
    });

    const resolveConflictTarget = async (finalData, excludedId = null) => {
      if (finalData?.dedupeKey) {
        const match = await prisma.message.findFirst({
          where: {
            accountId,
            conversationId: finalData.conversationId,
            dedupeKey: finalData.dedupeKey,
            ...(excludedId ? { id: { not: excludedId } } : {}),
          },
        });
        if (match) return match;
      }

      if (isDurableLinkedInMessageId(finalData?.externalId || finalData?.linkedinMessageId)) {
        const matchByExternal = await prisma.message.findFirst({
          where: {
            accountId,
            externalId: finalData.externalId || finalData.linkedinMessageId,
            ...(excludedId ? { id: { not: excludedId } } : {}),
          },
        });
        if (matchByExternal) return matchByExternal;
      }

      const matchByLegacy = await prisma.message.findUnique({
        where: {
          conversationId_sentAt_text: {
            conversationId: finalData.conversationId,
            sentAt: finalData.sentAt,
            text: finalData.text,
          },
        },
      }).catch(() => null);
      if (matchByLegacy && matchByLegacy.id !== excludedId) return matchByLegacy;

      return null;
    };

    const mergeConflictRecord = async (primaryRow, finalData) => {
      const conflictTarget = await resolveConflictTarget(finalData, primaryRow?.id || null);
      if (!conflictTarget) return null;

      const mergedData = {
        ...finalData,
        conversationId: finalData.conversationId || conflictTarget.conversationId,
        accountId: finalData.accountId || conflictTarget.accountId,
        senderId: finalData.senderId || conflictTarget.senderId,
        senderName: finalData.senderName || conflictTarget.senderName,
        text: finalData.text || conflictTarget.text,
        sentAt: finalData.sentAt || conflictTarget.sentAt,
        isSentByMe: typeof finalData.isSentByMe === 'boolean' ? finalData.isSentByMe : conflictTarget.isSentByMe,
        linkedinMessageId: finalData.linkedinMessageId || conflictTarget.linkedinMessageId || primaryRow?.linkedinMessageId || null,
        externalId: finalData.externalId || conflictTarget.externalId || primaryRow?.externalId || null,
        dedupeKey: finalData.dedupeKey || conflictTarget.dedupeKey || primaryRow?.dedupeKey || null,
        contentHash: finalData.contentHash || conflictTarget.contentHash || primaryRow?.contentHash || null,
        raw: finalData.raw || conflictTarget.raw || primaryRow?.raw || null,
        source: finalData.source || conflictTarget.source || primaryRow?.source || 'linkedin',
        visibilityState: finalData.visibilityState || conflictTarget.visibilityState || 'visible',
        isCanonical: finalData.isCanonical !== false && conflictTarget.isCanonical !== false,
        identityConfidence: Math.max(
          safeConfidence(finalData.identityConfidence, 0),
          safeConfidence(conflictTarget.identityConfidence, 0),
          safeConfidence(primaryRow?.identityConfidence, 0)
        ),
        senderConfidence: Math.max(
          safeConfidence(finalData.senderConfidence, 0),
          safeConfidence(conflictTarget.senderConfidence, 0),
          safeConfidence(primaryRow?.senderConfidence, 0)
        ),
        timestampConfidence: Math.max(
          safeConfidence(finalData.timestampConfidence, 0),
          safeConfidence(conflictTarget.timestampConfidence, 0),
          safeConfidence(primaryRow?.timestampConfidence, 0)
        ),
        observedAt: finalData.observedAt || conflictTarget.observedAt || primaryRow?.observedAt || observedAtDate,
        sourceRunId: finalData.sourceRunId || conflictTarget.sourceRunId || primaryRow?.sourceRunId || null,
      };

      let survivor;
      try {
        survivor = await prisma.message.update({
          where: { id: conflictTarget.id },
          data: mergedData,
        });
      } catch (error) {
        if (error?.code === 'P2002') {
          const secondaryTarget = await resolveConflictTarget(mergedData, conflictTarget.id);
          if (secondaryTarget) {
            await persistObservation(secondaryTarget.id).catch(() => null);
            const quarantineTargetId = primaryRow?.id && primaryRow.id !== secondaryTarget.id
              ? primaryRow.id
              : (conflictTarget.id !== secondaryTarget.id ? conflictTarget.id : null);
            if (quarantineTargetId) {
              await prisma.message.update({
                where: { id: quarantineTargetId },
                data: {
                  visibilityState: 'quarantined',
                  isCanonical: false,
                },
              }).catch(() => null);
            }
            return markPersistResult(secondaryTarget, false);
          }
        }
        throw error;
      }

      if (primaryRow?.id && primaryRow.id !== conflictTarget.id) {
        await prisma.message.update({
          where: { id: primaryRow.id },
          data: {
            visibilityState: 'quarantined',
            isCanonical: false,
          },
        }).catch(() => null);
      }

      await persistObservation(survivor.id);
      return markPersistResult(survivor, false);
    };

    const updateMessageSafely = async (existingRow, finalData) => {
      try {
        const updated = await prisma.message.update({
          where: { id: existingRow.id },
          data: finalData,
        });
        await persistObservation(updated.id);
        return markPersistResult(updated, false);
      } catch (error) {
        if (error?.code === 'P2002') {
          const merged = await mergeConflictRecord(existingRow, finalData);
          if (merged) return merged;
        }
        throw error;
      }
    };

    const createMessageSafely = async (createData) => {
      try {
        const created = await prisma.message.create({
          data: createData,
        });
        await persistObservation(created.id);
        return markPersistResult(created, true);
      } catch (error) {
        if (error?.code === 'P2002') {
          const merged = await mergeConflictRecord(null, createData);
          if (merged) return merged;
        }
        throw error;
      }
    };

    if (canonicalDedupeKey) {
      const existingByDedupeKey = await prisma.message.findFirst({
        where: {
          accountId,
          conversationId,
          dedupeKey: canonicalDedupeKey,
        },
      });
      if (existingByDedupeKey) {
        return updateMessageSafely(existingByDedupeKey, buildUpdateData(existingByDedupeKey));
      }
    }

    if (durableExternalId) {
      const existingByExternal = await prisma.message.findFirst({
        where: {
          accountId,
          externalId: durableExternalId,
        },
      });
      if (existingByExternal) {
        return updateMessageSafely(existingByExternal, {
          ...buildUpdateData(existingByExternal),
          conversationId,
          accountId,
          linkedinMessageId: durableExternalId || existingByExternal.linkedinMessageId,
          externalId: durableExternalId || existingByExternal.externalId,
        });
      }
    }

    if (contentHash) {
      const existingByHash = await prisma.message.findFirst({
        where: {
          conversationId,
          contentHash,
        },
      });
      if (existingByHash) {
        return updateMessageSafely(existingByHash, {
          ...buildUpdateData(existingByHash),
          conversationId,
          accountId,
          linkedinMessageId: durableExternalId || existingByHash.linkedinMessageId,
          externalId: durableExternalId || existingByHash.externalId,
        });
      }
    }

    const existingByVisibleIdentity = normalizedText
      ? await prisma.message.findFirst({
          where: {
            conversationId,
            senderId,
            text: normalizedText,
          },
          orderBy: [
            { externalId: 'desc' },
            { createdAt: 'asc' },
          ],
        })
      : null;
    if (existingByVisibleIdentity) {
      const keepExistingDurable = isDurableLinkedInMessageId(existingByVisibleIdentity.externalId || existingByVisibleIdentity.linkedinMessageId);
      return updateMessageSafely(existingByVisibleIdentity, {
        ...buildUpdateData(existingByVisibleIdentity),
        conversationId,
        accountId,
        linkedinMessageId: keepExistingDurable
          ? existingByVisibleIdentity.linkedinMessageId
          : (durableExternalId || existingByVisibleIdentity.linkedinMessageId),
        externalId: keepExistingDurable
          ? existingByVisibleIdentity.externalId
          : (durableExternalId || existingByVisibleIdentity.externalId),
      });
    }

    const shouldUseOwnSendFuzzyMatch =
      isSentByMe === true &&
      (
        source === 'optimistic' ||
        String(externalId || linkedinMessageId || '').startsWith('optimistic-') ||
        senderId === '__self__'
      );
    const existingFuzzy = shouldUseOwnSendFuzzyMatch
      ? await prisma.message.findFirst({
          where: {
            conversationId,
            senderId: '__self__',
            text: normalizedText,
            sentAt: {
              gte: new Date(sentAtDate.getTime() - tenMinutesMs),
              lte: new Date(sentAtDate.getTime() + tenMinutesMs),
            },
          },
        })
      : null;
    if (existingFuzzy) {
      return updateMessageSafely(existingFuzzy, {
        ...buildUpdateData(existingFuzzy),
        conversationId,
        accountId,
        linkedinMessageId: durableExternalId || existingFuzzy.linkedinMessageId,
        externalId: durableExternalId || existingFuzzy.externalId,
      });
    }

    try {
      const legacyWhere = {
        conversationId_sentAt_text: {
          conversationId,
          sentAt: sentAtDate,
          text: normalizedText,
        },
      };
      const existingByLegacyUnique = await prisma.message.findUnique({ where: legacyWhere });
      if (existingByLegacyUnique) {
        return updateMessageSafely(existingByLegacyUnique, {
          ...buildUpdateData(existingByLegacyUnique),
          conversationId,
          accountId,
          externalId: durableExternalId || undefined,
          dedupeKey: canonicalDedupeKey || undefined,
        });
      }

      return await createMessageSafely({
        conversationId,
        accountId,
        senderId,
        senderName,
        text: normalizedText,
        sentAt: sentAtDate,
        isSentByMe,
        linkedinMessageId: durableExternalId || null,
        externalId: durableExternalId || null,
        dedupeKey: canonicalDedupeKey || null,
        contentHash: contentHash || null,
        raw: raw || null,
        source: source || 'linkedin',
        visibilityState: nextVisibilityState,
        isCanonical: nextIsCanonical,
        identityConfidence: nextIdentityConfidence,
        senderConfidence: nextSenderConfidence,
        timestampConfidence: nextTimestampConfidence,
        observedAt: observedAtDate,
        sourceRunId: sourceRunId || null,
      });
    } catch (error) {
      // If message already exists with same timestamp and text, just skip
      if (error.code === 'P2002') {
        const conflict = await resolveConflictTarget({
          conversationId,
          accountId,
          senderId,
          senderName,
          text: normalizedText,
          sentAt: sentAtDate,
          isSentByMe,
          linkedinMessageId: durableExternalId || null,
          externalId: durableExternalId || null,
          dedupeKey: canonicalDedupeKey || null,
          contentHash: contentHash || null,
          raw: raw || null,
          source: source || 'linkedin',
          visibilityState: nextVisibilityState,
          isCanonical: nextIsCanonical,
          identityConfidence: nextIdentityConfidence,
          senderConfidence: nextSenderConfidence,
          timestampConfidence: nextTimestampConfidence,
          observedAt: observedAtDate,
          sourceRunId: sourceRunId || null,
        });
        if (conflict) {
          await persistObservation(conflict.id);
          return markPersistResult(conflict, false);
        }
        console.log(`[MessageRepository] Duplicate message skipped for conversation ${conversationId}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Get conversations by account with pagination
   * @param {string} accountId - Account ID
   * @param {number} limit - Number of conversations to return
   * @param {number} offset - Offset for pagination
   * @returns {Promise<Array>} Array of conversations
   */
  async getConversationsByAccount(accountId, limit = 50, offset = 0) {
    const prisma = getPrisma();
    
    return await prisma.conversation.findMany({
      where: { accountId },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Get all conversations (unified inbox)
   * @param {number} limit - Number of conversations to return
   * @param {number} offset - Offset for pagination
   * @returns {Promise<Array>} Array of conversations with account info
   */
  async getAllConversations(options = {}) {
    const prisma = getPrisma();

    const normalizedOptions = typeof options === 'number'
      ? { limit: options, offset: arguments[1] || 0 }
      : options;
    const {
      limit = 100,
      offset = 0,
      cursor = null,
      accountId,
      state = 'all',
      search = '',
      includeHidden = false,
    } = normalizedOptions;

    const where = {
      ...(accountId ? { accountId } : {}),
      ...(includeHidden ? {} : { replacedByConversationId: null }),
    };
    const and = [];

    if (state && state !== 'all') {
      if (state === 'ready') where.syncState = 'available';
      else if (state === 'needs_resolution') where.syncState = { in: ['shell_only', 'partial', 'resolving'] };
      else if (state === 'failed') where.syncState = 'failed';
      else where.syncState = state;
    }

    const trimmedSearch = String(search || '').trim();
    if (trimmedSearch) {
      and.push({
        OR: [
        { participantName: { contains: trimmedSearch, mode: 'insensitive' } },
        { participantProfileUrl: { contains: trimmedSearch, mode: 'insensitive' } },
        { lastMessageText: { contains: trimmedSearch, mode: 'insensitive' } },
        { accountId: { contains: trimmedSearch, mode: 'insensitive' } },
        ],
      });
    }

    if (cursor?.lastMessageAt && cursor?.id) {
      and.push({
        OR: [
        {
          lastMessageAt: { lt: new Date(cursor.lastMessageAt) },
        },
        {
          AND: [
            { lastMessageAt: new Date(cursor.lastMessageAt) },
            { id: { lt: String(cursor.id) } },
          ],
        },
        ],
      });
    }

    if (and.length > 0) {
      where.AND = and;
    }

    const fetchLimit = cursor?.lastMessageAt && cursor?.id
      ? Math.max(limit * 3, limit + 10)
      : limit;

    return await prisma.conversation.findMany({
      where,
      include: {
        // messageCount/messageCountCanonical columns are maintained, so the
        // per-row correlated COUNT subquery over the large messages table is
        // pure overhead on this hot, frequently-invalidated read.
        account: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
      orderBy: [
        { lastMessageAt: 'desc' },
        { id: 'desc' },
      ],
      take: fetchLimit,
      skip: cursor ? 0 : offset,
    });
  }

  /**
   * Get messages by conversation with pagination
   * @param {string} conversationId - Conversation ID
   * @param {number} limit - Number of messages to return
   * @param {number} offset - Offset for pagination
   * @returns {Promise<Array>} Array of messages
   */
  async getMessagesByConversation(conversationId, limit = 100, offset = 0) {
    const prisma = getPrisma();
    const rows = await prisma.message.findMany({
      where: {
        conversationId,
        visibilityState: 'visible',
        isCanonical: true,
      },
      orderBy: [
        { sentAt: 'asc' },
        { id: 'asc' },
      ],
      take: Math.max(limit * 2, limit),
      skip: offset,
    });

    return dedupeMessageRows(rows, limit);
  }

  async getMessagesPageByConversation(conversationId, options = {}) {
    const prisma = getPrisma();
    const {
      limit = 100,
      cursor = null,
    } = options;

    const where = {
      conversationId,
      visibilityState: 'visible',
      isCanonical: true,
    };

    if (cursor?.sentAt && cursor?.id) {
      where.OR = [
        {
          sentAt: { gt: new Date(cursor.sentAt) },
        },
        {
          AND: [
            { sentAt: new Date(cursor.sentAt) },
            { id: { gt: String(cursor.id) } },
          ],
        },
      ];
    }

    const rows = await prisma.message.findMany({
      where,
      orderBy: [
        { sentAt: 'asc' },
        { id: 'asc' },
      ],
      take: Math.max((limit * 3) + 1, limit + 1),
    });

    const deduped = dedupeMessageRows(rows, limit + 1);
    const hasMore = deduped.length > limit;
    const items = deduped.slice(0, limit);
    const nextRow = items[items.length - 1];
    const nextCursor = hasMore && nextRow
      ? {
          id: nextRow.id,
          sentAt: new Date(nextRow.sentAt).toISOString(),
        }
      : null;

    return {
      items,
      hasMore,
      nextCursor,
    };
  }

  /**
   * Get recent messages for an account since a timestamp
   * @param {string} accountId - Account ID
   * @param {Date} since - Timestamp to filter from
   * @returns {Promise<Array>} Array of messages
   */
  async getRecentMessages(accountId, since) {
    const prisma = getPrisma();
    
    return await prisma.message.findMany({
      where: {
        accountId,
        sentAt: {
          gte: since,
        },
      },
      orderBy: { sentAt: 'desc' },
    });
  }

  /**
   * Update conversation's last message info
   * @param {string} conversationId - Conversation ID
   * @param {Object} lastMessage - Last message data
   * @returns {Promise<Object>} Updated conversation
   */
  async updateConversationLastMessage(conversationId, lastMessage) {
    const prisma = getPrisma();
    
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(lastMessage.sentAt),
        lastMessageText: lastMessage.text,
        lastMessageSentByMe: lastMessage.sentByMe,
      },
    });
  }

  /**
   * Get conversation by ID
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<Object|null>} Conversation or null
   */
  async getConversationById(conversationId) {
    const prisma = getPrisma();
    
    // messageCount/messageCountCanonical are maintained columns; no _count needed.
    return await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
  }

  async listThreadResolutionCandidates({ accountId, conversationIds, limit = 25 }) {
    const prisma = getPrisma();
    const ids = Array.isArray(conversationIds)
      ? conversationIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];

    return prisma.conversation.findMany({
      where: {
        accountId,
        ...(ids.length > 0 ? { id: { in: ids } } : {}),
        replacedByConversationId: null,
        OR: [
          { syncState: { in: ['shell_only', 'failed'] } },
          { externalId: { startsWith: 'fallback-' } },
          {
            AND: [
              { syncState: 'partial' },
              { messageCount: { lte: 0 } },
            ],
          },
        ],
      },
      orderBy: [
        { sourceQuality: 'asc' },
        { lastResolvedAt: 'asc' },
        { lastMessageAt: 'desc' },
      ],
      take: limit,
    });
  }

  async mergeConversationInto(sourceId, targetId) {
    const prisma = getPrisma();
    if (!sourceId || !targetId || sourceId === targetId) {
      return { merged: false, messagesMoved: 0 };
    }

    const source = await prisma.conversation.findUnique({ where: { id: sourceId } });
    const target = await prisma.conversation.findUnique({ where: { id: targetId } });
    if (!source || !target) {
      return { merged: false, messagesMoved: 0 };
    }

    const moved = await prisma.message.updateMany({
      where: { conversationId: sourceId },
      data: { conversationId: targetId },
    });
    await this.refreshConversationDedupeKeys(targetId);
    const duplicatesQuarantined = await this.cleanupConversationDuplicates(targetId).catch(() => 0);
    await this.refreshConversationStats(targetId).catch(() => null);

    await prisma.conversation.update({
      where: { id: sourceId },
      data: {
        syncState: 'replaced',
        replacedByConversationId: targetId,
        hiddenReason: 'replaced',
        messageCount: 0,
        resolveError: null,
        updatedAt: new Date(),
      },
    }).catch(() => null);

    return { merged: true, messagesMoved: moved.count, duplicatesQuarantined };
  }

  /**
   * Count total conversations for an account
   * @param {string} accountId - Account ID
   * @returns {Promise<number>} Count of conversations
   */
  async countConversationsByAccount(accountId) {
    const prisma = getPrisma();
    
    return await prisma.conversation.count({
      where: { accountId },
    });
  }

  /**
   * Count total messages for a conversation
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<number>} Count of messages
   */
  async countMessagesByConversation(conversationId) {
    const prisma = getPrisma();
    
    return await prisma.message.count({
      where: {
        conversationId,
        visibilityState: 'visible',
        isCanonical: true,
      },
    });
  }

  async cleanupConversationDuplicates(conversationId) {
    const prisma = getPrisma();
    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [
        { sentAt: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });

    const seen = new Map();
    const duplicateIds = [];
    const quarantineIds = [];

    for (const message of messages) {
      const contentKey = message.contentHash
        ? `hash:${message.contentHash}`
        : null;
      const canonicalKey = message.dedupeKey
        ? `dedupe:${message.dedupeKey}`
        : null;
      const fuzzyKey = [
        'fuzzy',
        message.senderId || '',
        normalizeMessageText(message.text),
        Math.floor(new Date(message.sentAt).getTime() / (10 * 60 * 1000)),
      ].join('|');
      const key = canonicalKey || contentKey || fuzzyKey;

      if (seen.has(key)) {
        const existing = seen.get(key);
        const survivor = rankMessageForSurvival(existing) >= rankMessageForSurvival(message) ? existing : message;
        const duplicate = survivor.id === message.id ? existing : message;
        seen.set(key, survivor);
        duplicateIds.push(duplicate.id);
        continue;
      }
      seen.set(key, message);
    }

    if (duplicateIds.length === 0) {
      return 0;
    }

    const deleted = await prisma.message.updateMany({
      where: {
        id: { in: duplicateIds },
      },
      data: {
        visibilityState: 'quarantined',
        isCanonical: false,
      },
    });
    await this.refreshConversationStats(conversationId);

    return deleted.count;
  }

  async refreshConversationStats(conversationId) {
    const prisma = getPrisma();
    if (!conversationId) return null;
    const [count, latest] = await Promise.all([
      prisma.message.count({
        where: {
          conversationId,
          visibilityState: 'visible',
          isCanonical: true,
        },
      }),
      prisma.message.findFirst({
        where: {
          conversationId,
          visibilityState: 'visible',
          isCanonical: true,
        },
        orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    return prisma.conversation.update({
      where: { id: conversationId },
      data: {
        messageCount: count,
        messageCountCanonical: count,
        ...(latest
          ? {
              lastMessageAt: latest.sentAt,
              lastMessageText: latest.text,
              lastMessageSentByMe: latest.isSentByMe,
            }
          : {}),
        updatedAt: new Date(),
      },
    }).catch(() => null);
  }

  async refreshConversationDedupeKeys(conversationId) {
    const prisma = getPrisma();
    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    let updated = 0;
    for (const message of messages) {
      const nextDedupeKey = buildMessageDedupeKey({
        accountId: message.accountId,
        conversationId,
        externalId: isDurableLinkedInMessageId(message.externalId || message.linkedinMessageId)
          ? (message.externalId || message.linkedinMessageId)
          : null,
        senderId: message.senderId,
        senderName: message.senderName,
        text: message.text,
        sentAt: message.sentAt,
        createdAt: message.sentAt,
        timeText: message.raw?.timeText || '',
        positionHint: message.raw?.positionHint,
        isOptimistic: message.source === 'optimistic' || String(message.externalId || '').startsWith('optimistic-'),
        source: message.source || 'linkedin',
      });

      if (!nextDedupeKey || nextDedupeKey === message.dedupeKey) continue;
      await prisma.message.update({
        where: { id: message.id },
        data: { dedupeKey: nextDedupeKey },
      }).catch(() => null);
      updated += 1;
    }
    return updated;
  }

  async repairMessageDuplicates({ accountId = null, conversationId = null, dryRun = true } = {}) {
    const prisma = getPrisma();
    const where = {
      ...(accountId ? { accountId } : {}),
      ...(conversationId ? { conversationId } : {}),
    };
    const messages = await prisma.message.findMany({
      where,
      orderBy: [{ conversationId: 'asc' }, { sentAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    let rowsAssigned = 0;
    const grouped = new Map();
    const weakExactGrouped = new Map();
    const updates = [];
    const affectedConversationIds = new Set();

    for (const message of messages) {
      const durableExternalId = isDurableLinkedInMessageId(message.externalId || message.linkedinMessageId)
        ? (message.externalId || message.linkedinMessageId)
        : null;
      const nextDedupeKey = message.dedupeKey || buildMessageDedupeKey({
        accountId: message.accountId,
        conversationId: message.conversationId,
        externalId: durableExternalId,
        senderId: message.senderId,
        senderName: message.senderName,
        text: message.text,
        sentAt: message.sentAt,
        createdAt: message.sentAt,
        timeText: message.raw?.timeText || '',
        positionHint: message.raw?.positionHint,
        isOptimistic: message.source === 'optimistic' || String(message.externalId || '').startsWith('optimistic-'),
        source: message.source || 'linkedin',
      });
      if (!message.dedupeKey && nextDedupeKey) {
        rowsAssigned += 1;
        updates.push({ id: message.id, dedupeKey: nextDedupeKey });
        affectedConversationIds.add(message.conversationId);
      }
      const key = `${message.accountId}|${message.conversationId}|${nextDedupeKey || ''}`;
      const enriched = { ...message, externalId: durableExternalId, linkedinMessageId: durableExternalId, dedupeKey: nextDedupeKey };
      const bucket = grouped.get(key) || [];
      bucket.push(enriched);
      grouped.set(key, bucket);

      const weakExactKey = [
        message.accountId,
        message.conversationId,
        message.senderId || '',
        normalizeMessageText(message.text),
      ].join('|');
      const weakExactBucket = weakExactGrouped.get(weakExactKey) || [];
      weakExactBucket.push(enriched);
      weakExactGrouped.set(weakExactKey, weakExactBucket);
    }

    const duplicateIds = [];
    const quarantineIds = [];
    let ambiguousSkipped = 0;
    for (const group of grouped.values()) {
      if (group.length <= 1 || !group[0].dedupeKey) continue;
      const ranked = [...group].sort((a, b) => (
        rankMessageForSurvival(b) - rankMessageForSurvival(a)
        || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      ));
      const [survivor, ...rest] = ranked;
      if (!survivor || rest.length === 0) {
        ambiguousSkipped += group.length;
        continue;
      }
      duplicateIds.push(...rest.map((message) => message.id));
      for (const message of rest) affectedConversationIds.add(message.conversationId);
    }

    const duplicateIdSetFromDedupe = new Set(duplicateIds);
    for (const group of weakExactGrouped.values()) {
      if (group.length <= 1) continue;
      const ranked = [...group].sort((a, b) => (
        rankMessageForSurvival(b) - rankMessageForSurvival(a)
        || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      ));
      const [survivor, ...rest] = ranked;
      if (!survivor) continue;
      for (const message of rest) {
        if (duplicateIdSetFromDedupe.has(message.id)) continue;
        duplicateIds.push(message.id);
        duplicateIdSetFromDedupe.add(message.id);
        affectedConversationIds.add(message.conversationId);
      }
    }

    for (const message of messages) {
      const weakIdentity = safeConfidence(message.identityConfidence) < 0.7;
      const weakSender = safeConfidence(message.senderConfidence) < 0.45;
      const weakTimestamp = safeConfidence(message.timestampConfidence) <= 0;
      const unknownSender = !message.senderName || message.senderName === 'Unknown';
      if (weakIdentity || weakSender || (weakTimestamp && unknownSender)) {
        if (!duplicateIdSetFromDedupe.has(message.id)) {
          quarantineIds.push(message.id);
          affectedConversationIds.add(message.conversationId);
        }
      }
    }

    if (!dryRun) {
      const duplicateIdSet = new Set(duplicateIds);
      for (const update of updates) {
        if (duplicateIdSet.has(update.id)) continue;
        await prisma.message.update({
          where: { id: update.id },
          data: { dedupeKey: update.dedupeKey },
        }).catch(() => null);
      }
      if (duplicateIds.length > 0) {
        await prisma.message.updateMany({
          where: { id: { in: duplicateIds } },
          data: {
            visibilityState: 'quarantined',
            isCanonical: false,
          },
        });
      }
      if (quarantineIds.length > 0) {
        await prisma.message.updateMany({
          where: { id: { in: quarantineIds } },
          data: {
            visibilityState: 'quarantined',
            isCanonical: false,
          },
        });
      }
      // PERF (Phase 1.3): parallelize stats refresh in bounded chunks instead of
      // serial awaits. Each refreshConversationStats does 2 reads + 1 write.
      const STATS_CHUNK = Number.parseInt(process.env.STATS_REFRESH_CHUNK || '8', 10);
      const ids = Array.from(affectedConversationIds);
      for (let i = 0; i < ids.length; i += STATS_CHUNK) {
        const chunk = ids.slice(i, i + STATS_CHUNK);
        await Promise.all(chunk.map((id) => this.refreshConversationStats(id).catch(() => null)));
      }
    }

    return {
      dryRun,
      rowsScanned: messages.length,
      rowsAssigned,
      duplicatesCollapsed: duplicateIds.length,
      quarantined: quarantineIds.length,
      ambiguousSkipped,
    };
  }

  async getThreadResolutionStats(accountId) {
    const prisma = getPrisma();
    const where = accountId ? { accountId } : {};
    const [
      shellConversations,
      resolvingThreads,
      resolvedThreads,
      threadResolveFailures,
      messagesCaptured,
      quarantinedMessages,
      lastFailed,
    ] = await Promise.all([
      prisma.conversation.count({
        where: {
          ...where,
          OR: [
            { syncState: 'shell_only' },
            { externalId: { startsWith: 'fallback-' } },
          ],
        },
      }),
      prisma.conversation.count({ where: { ...where, syncState: 'resolving' } }),
      prisma.conversation.count({
        where: {
          ...where,
          OR: [
            { syncState: 'available' },
            { messageCount: { gt: 0 } },
          ],
        },
      }),
      prisma.conversation.count({ where: { ...where, syncState: 'failed' } }),
      prisma.message.count({
        where: {
          ...where,
          visibilityState: 'visible',
          isCanonical: true,
        },
      }),
      prisma.message.count({
        where: {
          ...where,
          visibilityState: 'quarantined',
        },
      }),
      prisma.conversation.findFirst({
        where: {
          ...where,
          syncState: 'failed',
          resolveError: { not: null },
        },
        orderBy: { updatedAt: 'desc' },
        select: { resolveError: true },
      }),
    ]);

    return {
      shellConversations,
      resolvingThreads,
      resolvedThreads,
      messagesCaptured,
      quarantinedMessages,
      threadResolveFailures,
      lastResolveError: lastFailed?.resolveError || null,
    };
  }

  /**
   * Delete old messages (cleanup) - optional retention policy
   * @param {number} retentionDays - Number of days to keep messages
   * @returns {Promise<number>} Number of deleted messages
   */
  async deleteOldMessages(retentionDays) {
    const prisma = getPrisma();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await prisma.message.deleteMany({
      where: {
        sentAt: {
          lt: cutoffDate,
        },
      },
    });

    return result.count;
  }

  /**
   * Get messages for export (all messages for an account or conversation)
   * @param {Object} options - Filter options
   * @returns {Promise<Array>} Array of messages with conversation info
   */
  async getMessagesForExport(options = {}) {
    const prisma = getPrisma();
    const { accountId, conversationId, limit, offset } = options;

    const where = {};
    if (accountId) where.accountId = accountId;
    if (conversationId) where.conversationId = conversationId;
    where.visibilityState = 'visible';
    where.isCanonical = true;

    return await prisma.message.findMany({
      where,
      include: {
        conversation: {
          select: {
            participantName: true,
            participantProfileUrl: true,
          },
        },
      },
      orderBy: { sentAt: 'asc' },
      take: limit,
      skip: offset,
    });
  }
}

module.exports = new MessageRepository();
