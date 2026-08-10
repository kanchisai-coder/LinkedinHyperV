'use strict';

const { getAccountContext, cleanupContext, withAccountLock } = require('../browser');
const { loadCookies, saveCookies } = require('../session');
const { delay, humanScroll } = require('../humanBehavior');

const THREAD_READ_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.THREAD_READ_TIMEOUT_MS || '45000', 10)
);
const THREAD_PAGE_TTL_MS = Math.max(
  15_000,
  parseInt(process.env.BROWSER_CONTEXT_TTL_MS || '60000', 10)
);
const BROWSER_FATAL_PATTERNS = [
  'page.addscriptt evaluateonnewdocument',
  'page.addscripttoevaluateonnewdocument',
  'execution context was destroyed',
  'frame was detached',
  'session closed',
  'target closed',
  'browser has been closed',
  'cannot find context with specified id',
  'protocol error',
];

function isAuthWall(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('/login')
    || value.includes('/checkpoint')
    || value.includes('/authwall')
    || value.includes('/challenge');
}

function isFallbackChatId(chatId) {
  return String(chatId || '').trim().startsWith('fallback-');
}

function extractThreadIdFromUrl(url) {
  const value = String(url || '');
  const directMatch = value.match(/\/messaging\/thread\/([^/?#]+)/i);
  if (directMatch?.[1]) return directMatch[1];

  const queryMatch = value.match(/[?&](?:conversationId|conversationUrn|threadId)=([^&#]+)/i);
  if (queryMatch?.[1]) {
    try {
      return decodeURIComponent(queryMatch[1]);
    } catch {
      return queryMatch[1];
    }
  }

  return '';
}

function accountNameMatchesSender(accountId, senderName) {
  const accountToken = String(accountId || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const senderToken = String(senderName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!accountToken || !senderToken) return false;
  if (senderToken === accountToken) return true;
  return senderToken.includes(accountToken);
}

const THREAD_ROW_SELECTOR = '.msg-conversation-listitem, [data-view-name="messaging-thread-list-item"], li:has(a[href*="/messaging/thread/"])';
const MESSAGE_LIST_SELECTOR = '.msg-s-message-list, [data-view-name="messaging-message-list"], .msg-thread, main';

function isExecutionContextLost(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('execution context was destroyed')
    || message.includes('cannot find context with specified id')
    || message.includes('frame was detached')
    || message.includes('navigation');
}

function isBrowserFatalError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return BROWSER_FATAL_PATTERNS.some((pattern) => message.includes(pattern))
    || message.includes('internal server error, session closed');
}

function buildTypedThreadError(code, message, status = 500, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, details);
  return err;
}

function classifyThreadFailure(err, stage) {
  if (!err) {
    return {
      code: 'THREAD_EXTRACTION_FAILED',
      status: 500,
      browserFatal: false,
      message: 'Unknown LinkedIn thread failure',
    };
  }

  if (err.code === 'NO_SESSION') {
    return { code: 'NO_SESSION', status: 401, browserFatal: false, message: err.message };
  }
  if (err.code === 'SESSION_EXPIRED') {
    return { code: 'SESSION_EXPIRED', status: 401, browserFatal: false, message: err.message };
  }
  if (err.code === 'THREAD_NOT_FOUND') {
    return { code: 'THREAD_NOT_FOUND', status: 404, browserFatal: false, message: err.message };
  }
  if (isBrowserFatalError(err)) {
    return {
      code: 'BROWSER_SESSION_CLOSED',
      status: 503,
      browserFatal: true,
      message: err.message || 'LinkedIn browser session closed while reading the thread.',
    };
  }

  const message = String(err.message || err);
  if (/timeout/i.test(message)) {
    return {
      code: stage === 'extractMessages' || stage === 'extractParticipant'
        ? 'THREAD_EXTRACTION_FAILED'
        : 'THREAD_OPEN_FAILED',
      status: 504,
      browserFatal: false,
      message,
    };
  }

  return {
    code: stage === 'extractMessages' || stage === 'extractParticipant'
      ? 'THREAD_EXTRACTION_FAILED'
      : 'THREAD_OPEN_FAILED',
    status: err.status || 500,
    browserFatal: false,
    message,
  };
}

async function withBrowserTimeout(stage, timeoutMs, fn) {
  let timer = null;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(buildTypedThreadError(
            stage === 'extractMessages' || stage === 'extractParticipant'
              ? 'THREAD_EXTRACTION_FAILED'
              : 'THREAD_OPEN_FAILED',
            `${stage} timed out after ${timeoutMs}ms`,
            504,
            { stage, timeoutMs }
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForMessagingInbox(page) {
  await page.waitForSelector(THREAD_ROW_SELECTOR, { timeout: 15000 }).catch(() => null);
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
  await delay(350, 750);
}

async function findBestThreadRow(page, { rawChatId, participantName, participantProfileUrl }) {
  const expectedName = String(participantName || '').trim().toLowerCase();
  const expectedProfileUrl = String(participantProfileUrl || '').trim().toLowerCase();
  const providedChatId = String(rawChatId || '').trim();

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await waitForMessagingInbox(page);
      const best = await page.evaluate(({ selector, providedChatId, expectedName, expectedProfileUrl }) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const absolute = (href) => {
          if (!href) return '';
          try {
            return new URL(href, 'https://www.linkedin.com').toString();
          } catch {
            return href;
          }
        };

        const rows = Array.from(document.querySelectorAll(selector));
        let selected = null;

        rows.forEach((row, rowIndex) => {
          const anchors = Array.from(row.querySelectorAll('a[href]'));
          const threadAnchor = anchors.find((anchor) => {
            const href = anchor.getAttribute('href') || '';
            return /\/messaging\/thread\//i.test(href) || /(?:conversationUrn|conversationId|threadId)=/i.test(href);
          }) || row.closest('a[href]');
          const threadHref = absolute(threadAnchor?.getAttribute('href') || threadAnchor?.href || '');
          const profileHref = absolute(
            anchors.find((anchor) => String(anchor.getAttribute('href') || '').includes('/in/'))?.getAttribute('href') || ''
          ).toLowerCase();
          const rowText = normalize(row.innerText || row.textContent || '');
          const name = normalize(
            row.querySelector('[data-anonymize="person-name"], .msg-conversation-listitem__participant-names, .msg-conversation-listitem__name, .truncate')?.textContent
          );
          const dataValues = [
            row.getAttribute('data-conversation-id'),
            row.getAttribute('data-urn'),
            row.getAttribute('data-id'),
            row.getAttribute('id'),
            threadHref,
          ].filter(Boolean).join(' ');

          let score = 0;
          if (providedChatId && dataValues.includes(providedChatId)) score += 120;
          if (expectedProfileUrl && profileHref === expectedProfileUrl) score += 90;
          if (expectedName && name === expectedName) score += 70;
          if (expectedName && rowText.includes(expectedName)) score += 45;
          if (threadHref) score += 10;
          if (rowText) score += 2;

          if (!selected || score > selected.score) {
            selected = { score, rowIndex, threadHref, rowText: rowText.slice(0, 240) };
          }
        });

        return selected;
      }, {
        selector: THREAD_ROW_SELECTOR,
        providedChatId,
        expectedName,
        expectedProfileUrl,
      });

      if (best?.score > 0) return best;
    } catch (err) {
      if (!isExecutionContextLost(err) || attempt === 4) throw err;
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
      await delay(500, 1000);
    }
  }

  return null;
}

async function openBestThreadRow(page, best) {
  const beforeUrl = page.url();

  if (Number.isInteger(best?.rowIndex)) {
    const row = page.locator(THREAD_ROW_SELECTOR).nth(best.rowIndex);
    try {
      await row.scrollIntoViewIfNeeded({ timeout: 5000 });
      await Promise.allSettled([
        page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 8000 }),
        row.click({ timeout: 8000 }),
      ]);
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
      await page.waitForSelector(MESSAGE_LIST_SELECTOR, { timeout: 12000 }).catch(() => null);
      const hasMessageSurface = await page.locator(MESSAGE_LIST_SELECTOR).first().isVisible({ timeout: 1500 }).catch(() => false);
      if (!isAuthWall(page.url()) && (hasMessageSurface || page.url() !== beforeUrl || extractThreadIdFromUrl(page.url()))) {
        return;
      }
    } catch (err) {
      if (!isExecutionContextLost(err)) {
        // Fall through to href navigation if LinkedIn swallowed the click.
      }
    }
  }

  if (best?.threadHref) {
    await page.goto(best.threadHref, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    return;
  }

  const err = new Error('Could not open resolved LinkedIn thread row');
  err.code = 'THREAD_OPEN_FAILED';
  err.status = 404;
  throw err;
}

async function gotoThreadOrInbox(page, { accountId, chatId, threadUrl, participantName, participantProfileUrl }) {
  const targetThreadUrl = String(threadUrl || '').trim();
  const rawChatId = String(chatId || '').trim();

  if (targetThreadUrl) {
    await page.goto(targetThreadUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!isAuthWall(page.url())) {
      return;
    }
  }

  if (rawChatId && !isFallbackChatId(rawChatId)) {
    await page.goto(`https://www.linkedin.com/messaging/thread/${rawChatId}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (!isAuthWall(page.url())) {
      return;
    }
  }

  await page.goto('https://www.linkedin.com/messaging/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  const best = await findBestThreadRow(page, {
    rawChatId,
    participantName,
    participantProfileUrl,
  });

  if (!best) {
    const err = new Error(`Could not resolve LinkedIn thread for account ${accountId}`);
    err.code = 'THREAD_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  await openBestThreadRow(page, best);
}

async function evaluateWithNavigationRetry(page, pageFunction, arg) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(pageFunction, arg);
    } catch (err) {
      if (!isExecutionContextLost(err) || attempt === 3) throw err;
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
      await delay(400, 900);
    }
  }
  return null;
}

async function extractParticipant(page) {
  return evaluateWithNavigationRetry(page, () => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const toAbsolute = (href) => {
      if (!href) return null;
      try {
        return new URL(href, 'https://www.linkedin.com').toString();
      } catch {
        return null;
      }
    };

    const scope = document.querySelector('.msg-thread, .msg-overlay-conversation-bubble-header, main') || document;
    const nameEl = scope.querySelector(
      '.msg-thread__name, .msg-entity-lockup__entity-title, [data-anonymize="person-name"], h1, h2, h3'
    );
    const profileLinkEl = scope.querySelector(
      '.msg-thread__link[href*="/in/"], .msg-entity-lockup__entity-title-container a[href*="/in/"], a[href*="/in/"]'
    );

    return {
      name: normalize(nameEl?.textContent) || normalize(profileLinkEl?.textContent) || 'Unknown',
      profileUrl: toAbsolute(profileLinkEl?.getAttribute('href') || ''),
    };
  });
}

async function extractMessages(page, limit) {
  return evaluateWithNavigationRetry(page, (maxItems) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const cleanMessageText = (value) => {
      let normalized = normalize(value);
      normalized = normalized.replace(/^(?:[^\p{L}\p{N}]{0,16}\s*)?Open Emoji Keyboard\s*/iu, '');
      normalized = normalized.replace(/\s+Download$/i, '').trim();
      return normalized;
    };
    const extractSenderId = (href) => {
      const match = String(href || '').match(/\/in\/([^/?#]+)/i);
      return match?.[1] || 'other';
    };
    const dateSeparatorSelectors = [
      '.msg-s-message-list__time-heading',
      '.msg-s-event-listitem__date-separator',
      '[data-view-name="message-list-date-divider"]',
      '.msg-s-message-group__timestamp',
    ];
    const rowSelector = '.msg-s-event-listitem, [data-view-name="messaging-message-list-item"]';
    const rows = Array.from(document.querySelectorAll(rowSelector)).filter((row) => !row.parentElement?.closest(rowSelector));
    const items = [];

    rows.slice(-maxItems).forEach((item, index) => {
      const groupRoot = item.closest('.msg-s-message-group') || item;
      const bodyCandidates = Array.from(item.querySelectorAll(
        '.msg-s-event__content, .msg-s-event-listitem__body, .msg-s-message-group__message-bubble, .msg-s-event-listitem__message-bubble'
      )).filter((node, bodyIndex, nodes) => nodes.findIndex((candidate) => candidate.isSameNode(node)) === bodyIndex);
      const bodyNodes = bodyCandidates.filter((node) => !bodyCandidates.some((candidate) => candidate !== node && node.contains(candidate)));

      if (bodyNodes.length === 0) {
        const fallbackBody = item.querySelector('p');
        if (fallbackBody) bodyNodes.push(fallbackBody);
      }

      const timeEl = item.querySelector('time') || groupRoot.querySelector('time');
      const senderLink = item.querySelector('.msg-s-message-group__profile-link, .msg-s-event__link, a[href*="/in/"]')
        || groupRoot.querySelector('.msg-s-message-group__profile-link, .msg-s-event__link, a[href*="/in/"]');
      const senderNameEl = item.querySelector(
        '.msg-s-message-group__name, .msg-s-message-group__profile-link, .msg-s-event__link, [data-anonymize="person-name"]'
      ) || groupRoot.querySelector(
        '.msg-s-message-group__name, .msg-s-message-group__profile-link, .msg-s-event__link, [data-anonymize="person-name"]'
      );
      const dateSeparatorEl = dateSeparatorSelectors
        .map((selector) => item.querySelector(selector) || groupRoot.querySelector(selector))
        .find(Boolean);
      const className = `${String(groupRoot.className || '')} ${String(item.className || '')}`.trim();
      const isSelf = className.includes('own-turn')
        || className.includes('self')
        || item.querySelector('[data-view-name="messaging-self-message"]') !== null
        || groupRoot.querySelector('[data-view-name="messaging-self-message"]') !== null;
      const baseEventUrn = item.getAttribute('data-event-urn')
        || item.getAttribute('data-urn')
        || groupRoot.getAttribute('data-event-urn')
        || groupRoot.getAttribute('data-urn')
        || '';
      const baseDomId = item.getAttribute('data-id')
        || item.getAttribute('id')
        || groupRoot.getAttribute('data-id')
        || groupRoot.getAttribute('id')
        || '';
      const timeText = normalize(timeEl?.textContent);
      const senderHref = senderLink?.getAttribute('href') || '';
      const senderName = isSelf ? '__self__' : (normalize(senderNameEl?.textContent) || 'Unknown');
      const dayLabel = normalize(dateSeparatorEl?.textContent);

      bodyNodes.forEach((bodyEl, bodyIndex) => {
        const bubbleRoot = bodyEl.closest('[data-event-urn], [data-urn], [data-id], [id]') || item;
        const bubbleEventUrn = bubbleRoot.getAttribute('data-event-urn')
          || bubbleRoot.getAttribute('data-urn')
          || baseEventUrn;
        const bubbleDomId = bubbleRoot.getAttribute('data-id')
          || bubbleRoot.getAttribute('id')
          || baseDomId;
        const stableId = bubbleEventUrn || bubbleDomId || '';
        const bubbleExternalId = stableId && bodyNodes.length > 1 ? `${stableId}#${bodyIndex}` : stableId;
        const text = cleanMessageText(bodyEl.textContent);
        if (!text) return;

        items.push({
          id: bubbleExternalId || `msg-row-${index}-${bodyIndex}`,
          chatId: '',
          senderId: isSelf ? '__self__' : extractSenderId(senderHref),
          text,
          createdAt: timeEl?.getAttribute('datetime') || null,
          senderName,
          isRead: true,
          externalId: bubbleExternalId || null,
          raw: {
            eventUrn: bubbleEventUrn || null,
            domId: bubbleDomId || null,
            timeText: timeText || null,
            dayLabel: dayLabel || null,
            senderHref: senderHref || null,
            positionHint: index * 10 + bodyIndex,
            className,
          },
        });
      });
    });

    return items;
  }, limit);
}

async function readThread({ accountId, chatId, threadUrl, participantName, participantProfileUrl, proxyUrl, limit = 50 }) {
  return withAccountLock(accountId, async () => {
    let context = null;
    let page;
    const diagnostics = {
      accountId,
      chatId: String(chatId || '').trim() || null,
      attemptedThreadUrl: String(threadUrl || '').trim() || null,
      participantName: participantName || null,
      browserFatal: false,
      stage: null,
    };

    try {
      const cookies = await loadCookies(accountId);
      if (!cookies) {
        throw buildTypedThreadError('NO_SESSION', `No session for account ${accountId}`, 401);
      }

      // Use the shared per-account context so thread reads present the SAME
      // deterministic fingerprint and per-account proxy as every other action
      // (previously readThread built a generic context — an automation tell).
      const acct = await getAccountContext(accountId, proxyUrl, { blockAssets: true });
      context = acct.context;
      if (!acct.cookiesLoaded) {
        await context.addCookies(cookies);
      }
      page = await context.newPage();
      page.setDefaultTimeout(THREAD_READ_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(THREAD_READ_TIMEOUT_MS);
      diagnostics.stage = 'resolveThread';
      await withBrowserTimeout('resolveThread', THREAD_READ_TIMEOUT_MS, async () => {
        await gotoThreadOrInbox(page, { accountId, chatId, threadUrl, participantName, participantProfileUrl });
      });

      const landingUrl = page.url();
      if (isAuthWall(landingUrl)) {
        throw buildTypedThreadError('SESSION_EXPIRED', `Session expired for account ${accountId}. Re-import cookies.`, 401);
      }
      diagnostics.threadUrl = landingUrl;

      diagnostics.stage = 'openThread';
      await withBrowserTimeout('openThread', THREAD_READ_TIMEOUT_MS, async () => {
        await delay(1200, 2200);
        await page.waitForSelector('.msg-s-message-list, [data-view-name="messaging-message-list"], main', {
          timeout: 15000,
        }).catch(() => null);
        await humanScroll(page, -500);
        await delay(800, 1400);
      });

      diagnostics.stage = 'extractParticipant';
      const participant = await withBrowserTimeout('extractParticipant', THREAD_READ_TIMEOUT_MS, () => extractParticipant(page));

      diagnostics.stage = 'extractMessages';
      const messages = await withBrowserTimeout('extractMessages', THREAD_READ_TIMEOUT_MS, () => extractMessages(page, limit));

      const resolvedChatId = extractThreadIdFromUrl(page.url()) || String(chatId || '').trim();
      diagnostics.resolvedChatId = resolvedChatId || null;
      (messages || []).forEach((message) => {
        if (accountNameMatchesSender(accountId, message.senderName)) {
          message.senderId = '__self__';
          message.senderName = accountId;
        }
        message.chatId = resolvedChatId || String(chatId || '').trim();
        if (message.senderId === '__self__') {
          message.senderName = accountId;
        }
      });

      if (participant?.name === 'Unknown') {
        const firstOther = messages.find((message) => message.senderId !== '__self__' && message.senderName && message.senderName !== 'Unknown');
        if (firstOther?.senderName) {
          participant.name = firstOther.senderName;
        }
      }

      if (process.env.REFRESH_SESSION_COOKIES === '1') {
        await saveCookies(accountId, await context.cookies(), {
          skipIfMissingAuthCookies: true,
          source: 'readThread',
        });
      }

      return {
        ok: true,
        code: 'OK',
        items: messages,
        participant,
        resolvedChatId,
        threadUrl: page.url(),
        diagnostics,
        cursor: null,
        hasMore: false,
      };
    } catch (err) {
      const classified = classifyThreadFailure(err, diagnostics.stage);
      diagnostics.browserFatal = classified.browserFatal;
      diagnostics.code = classified.code;
      diagnostics.error = classified.message;
      diagnostics.stage = diagnostics.stage || 'readThread';
      if (classified.browserFatal) {
        await cleanupContext(accountId).catch(() => {});
      }
      throw buildTypedThreadError(classified.code, classified.message, classified.status, {
        browserFatal: classified.browserFatal,
        diagnostics,
      });
    } finally {
      // Only close the page — the context/browser are pooled per account and are
      // reclaimed by cleanupContext (on fatal errors) or the idle TTL.
      if (page) await page.close().catch(() => {});
    }
  });
}

module.exports = { readThread };
