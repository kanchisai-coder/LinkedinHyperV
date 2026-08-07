'use strict';

const fs = require('fs');
const path = require('path');
const { getAccountContext, cleanupContext, withAccountLock } = require('../browser');
const { loadCookies, saveCookies } = require('../session');
const { delay, humanClick, humanType } = require('../humanBehavior');
const { checkAndIncrement, checkOnly } = require('../rateLimit');
const { getRedis } = require('../redisClient');

const COMPOSER_SELECTORS = [
  '.msg-form__contenteditable',
  '[data-view-name="messaging-compose-box"] [contenteditable]',
  '[contenteditable][role="textbox"]',
  'div[role="textbox"][contenteditable="true"]',
  '.msg-form textarea',
  '.msg-form__msg-content-container textarea',
  '[data-view-name="messaging-compose-box"] textarea',
].join(', ');

const DEBUG_SCREENSHOT_DIR =
  process.env.LI_DEBUG_SCREENSHOT_DIR || '/tmp/linkedin-hyper-debug';

function ensureDebugDir() {
  try {
    fs.mkdirSync(DEBUG_SCREENSHOT_DIR, { recursive: true });
  } catch (_) {}
}

function safeName(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

async function captureFailureScreenshot(page, accountId, label) {
  try {
    if (!page || page.isClosed?.()) return null;
    ensureDebugDir();
    const filename = `${safeName(accountId)}-${Date.now()}-${safeName(label)}.png`;
    const filePath = path.join(DEBUG_SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    console.warn(`[sendMessage:${accountId}] screenshot saved: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(
      `[sendMessage:${accountId}] screenshot capture failed: ${String(err?.message || err)}`
    );
    return null;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isGenericUiLabel(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return true;

  if (/^\d+$/.test(normalized)) return true;
  if (/^\d+\s*(notification|notifications|message|messages)(\s+total)?$/.test(normalized)) return true;
  if (/^(notification|notifications|message|messages)\s+total$/.test(normalized)) return true;

  const blocked = new Set([
    'unknown',
    'inbox',
    'messages',
    'activity',
    'notifications',
    'notifications total',
    'loading',
    'linkedin',
    'feed',
    'search',
  ]);
  return blocked.has(normalized);
}

function deriveNameFromProfileUrl(profileUrl) {
  const match = String(profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match?.[1]) return 'Unknown';

  const slugName = normalizeText(
    decodeURIComponent(match[1])
      .replace(/[-_]+/g, ' ')
      .replace(/\b\d+\b/g, '')
  );
  return slugName || 'Unknown';
}

function normalizeParticipantName(candidate, profileUrl) {
  const parsed = normalizeText(candidate);
  if (parsed && !isGenericUiLabel(parsed)) {
    return parsed;
  }
  return deriveNameFromProfileUrl(profileUrl);
}

async function getMessageSnapshot(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const nodes = Array.from(
      document.querySelectorAll(
        [
          '.msg-s-message-list__event--own-turn .msg-s-event__content',
          '[data-view-name="messaging-self-message"] .msg-s-event__content',
          '.msg-s-event-listitem .msg-s-event__content',
          '[data-view-name="messaging-message-list-item"] .msg-s-event__content',
          '.msg-s-event__content',
        ].join(', ')
      )
    );
    const texts = nodes.map((node) => normalize(node?.textContent)).filter(Boolean);
    return {
      count: texts.length,
      lastText: texts.length > 0 ? texts[texts.length - 1] : '',
      recentTexts: texts.slice(-30),
    };
  });
}

async function verifyMessageEcho(page, text, beforeSnapshot, timeoutMs = 12000) {
  const target = normalizeText(text);
  if (!target) return false;
  const beforeCount = Number(beforeSnapshot?.count || 0);
  const beforeLastText = normalizeText(beforeSnapshot?.lastText);
  const beforeRecentTexts = Array.isArray(beforeSnapshot?.recentTexts)
    ? beforeSnapshot.recentTexts.map((item) => normalizeText(item)).filter(Boolean)
    : [];

  try {
    await page.waitForFunction(
      (needle, oldCount, oldLastText, oldRecentTexts) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const nodes = Array.from(
          document.querySelectorAll(
            [
              '.msg-s-message-list__event--own-turn .msg-s-event__content',
              '[data-view-name="messaging-self-message"] .msg-s-event__content',
              '.msg-s-event-listitem .msg-s-event__content',
              '[data-view-name="messaging-message-list-item"] .msg-s-event__content',
              '.msg-s-event__content',
            ].join(', ')
          )
        );
        const texts = nodes.map((node) => normalize(node?.textContent)).filter(Boolean);
        if (texts.length === 0) return false;

        const oldRecent = Array.isArray(oldRecentTexts) ? oldRecentTexts.map((item) => normalize(item)) : [];
        const oldRecentSet = new Set(oldRecent);
        const lastOwnText = normalize(texts[texts.length - 1]);
        const normalizedNeedle = normalize(needle);
        const matchingTexts = texts.filter((item) =>
          item.includes(normalizedNeedle) || normalizedNeedle.includes(item)
        );
        if (matchingTexts.length === 0) return false;

        const hasNewMatchingText = matchingTexts.some((item) => !oldRecentSet.has(item));
        const countIncreased = texts.length > Number(oldCount || 0);
        const changedFromPrevious = lastOwnText !== normalize(oldLastText || '');

        return hasNewMatchingText || countIncreased || changedFromPrevious;
      },
      text,
      beforeCount,
      beforeLastText,
      beforeRecentTexts,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}

async function confirmMessageVisibleInCurrentView(page, text, timeoutMs = 15000) {
  const target = normalizeText(text);
  if (!target) return false;

  try {
    await page.waitForFunction(
      (needle) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const targetText = normalize(needle);
        if (!targetText) return false;

        const nodes = Array.from(
          document.querySelectorAll(
            [
              '.msg-s-message-list__event--own-turn .msg-s-event__content',
              '[data-view-name="messaging-self-message"] .msg-s-event__content',
              '.msg-s-event-listitem .msg-s-event__content',
              '.msg-s-event-listitem .msg-s-event-listitem__body',
              '[data-view-name="messaging-message-list-item"] .msg-s-event__content',
              '[data-view-name="messaging-message-list-item"] .msg-s-event-listitem__body',
              '[data-view-name="messaging-message-list-item"] [dir]',
              '.msg-s-event__content',
              '[data-test-message-content]',
            ].join(', ')
          )
        );

        const hasDirectMatch = nodes.some((node) => {
          const value = normalize(node?.textContent);
          return value && (value.includes(targetText) || targetText.includes(value));
        });
        if (hasDirectMatch) return true;

        const rowNodes = Array.from(
          document.querySelectorAll('.msg-s-event-listitem, [data-view-name="messaging-message-list-item"]')
        );
        const hasRowMatch = rowNodes.some((row) => {
          const value = normalize(row?.textContent);
          return value && (value.includes(targetText) || targetText.includes(value));
        });
        if (hasRowMatch) return true;

        const listContainer = document.querySelector('.msg-s-message-list, [data-view-name="messaging-message-list"]');
        const listText = normalize(listContainer?.textContent);
        return Boolean(listText && (listText.includes(targetText) || targetText.includes(listText)));
      },
      text,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}

async function isComposerDraftCleared(page) {
  try {
    return await page.evaluate((selectors) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

      for (const selector of selectors.split(',').map((item) => item.trim()).filter(Boolean)) {
        const node = document.querySelector(selector);
        if (!node) continue;
        const value =
          node.tagName === 'TEXTAREA'
            ? normalize(node.value)
            : normalize(node.textContent);
        if (value) return false;
      }
      return true;
    }, COMPOSER_SELECTORS);
  } catch {
    return false;
  }
}

async function detectSendErrorBanner(page) {
  try {
    return await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const hay = normalize(document.body?.innerText || '');
      if (!hay) return false;

      const patterns = [
        'unable to send',
        'couldn\'t send',
        'could not send',
        'message not sent',
        'failed to send',
        'try again',
      ];

      return patterns.some((pattern) => hay.includes(pattern));
    });
  } catch {
    return false;
  }
}

async function confirmMessagePersistedInThread(page, chatId, text, timeoutMs = 15000) {
  const normalizedChatId = String(chatId || '').trim();
  const target = normalizeText(text);
  if (!normalizedChatId || !target) return false;

  try {
    await page.goto(`https://www.linkedin.com/messaging/thread/${normalizedChatId}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch (_) {
    // Continue and try selector-based confirmation from current DOM.
  }

  try {
    await page.waitForFunction(
      (needle) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const targetText = normalize(needle);
        if (!targetText) return false;

        const nodes = Array.from(
          document.querySelectorAll(
            [
              '.msg-s-message-list__event--own-turn .msg-s-event__content',
              '[data-view-name="messaging-self-message"] .msg-s-event__content',
              '.msg-s-event-listitem .msg-s-event__content',
              '[data-view-name="messaging-message-list-item"] .msg-s-event__content',
              '.msg-s-event__content',
            ].join(', ')
          )
        );

        return nodes.some((node) => {
          const value = normalize(node?.textContent);
          return value && (value.includes(targetText) || targetText.includes(value));
        });
      },
      text,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}

function isRecoverableBrowserError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return false;

  return (
    msg === 'operation failed' ||
    msg.includes('operation failed') ||
    msg.includes('err_too_many_redirects') ||
    msg.includes('too many redirects') ||
    msg.includes('session closed') ||
    msg.includes('frame was detached') ||
    msg.includes('target page, context or browser has been closed') ||
    msg.includes('protocol error (page.createisolatedworld)') ||
    msg.includes('protocol error (page.addscripttoevaluateonnewdocument)') ||
    msg.includes('net::err_aborted')
  );
}

async function sendMessageInternal({ accountId, chatId, text, proxyUrl, __attempt = 1 }) {
  const { context, cookiesLoaded } = await getAccountContext(accountId, proxyUrl);
  let page;

  try {
    if (!cookiesLoaded) {
      const cookies = await loadCookies(accountId);
      if (!cookies) {
        const err = new Error(`No session for account ${accountId}`);
        err.code = 'NO_SESSION';
        err.status = 401;
        throw err;
      }
      await context.addCookies(cookies);
    }
    page = await context.newPage();

    const normalizedChatId = String(chatId || '').replace(new RegExp(`^${accountId}:`), '');

    await page.goto(`https://www.linkedin.com/messaging/thread/${normalizedChatId}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await delay(2000, 4000);

    await page.waitForSelector(COMPOSER_SELECTORS, { timeout: 10000 }).catch(() => null);

    const beforeSnapshot = await getMessageSnapshot(page).catch(() => ({ count: 0, lastText: '', recentTexts: [] }));
    await humanType(page, COMPOSER_SELECTORS, text);
    await delay(800, 1800);

    await humanClick(page, '.msg-form__send-button, button[type="submit"][aria-label*="Send"]');
    await delay(1200, 2200);

    const verified = await verifyMessageEcho(page, text, beforeSnapshot);
    if (!verified) {
      const err = new Error('Message send could not be confirmed in thread. Retry once with fresh session.');
      err.code = 'SEND_NOT_CONFIRMED';
      err.status = 502;
      throw err;
    }

    const visibleInCurrentThread = await confirmMessageVisibleInCurrentView(page, text, 10000);
    const composerCleared = await isComposerDraftCleared(page);
    const hasSendErrorBanner = await detectSendErrorBanner(page);

    let deliveryState = 'accepted';
    if (!visibleInCurrentThread && hasSendErrorBanner) {
      const screenshotPath = await captureFailureScreenshot(page, accountId, 'send-error-banner');
      const err = new Error(
        'LinkedIn reported a send failure after the send button was clicked.' +
        (screenshotPath ? ` Screenshot: ${screenshotPath}` : '')
      );
      err.code = 'SEND_NOT_CONFIRMED';
      err.status = 502;
      throw err;
    }

    const persisted = await confirmMessagePersistedInThread(page, normalizedChatId, text, 15000);
    if (!persisted) {
      if ((visibleInCurrentThread || composerCleared) && !hasSendErrorBanner) {
        deliveryState = 'accepted_unverified';
      } else {
        const screenshotPath = await captureFailureScreenshot(page, accountId, 'message-not-found-after-send');
        const err = new Error(
          'Message was not found in thread after send confirmation. Message may not be delivered.' +
          (screenshotPath ? ` Screenshot: ${screenshotPath}` : '')
        );
        err.code = 'SEND_NOT_CONFIRMED';
        err.status = 502;
        throw err;
      }
    }

    await checkAndIncrement(accountId, 'messagesSent');
    await delay(500, 1200);

    if (process.env.REFRESH_SESSION_COOKIES === '1') {
      await saveCookies(accountId, await context.cookies(), {
        skipIfMissingAuthCookies: true,
        source: 'sendMessage',
      });
    }

    const msgId = `sent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let participantName = 'Unknown';
    let profileUrl = null;
    try {
      const nameEl = await page.$('.msg-thread__name, .msg-entity-lockup__entity-title');
      if (nameEl) {
        const nameText = await nameEl.textContent();
        if (nameText) participantName = normalizeText(nameText);

        const linkEl = await page.$(
          '.msg-entity-lockup__entity-title-container a[href*="/in/"], .msg-thread__link[href*="/in/"]'
        );
        if (linkEl) {
          const href = await linkEl.getAttribute('href');
          if (href) profileUrl = new URL(href, 'https://www.linkedin.com').href;
        }
      }
    } catch (_) {}

    participantName = normalizeParticipantName(participantName, profileUrl);

    const redis = getRedis();
    const entry = JSON.stringify({
      type: 'messageSent',
      accountId,
      targetName: participantName,
      targetProfileUrl: profileUrl || '',
      textPreview: (text || '').slice(0, 200),
      messageLength: text ? text.length : 0,
      timestamp: Date.now(),
    });
    await redis.lpush(`activity:log:${accountId}`, entry);
    await redis.ltrim(`activity:log:${accountId}`, 0, 999);
    await redis.incr(`stats:messages:${accountId}`);

    return {
      id: msgId,
      chatId: normalizedChatId,
      senderId: '__self__',
      text,
      createdAt: new Date().toISOString(),
      isRead: true,
      success: true,
      deliveryState,
    };
  } catch (err) {
    if (__attempt < 3 && isRecoverableBrowserError(err)) {
      await cleanupContext(accountId).catch(() => {});
      await delay(700 + (__attempt * 300), 1300 + (__attempt * 300));
      return sendMessageInternal({ accountId, chatId, text, proxyUrl, __attempt: __attempt + 1 });
    }

    const msg = String(err?.message || err || '');
    if (msg.toLowerCase().includes('err_too_many_redirects') || msg.toLowerCase().includes('too many redirects')) {
      const wrapped = new Error(
        `LinkedIn redirected too many times for account ${accountId}. Session is likely invalid or challenged. Re-import cookies and retry.`
      );
      wrapped.code = 'SESSION_EXPIRED';
      wrapped.status = 401;
      throw wrapped;
    }
    if (msg.toLowerCase().includes('operation failed')) {
      const wrapped = new Error(
        'LinkedIn UI transient failure while sending message. Please retry once with fresh cookies.'
      );
      wrapped.code = 'SEND_NOT_CONFIRMED';
      wrapped.status = 502;
      throw wrapped;
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function sendMessage({ accountId, chatId, text, proxyUrl }) {
  return withAccountLock(accountId, async () => {
    // Pre-gate before any browser work; quota is committed after confirmed send.
    await checkOnly(accountId, 'messagesSent');
    return sendMessageInternal({ accountId, chatId, text, proxyUrl, __attempt: 1 });
  });
}

module.exports = { sendMessage };
