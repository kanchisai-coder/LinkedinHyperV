'use strict';

const { getAccountContext, cleanupContext, withAccountLock } = require('../browser');
const { loadCookies, saveCookies } = require('../session');
const { delay, humanScroll } = require('../humanBehavior');
const { checkAndIncrement } = require('../rateLimit');

function isAuthLandingUrl(url) {
  const value = String(url || '').toLowerCase();
  return (
    value.includes('/login') ||
    value.includes('/checkpoint') ||
    value.includes('/authwall') ||
    value.includes('/challenge')
  );
}

function isRecoverableBrowserError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return false;

  return (
    msg.includes('session closed') ||
    msg.includes('target page, context or browser has been closed') ||
    msg.includes('frame was detached') ||
    msg.includes('net::err_aborted') ||
    msg.includes('protocol error (page.addscripttoevaluateonnewdocument)') ||
    msg.includes('protocol error (page.createisolatedworld)') ||
    msg.includes('operation failed')
  );
}

async function readMessagesInternal({
  accountId,
  proxyUrl,
  limit,
  __attempt = 1,
  forceCookieReload = false,
}) {
  const { context, cookiesLoaded } = await getAccountContext(accountId, proxyUrl);
  let page;

  try {
    if (!cookiesLoaded || forceCookieReload) {
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

    try {
      await page.goto('https://www.linkedin.com/messaging/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (navErr) {
      const msg = navErr instanceof Error ? navErr.message : String(navErr);
      if (msg.includes('ERR_TOO_MANY_REDIRECTS')) {
        const err = new Error(`Session expired for account ${accountId}. Re-import cookies.`);
        err.code = 'SESSION_EXPIRED';
        err.status = 401;
        throw err;
      }
      throw navErr;
    }

    const landingUrl = page.url();
    if (isAuthLandingUrl(landingUrl)) {
      if (__attempt < 2 && cookiesLoaded && !forceCookieReload) {
        await cleanupContext(accountId).catch(() => {});
        await delay(250, 500);
        return readMessagesInternal({
          accountId,
          proxyUrl,
          limit,
          __attempt: __attempt + 1,
          forceCookieReload: true,
        });
      }

      const err = new Error(`Session expired for account ${accountId}. Re-import cookies.`);
      err.code = 'SESSION_EXPIRED';
      err.status = 401;
      throw err;
    }

    await page
      .waitForSelector('.msg-conversation-listitem, [data-view-name="messaging-thread-list-item"], a[href*="/messaging/thread/"]', {
        timeout: 15000,
      })
      .catch(() => null);

    await delay(300, 600);
    await humanScroll(page, 300);
    await delay(300, 600);

    const chats = await page.evaluate((maxItems) => {
      const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const toAbsoluteLinkedInUrl = (href) => {
        if (!href) return null;
        try {
          return new URL(href, 'https://www.linkedin.com').toString();
        } catch {
          return null;
        }
      };
      const stableHash = (value) => {
        let hash = 0;
        const input = String(value || '');
        for (let i = 0; i < input.length; i += 1) {
          hash = (hash << 5) - hash + input.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash).toString(36);
      };
      const extractNameFromAriaLabel = (aria) => {
        const value = normalizeText(aria);
        if (!value) return '';
        const patterns = [/^conversation with (.+)$/i, /^message with (.+)$/i, /^chat with (.+)$/i];
        for (const pattern of patterns) {
          const match = value.match(pattern);
          if (match && match[1]) return normalizeText(match[1]);
        }
        return '';
      };
      const extractThreadId = (thread, href, participantName, profileUrl, idx) => {
        const candidates = [
          href || '',
          thread.getAttribute('data-conversation-id') || '',
          thread.getAttribute('data-urn') || '',
          thread.getAttribute('data-id') || '',
          thread.getAttribute('id') || '',
        ];

        for (const candidate of candidates) {
          if (!candidate) continue;

          const directMatch = candidate.match(/\/messaging\/thread\/([^/?#]+)/i);
          if (directMatch?.[1]) return directMatch[1];

          const urnMatch = candidate.match(/fs_conversation:([^,\s)]+)/i);
          if (urnMatch?.[1]) return urnMatch[1];

          const queryMatch = candidate.match(/[?&](?:conversationId|conversationUrn|threadId)=([^&#]+)/i);
          if (queryMatch?.[1]) {
            try {
              return decodeURIComponent(queryMatch[1]);
            } catch {
              return queryMatch[1];
            }
          }
        }

        const fallbackKey = `${participantName}|${profileUrl || ''}|${href || ''}|${idx}`;
        return `fallback-${stableHash(fallbackKey)}`;
      };

      const extractPreviewText = (thread, participantName) => {
        const previewSelectors = [
          '.msg-conversation-listitem__message-snippet',
          '.msg-conversation-card__message-snippet',
          '.msg-conversation-card__body p',
          '.t-14.t-black--light',
          '.t-12.t-black--light',
          '[data-test-conversation-snippet]',
        ];

        for (const selector of previewSelectors) {
          const value = normalizeText(thread.querySelector(selector)?.textContent);
          if (value) return value;
        }

        const raw = normalizeText(thread.innerText || thread.textContent || '');
        if (!raw) return '';
        if (!participantName) return raw.slice(0, 180);

        const withoutName = normalizeText(raw.replace(participantName, ''));
        return withoutName.slice(0, 180);
      };

      const items = [];
      const threads = document.querySelectorAll(
        '.msg-conversation-listitem, [data-view-name="messaging-thread-list-item"], li:has(a[href*="/messaging/thread/"])'
      );

      for (const [idx, thread] of Array.from(threads).slice(0, maxItems).entries()) {
        try {
          const nameEl = thread.querySelector(
            '.msg-conversation-listitem__participant-names, .msg-conversation-listitem__participant-names span, .truncate, [data-anonymize="person-name"], .msg-conversation-listitem__name'
          );
          const timeEl = thread.querySelector('time, .msg-conversation-listitem__time-stamp');
          const unreadEl = thread.querySelector('.msg-conversation-listitem__unread-count, [data-test-icon="unread-badge-icon"]');
          const anchors = Array.from(thread.querySelectorAll('a[href]'));
          const threadAnchor = anchors.find((anchor) => {
            const href = anchor.getAttribute('href') || '';
            return /\/messaging\/thread\//i.test(href) || /(?:conversationUrn|conversationId|threadId)=/i.test(href);
          }) || thread.closest('a[href]') || anchors[0] || null;
          const profileLinkEl = anchors.find((anchor) => String(anchor.getAttribute('href') || '').includes('/in/')) || null;
          const avatarEl = thread.querySelector('img');
          const ariaLabel = thread.getAttribute('aria-label') || threadAnchor?.getAttribute('aria-label') || '';

          const href = threadAnchor?.href || '';
          const profileUrl = toAbsoluteLinkedInUrl(profileLinkEl?.getAttribute('href') || '');
          const nameFromAria = extractNameFromAriaLabel(ariaLabel);
          const rawName =
            normalizeText(nameEl?.textContent) ||
            normalizeText(profileLinkEl?.textContent) ||
            nameFromAria;
          const participantName = rawName || null;
          const participantNameDisplay = participantName || 'Unknown';
          const previewText = extractPreviewText(thread, participantNameDisplay);
          const chatId = extractThreadId(thread, href, participantNameDisplay, profileUrl, idx);

          items.push({
            id: chatId,
            accountId: '',
            participants: [
              {
                id: chatId,
                name: participantName,
                displayName: participantNameDisplay,
                avatarUrl: avatarEl?.src || null,
                profileUrl,
                nameResolved: participantName !== null,
              },
            ],
            unreadCount: unreadEl ? 1 : 0,
            lastMessage: previewText
              ? {
                id: `preview-${chatId}`,
                chatId,
                senderId: '',
                text: previewText,
                createdAt: timeEl?.getAttribute('datetime') || new Date().toISOString(),
                isRead: !unreadEl,
              }
              : null,
            createdAt: timeEl?.getAttribute('datetime') || new Date().toISOString(),
            threadUrl: toAbsoluteLinkedInUrl(href),
          });
        } catch (_) {
          // Skip malformed item.
        }
      }
      return items;
    }, limit);

    chats.forEach((chat) => {
      chat.accountId = accountId;
    });

    if (process.env.REFRESH_SESSION_COOKIES === '1') {
      await saveCookies(accountId, await context.cookies(), {
        skipIfMissingAuthCookies: true,
        source: 'readMessages',
      });
    }

    return { items: chats, cursor: null, hasMore: false };
  } catch (err) {
    if (__attempt < 2 && isRecoverableBrowserError(err)) {
      await cleanupContext(accountId).catch(() => {});
      await delay(250, 500);
      return readMessagesInternal({
        accountId,
        proxyUrl,
        limit,
        __attempt: __attempt + 1,
        forceCookieReload: true,
      });
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function readMessages({ accountId, proxyUrl, limit = 20 }) {
  return withAccountLock(accountId, async () => {
    await checkAndIncrement(accountId, 'inboxReads');
    return readMessagesInternal({ accountId, proxyUrl, limit, __attempt: 1, forceCookieReload: false });
  });
}

module.exports = { readMessages };
