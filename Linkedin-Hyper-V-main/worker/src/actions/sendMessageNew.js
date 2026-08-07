'use strict';

const { getAccountContext, cleanupContext, withAccountLock } = require('../browser');
const { loadCookies, saveCookies }                  = require('../session');
const { delay, humanClick, humanScroll, humanType } = require('../humanBehavior');
const { checkAndIncrement, checkOnly }              = require('../rateLimit');
const fs                                            = require('fs');
const path                                          = require('path');
const { getRedis }                                  = require('../redisClient');

const COMPOSER_SELECTORS = [
  '.msg-form__contenteditable',
  '[contenteditable][role="textbox"]',
  'div[role="textbox"][contenteditable="true"]',
  '[data-view-name="messaging-compose-box"] [contenteditable="true"]',
  '.msg-form textarea',
  '.msg-form__msg-content-container textarea',
  '[data-view-name="messaging-compose-box"] textarea',
].join(', ');

const DEBUG_SCREENSHOT_DIR =
  process.env.LI_DEBUG_SCREENSHOT_DIR || '/tmp/linkedin-hyper-debug';

const PROFILE_DIRECT_MESSAGE_SELECTORS = [
  'main button[aria-label*="Message"]',
  'main a[aria-label*="Message"]',
  'main button[data-control-name*="message"]',
  'main a[data-control-name*="message"]',
  'main button[data-test-id*="message"]',
  'main a[data-test-id*="message"]',
];

const PROFILE_TOP_ACTION_SELECTORS = [
  '.pv-top-card-v2-ctas button[aria-label*="Message"]',
  '.pv-top-card-v2-ctas a[aria-label*="Message"]',
  '.pvs-profile-actions button[aria-label*="Message"]',
  '.pvs-profile-actions a[aria-label*="Message"]',
  'main .artdeco-button[aria-label*="Message"]',
];

const PROFILE_MORE_ACTION_SELECTORS = [
  'button[aria-label*="More actions"]',
  'button[aria-label*="More"]',
  'button[data-control-name*="overflow"]',
  'button[data-control-name*="more"]',
  'div[role="button"][aria-label*="More"]',
];

const PROFILE_DEBUG_ENABLED = process.env.LI_PROFILE_DEBUG !== '0';

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

function slugToName(slug) {
  return normalizeText(
    String(slug || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\d+\b/g, '')
  );
}

function deriveNameFromProfileUrl(profileUrl) {
  const match = String(profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match?.[1]) return 'Unknown';
  const name = slugToName(match[1]);
  return name || 'Unknown';
}

function normalizeParticipantName(candidate, profileUrl) {
  const parsed = normalizeText(candidate);
  if (parsed && !isGenericUiLabel(parsed)) {
    return parsed;
  }
  return deriveNameFromProfileUrl(profileUrl);
}

function logSendStep(accountId, message) {
  console.log(`[sendMessageNew:${accountId}] ${message}`);
}

function truncateForLog(value, max = 120) {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function summarizeSelectorCounts(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 'none';
  return entries
    .map((entry) => `${entry.selector}=${entry.visibleCount}/${entry.count}`)
    .join(' | ');
}

async function collectProfileActionDebugSnapshot(page, { messageSelectors, moreSelectors }) {
  try {
    return await page.evaluate(({ messageSelectors, moreSelectors }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const hidden =
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          el.getAttribute('aria-hidden') === 'true';
        return !hidden && rect.width > 0 && rect.height > 0;
      };

      const countBySelector = (selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        const visibleCount = nodes.filter(isVisible).length;
        return { selector, count: nodes.length, visibleCount };
      };

      const messageSelectorCounts = messageSelectors.map(countBySelector);
      const moreSelectorCounts = moreSelectors.map(countBySelector);
      const hasVisibleMessageButton = messageSelectorCounts.some((x) => x.visibleCount > 0);
      const hasVisibleMoreButton = moreSelectorCounts.some((x) => x.visibleCount > 0);

      const actionNodes = Array.from(
        document.querySelectorAll('main button, main a, main [role="button"], main div[role="button"]')
      );
      const visibleActionTexts = Array.from(
        new Set(
          actionNodes
            .filter(isVisible)
            .map((el) => normalize(el.getAttribute('aria-label') || el.textContent || ''))
            .filter(Boolean)
        )
      ).slice(0, 25);

      return {
        url: location.href,
        title: document.title || '',
        messageSelectorCounts,
        moreSelectorCounts,
        hasVisibleMessageButton,
        hasVisibleMoreButton,
        visibleActionTexts,
      };
    }, { messageSelectors, moreSelectors });
  } catch (err) {
    return {
      url: page.url(),
      title: '',
      messageSelectorCounts: [],
      moreSelectorCounts: [],
      hasVisibleMessageButton: false,
      hasVisibleMoreButton: false,
      visibleActionTexts: [],
      error: String(err?.message || err),
    };
  }
}

function logProfileActionDebug(accountId, snapshot) {
  if (!PROFILE_DEBUG_ENABLED || !snapshot) return;

  logSendStep(accountId, `[debug] profile URL after navigation: ${snapshot.url || '(unknown)'}`);
  logSendStep(accountId, `[debug] profile title: ${truncateForLog(snapshot.title || '(empty)')}`);
  logSendStep(
    accountId,
    `[debug] message selector counts: ${summarizeSelectorCounts(snapshot.messageSelectorCounts)}`
  );
  logSendStep(
    accountId,
    `[debug] visible Message button exists: ${snapshot.hasVisibleMessageButton ? 'yes' : 'no'}`
  );
  logSendStep(
    accountId,
    `[debug] visible More button exists: ${snapshot.hasVisibleMoreButton ? 'yes' : 'no'}`
  );
  logSendStep(
    accountId,
    `[debug] more selector counts: ${summarizeSelectorCounts(snapshot.moreSelectorCounts)}`
  );
  logSendStep(
    accountId,
    `[debug] visible action texts: ${(
      snapshot.visibleActionTexts || []
    ).map((txt) => `"${truncateForLog(txt, 80)}"`).join(', ') || '(none)'}`
  );
}

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
    console.warn(`[sendMessageNew:${accountId}] screenshot saved: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(
      `[sendMessageNew:${accountId}] screenshot capture failed: ${String(err?.message || err)}`
    );
    return null;
  }
}

async function waitForComposerOpen(page, timeoutMs = 7000) {
  const composer = await page.waitForSelector(COMPOSER_SELECTORS, { timeout: timeoutMs }).catch(() => null);
  return Boolean(composer);
}

async function clickVisibleSelector(page, selector, timeoutMs = 2000) {
  try {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout: timeoutMs }).catch(() => false);
    if (!visible) return false;
    await humanClick(page, selector, { timeout: Math.max(timeoutMs, 2500) });
    return true;
  } catch (_) {
    return false;
  }
}

async function clickMessageByText(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      return !hidden && rect.width > 0 && rect.height > 0;
    };

    const scopes = [
      document.querySelector('.pv-top-card-v2-ctas'),
      document.querySelector('.pvs-profile-actions'),
      document.querySelector('main'),
      document,
    ].filter(Boolean);

    for (const scope of scopes) {
      const nodes = Array.from(scope.querySelectorAll('button, a, div[role="button"]'));
      const candidate = nodes.find((el) => {
        if (!isVisible(el)) return false;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true') return false;
        return aria.includes('message') || txt === 'message' || txt.startsWith('message ');
      });
      if (candidate) {
        candidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { clicked: true, matchedText: (candidate.textContent || '').trim() || candidate.getAttribute('aria-label') || '' };
      }
    }

    return { clicked: false, matchedText: '' };
  }).catch(() => ({ clicked: false, matchedText: '' }));
}

async function clickMessageInOverflowMenu(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      return !hidden && rect.width > 0 && rect.height > 0;
    };

    const candidates = Array.from(
      document.querySelectorAll(
        [
          'div[role="menu"] [role="menuitem"]',
          '.artdeco-dropdown__content-inner [role="menuitem"]',
          '.artdeco-dropdown__content-inner button',
          '.artdeco-dropdown__content-inner a',
          '.artdeco-dropdown__item',
          '[data-control-name*="message"]',
        ].join(', ')
      )
    );

    const target = candidates.find((el) => {
      if (!isVisible(el)) return false;
      const text = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.toLowerCase();
      return text.includes('message');
    });

    if (!target) return { clicked: false, disabled: false, label: '' };

    const disabled = target.getAttribute('disabled') !== null || target.getAttribute('aria-disabled') === 'true';
    const label = `${target.getAttribute('aria-label') || ''} ${target.textContent || ''}`.replace(/\s+/g, ' ').trim();
    if (disabled) return { clicked: false, disabled: true, label };

    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, disabled: false, label };
  }).catch(() => ({ clicked: false, disabled: false, label: '' }));
}

async function clickMessageTriggerOnProfile(page, { accountId, profileUrl, maxAttempts = 3 }) {
  let lastReason = 'No visible Message action was found on this profile.';
  let disabledMessageDetected = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logSendStep(accountId, `message-button search attempt ${attempt}/${maxAttempts}`);
    await page.waitForSelector('main, body', { timeout: 12000 }).catch(() => null);

    const strategyGroups = [
      { name: 'direct-message-button', selectors: PROFILE_DIRECT_MESSAGE_SELECTORS },
      { name: 'top-action-bar', selectors: PROFILE_TOP_ACTION_SELECTORS },
    ];

    for (const group of strategyGroups) {
      for (const selector of group.selectors) {
        const clicked = await clickVisibleSelector(page, selector, 1500);
        if (!clicked) continue;
        logSendStep(accountId, `message button found via ${group.name}: ${selector}`);
        if (await waitForComposerOpen(page, 7000)) {
          logSendStep(accountId, `composer opened via selector: ${selector}`);
          return { opened: true, strategy: group.name, matched: selector };
        }
        lastReason = `Selector matched (${selector}) but composer did not open.`;
        const shot = await captureFailureScreenshot(page, accountId, `composer-not-open-${attempt}`);
        if (shot) logSendStep(accountId, `composer did not open; screenshot: ${shot}`);
      }
    }

    const textClick = await clickMessageByText(page);
    if (textClick.clicked) {
      logSendStep(accountId, `message button found via text strategy: ${textClick.matchedText || '(text-match)'}`);
      if (await waitForComposerOpen(page, 7000)) {
        logSendStep(accountId, 'composer opened via text strategy');
        return { opened: true, strategy: 'text-based', matched: textClick.matchedText || 'message-text' };
      }
      lastReason = 'Text-based Message control clicked but composer did not open.';
      const shot = await captureFailureScreenshot(page, accountId, `composer-not-open-text-${attempt}`);
      if (shot) logSendStep(accountId, `composer not open after text-click; screenshot: ${shot}`);
    }

    for (const moreSelector of PROFILE_MORE_ACTION_SELECTORS) {
      const openedMore = await clickVisibleSelector(page, moreSelector, 1200);
      if (!openedMore) continue;
      logSendStep(accountId, `overflow opened via selector: ${moreSelector}`);
      await delay(300, 700);
      const overflowResult = await clickMessageInOverflowMenu(page);
      if (overflowResult.disabled) {
        disabledMessageDetected = true;
        lastReason = `Message option is present but disabled in overflow menu (${overflowResult.label || 'Message'}).`;
        break;
      }
      if (overflowResult.clicked) {
        logSendStep(accountId, `message selected from overflow menu: ${overflowResult.label || 'Message'}`);
        if (await waitForComposerOpen(page, 7000)) {
          logSendStep(accountId, 'composer opened via overflow menu');
          return { opened: true, strategy: 'overflow-menu', matched: overflowResult.label || moreSelector };
        }
        lastReason = 'Message menu item clicked in overflow menu but composer did not open.';
        const shot = await captureFailureScreenshot(page, accountId, `composer-not-open-overflow-${attempt}`);
        if (shot) logSendStep(accountId, `composer not open after overflow click; screenshot: ${shot}`);
      }
    }

    if (attempt < maxAttempts) {
      await humanScroll(page, 180).catch(() => {});
      await delay(500, 900);
    }
  }

  const screenshotPath = await captureFailureScreenshot(page, accountId, 'message-button-not-found');
  const reason = disabledMessageDetected
    ? 'Profile has a Message action but it is disabled for this account (likely not connected or restricted).'
    : `No usable Message action was found on profile page ${profileUrl}.`;
  if (screenshotPath) {
    logSendStep(accountId, `message button not found; screenshot: ${screenshotPath}`);
  }

  return {
    opened: false,
    reason: `${reason} ${lastReason}`.trim(),
    screenshotPath,
  };
}

function normalizeThreadIdCandidate(value) {
  return String(value || '').trim();
}

function isValidThreadId(value) {
  const id = normalizeThreadIdCandidate(value);
  if (!id) return false;
  if (id.toLowerCase() === 'new') return false;
  return true;
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

function extractThreadIdFromText(value) {
  const raw = String(value || '');
  if (!raw) return '';

  const fromThreadUrl = raw.match(/\/messaging\/thread\/([^/?#"\s]+)/i);
  if (isValidThreadId(fromThreadUrl?.[1])) return normalizeThreadIdCandidate(fromThreadUrl[1]);

  const fromUrn = raw.match(/fs(?:d)?_conversation:([^,"\s)]+)/i);
  if (isValidThreadId(fromUrn?.[1])) return normalizeThreadIdCandidate(fromUrn[1]);

  const fromQuery = raw.match(/[?&](?:conversationId|threadId)=([^&#"\s]+)/i);
  if (fromQuery?.[1]) {
    try {
      const decoded = decodeURIComponent(fromQuery[1]);
      if (isValidThreadId(decoded)) return normalizeThreadIdCandidate(decoded);
    } catch {
      if (isValidThreadId(fromQuery[1])) return normalizeThreadIdCandidate(fromQuery[1]);
    }
  }

  const fromConversationUrn = raw.match(/conversationUrn=([^&#"\s]+)/i);
  if (fromConversationUrn?.[1]) {
    try {
      const decoded = decodeURIComponent(fromConversationUrn[1]);
      const decodedUrn = decoded.match(/fs(?:d)?_conversation:([^,"\s)]+)/i);
      if (isValidThreadId(decodedUrn?.[1])) return normalizeThreadIdCandidate(decodedUrn[1]);
    } catch {}
  }

  return '';
}

function createNetworkThreadIdProbe(page) {
  let resolvedThreadId = '';
  const pendingParsers = new Set();

  const maybeResolve = (candidate) => {
    if (!resolvedThreadId && isValidThreadId(candidate)) {
      resolvedThreadId = normalizeThreadIdCandidate(candidate);
    }
  };

  const inspectResponse = (response) => {
    if (resolvedThreadId) return;

    try {
      const url = response.url() || '';
      if (!/linkedin\.com/i.test(url) || !/messaging|voyager/i.test(url)) {
        return;
      }

      const idFromUrl = extractThreadIdFromText(url);
      if (idFromUrl) {
        maybeResolve(idFromUrl);
        return;
      }

      const parser = (async () => {
        try {
          const body = await response.text();
          const idFromBody = extractThreadIdFromText(body);
          if (idFromBody) maybeResolve(idFromBody);
        } catch (_) {}
      })();

      pendingParsers.add(parser);
      parser.finally(() => pendingParsers.delete(parser));
    } catch (_) {}
  };

  const inspectRequest = (request) => {
    if (resolvedThreadId) return;
    try {
      const url = request.url() || '';
      if (!/linkedin\.com/i.test(url) || !/messaging|voyager/i.test(url)) {
        return;
      }

      const idFromUrl = extractThreadIdFromText(url);
      if (idFromUrl) {
        maybeResolve(idFromUrl);
        return;
      }

      const postData = request.postData?.() || '';
      const idFromBody = extractThreadIdFromText(postData);
      if (idFromBody) {
        maybeResolve(idFromBody);
      }
    } catch (_) {}
  };

  page.on('request', inspectRequest);
  page.on('response', inspectResponse);

  return {
    async waitForThreadId(waitMs = 12000) {
      const deadline = Date.now() + waitMs;
      while (!resolvedThreadId && Date.now() < deadline) {
        if (pendingParsers.size > 0) {
          await Promise.race([
            Promise.allSettled(Array.from(pendingParsers)),
            delay(180, 260),
          ]);
        } else {
          await delay(180, 260);
        }
      }

      if (!resolvedThreadId && pendingParsers.size > 0) {
        await Promise.allSettled(Array.from(pendingParsers));
      }

      return resolvedThreadId;
    },
    stop() {
      page.off('request', inspectRequest);
      page.off('response', inspectResponse);
    },
  };
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

async function resolveThreadIdAfterSend(page, waitMs = 9000) {
  const fromUrl = () => {
    const currentUrl = page.url();
    const match = currentUrl.match(/\/messaging\/thread\/([^/?#]+)/i);
    const candidate = match?.[1] || '';
    return isValidThreadId(candidate) ? candidate : '';
  };

  let chatId = fromUrl();
  if (chatId) return chatId;

  try {
    await page.waitForFunction(
      () => /\/messaging\/thread\/(?!new(?:\/|\?|$))[^/?#]+/i.test(window.location.pathname + window.location.search),
      { timeout: waitMs }
    );
    chatId = fromUrl();
    if (chatId) return chatId;
  } catch (_) {}

  try {
    chatId = await page.evaluate(() => {
      const normalizeThreadId = (value) => String(value || '').trim();
      const isValidThreadId = (value) => {
        const id = normalizeThreadId(value);
        if (!id) return false;
        if (id.toLowerCase() === 'new') return false;
        return true;
      };
      const idFromHref = (href) => {
        const raw = String(href || '');
        const fromThread = raw.match(/\/messaging\/thread\/([^/?#]+)/i)?.[1] || '';
        if (isValidThreadId(fromThread)) return normalizeThreadId(fromThread);

        const fromQuery = raw.match(/[?&](?:conversationId|threadId)=([^&#"\s]+)/i)?.[1] || '';
        if (fromQuery) {
          try {
            const decoded = decodeURIComponent(fromQuery);
            if (isValidThreadId(decoded)) return normalizeThreadId(decoded);
          } catch {}
          if (isValidThreadId(fromQuery)) return normalizeThreadId(fromQuery);
        }

        const fromConversationUrn = raw.match(/[?&]conversationUrn=([^&#"\s]+)/i)?.[1] || '';
        if (fromConversationUrn) {
          try {
            const decoded = decodeURIComponent(fromConversationUrn);
            const urnMatch = decoded.match(/fs(?:d)?_conversation:([^,"\s)]+)/i);
            const urnId = urnMatch?.[1] || '';
            if (isValidThreadId(urnId)) return normalizeThreadId(urnId);
          } catch {}
        }

        const urnMatch = raw.match(/fs(?:d)?_conversation:([^,"\s)]+)/i);
        const urnId = urnMatch?.[1] || '';
        if (isValidThreadId(urnId)) return normalizeThreadId(urnId);

        return '';
      };

      const candidates = Array.from(
        document.querySelectorAll(
          'a[href*="/messaging/"], [data-conversation-id], [data-urn*="conversation"]'
        )
      );
      for (const node of candidates) {
        const href = node.getAttribute?.('href') || '';
        const idFromLink = idFromHref(href);
        if (idFromLink) return idFromLink;

        const conversationId = node.getAttribute?.('data-conversation-id') || '';
        if (isValidThreadId(conversationId)) return normalizeThreadId(conversationId);

        const urn = node.getAttribute?.('data-urn') || '';
        const urnMatch = urn.match(/fs_conversation:([^,\s)]+)/i);
        if (isValidThreadId(urnMatch?.[1])) return normalizeThreadId(urnMatch[1]);
      }

      const params = new URLSearchParams(window.location.search || '');
      const explicitThreadId = params.get('threadId') || params.get('conversationId');
      if (isValidThreadId(explicitThreadId)) return normalizeThreadId(explicitThreadId);

      const conversationUrn = params.get('conversationUrn') || '';
      const urnIdMatch = conversationUrn.match(/fs_conversation:([^,\s)]+)/i);
      if (isValidThreadId(urnIdMatch?.[1])) return normalizeThreadId(urnIdMatch[1]);

      const resources = performance.getEntriesByType('resource') || [];
      for (let i = resources.length - 1; i >= 0; i -= 1) {
        const resourceUrl = String(resources[i]?.name || '');
        const fromMessagingApi = resourceUrl.match(/messaging\/conversations\/([^/?#]+)/i);
        if (isValidThreadId(fromMessagingApi?.[1])) return normalizeThreadId(fromMessagingApi[1]);
      }
      return '';
    });
  } catch (_) {
    chatId = '';
  }

  return isValidThreadId(chatId) ? chatId : '';
}

async function resolveThreadIdFromConversationPreview(page, messageText, waitMs = 12000) {
  const target = normalizeText(messageText);
  if (!target) return '';
  const excerpt = target.slice(0, 48).toLowerCase();
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    try {
      const chatId = await page.evaluate((needle) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const extractThreadId = (rawValue) => {
          const raw = String(rawValue || '');
          if (!raw) return '';

          const fromThread = raw.match(/\/messaging\/thread\/([^/?#]+)/i)?.[1] || '';
          if (fromThread && fromThread.toLowerCase() !== 'new') return fromThread.trim();

          const fromQuery = raw.match(/[?&](?:conversationId|threadId)=([^&#"\s]+)/i)?.[1] || '';
          if (fromQuery && fromQuery.toLowerCase() !== 'new') {
            try {
              const decoded = decodeURIComponent(fromQuery);
              if (decoded && decoded.toLowerCase() !== 'new') return decoded.trim();
            } catch {}
            return fromQuery.trim();
          }

          const fromConversationUrn = raw.match(/[?&]conversationUrn=([^&#"\s]+)/i)?.[1] || '';
          if (fromConversationUrn) {
            try {
              const decoded = decodeURIComponent(fromConversationUrn);
              const urn = decoded.match(/fs(?:d)?_conversation:([^,"\s)]+)/i)?.[1] || '';
              if (urn && urn.toLowerCase() !== 'new') return urn.trim();
            } catch {}
          }

          const urn = raw.match(/fs(?:d)?_conversation:([^,"\s)]+)/i)?.[1] || '';
          if (urn && urn.toLowerCase() !== 'new') return urn.trim();

          return '';
        };

        const isValidThreadId = (value) => {
          const id = String(value || '').trim();
          if (!id) return false;
          if (id.toLowerCase() === 'new') return false;
          return true;
        };

        const anchors = Array.from(
          document.querySelectorAll('a[href*="/messaging/"], [data-conversation-id], [data-urn*="conversation"]')
        );
        for (const anchor of anchors) {
          const href = anchor.getAttribute?.('href') || '';
          const dataConversationId = anchor.getAttribute?.('data-conversation-id') || '';
          const dataUrn = anchor.getAttribute?.('data-urn') || '';
          const candidateId =
            extractThreadId(href) ||
            extractThreadId(dataConversationId) ||
            extractThreadId(dataUrn);
          if (!isValidThreadId(candidateId)) continue;

          const row =
            anchor.closest('.msg-conversation-listitem, .msg-conversation-card, li, [data-view-name*="conversation"]') ||
            anchor;
          const rowText = normalize(row?.textContent).toLowerCase();
          if (rowText.includes(needle)) {
            return String(candidateId).trim();
          }
        }
        return '';
      }, excerpt);

      if (isValidThreadId(chatId)) {
        return chatId;
      }
    } catch (_) {}

    await delay(600, 900);
  }

  return '';
}

function buildConversationNeedles(profileUrl, participantName, messageText) {
  const targetSlug = String(profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] || '';
  const slugNeedle = slugToName(targetSlug).toLowerCase();
  const nameNeedle = normalizeText(participantName).toLowerCase();
  const textNeedle = normalizeText(messageText).slice(0, 48).toLowerCase();
  const tokenNeedles = Array.from(new Set(
    `${slugNeedle} ${nameNeedle}`
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  ));

  return {
    slugNeedle,
    nameNeedle,
    textNeedle,
    tokenNeedles,
  };
}

function scoreConversationRowText(rowText, { slugNeedle, nameNeedle, textNeedle, tokenNeedles }) {
  const hay = normalizeText(rowText).toLowerCase();
  if (!hay) return 0;

  let score = 0;
  if (textNeedle && hay.includes(textNeedle)) score += 5;
  if (nameNeedle && hay.includes(nameNeedle)) score += 3;
  if (slugNeedle && hay.includes(slugNeedle)) score += 2;
  if (Array.isArray(tokenNeedles)) {
    let tokenHits = 0;
    for (const token of tokenNeedles) {
      if (token && hay.includes(String(token).toLowerCase())) {
        tokenHits += 1;
      }
    }
    score += Math.min(4, tokenHits);
  }
  return score;
}

async function resolveThreadIdFromMessagingHome(page, { profileUrl, participantName, messageText }, waitMs = 15000) {
  const { slugNeedle, nameNeedle, textNeedle, tokenNeedles } =
    buildConversationNeedles(profileUrl, participantName, messageText);

  try {
    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch (_) {
    return '';
  }

  await page.waitForSelector('a[href*="/messaging/thread/"], .msg-conversation-listitem', {
    timeout: 12000,
  }).catch(() => null);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const chatId = await page.evaluate((slugNeedleInput, nameNeedleInput, textNeedleInput, tokenNeedlesInput) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const extractThreadId = (rawValue) => {
          const raw = String(rawValue || '');
          if (!raw) return '';

          const fromThread = raw.match(/\/messaging\/thread\/([^/?#]+)/i)?.[1] || '';
          if (fromThread && fromThread.toLowerCase() !== 'new') return fromThread.trim();

          const fromQuery = raw.match(/[?&](?:conversationId|threadId)=([^&#"\s]+)/i)?.[1] || '';
          if (fromQuery && fromQuery.toLowerCase() !== 'new') {
            try {
              const decoded = decodeURIComponent(fromQuery);
              if (decoded && decoded.toLowerCase() !== 'new') return decoded.trim();
            } catch {}
            return fromQuery.trim();
          }

          const fromConversationUrn = raw.match(/[?&]conversationUrn=([^&#"\s]+)/i)?.[1] || '';
          if (fromConversationUrn) {
            try {
              const decoded = decodeURIComponent(fromConversationUrn);
              const urn = decoded.match(/fs(?:d)?_conversation:([^,"\s)]+)/i)?.[1] || '';
              if (urn && urn.toLowerCase() !== 'new') return urn.trim();
            } catch {}
          }

          const urn = raw.match(/fs(?:d)?_conversation:([^,"\s)]+)/i)?.[1] || '';
          if (urn && urn.toLowerCase() !== 'new') return urn.trim();

          return '';
        };

        const isValidThreadId = (value) => {
          const id = String(value || '').trim();
          if (!id) return false;
          if (id.toLowerCase() === 'new') return false;
          return true;
        };

        const candidates = Array.from(
          document.querySelectorAll('a[href*="/messaging/"], [data-conversation-id], [data-urn*="conversation"]')
        );
        let bestMatch = { id: '', score: -1 };

        for (const anchor of candidates) {
          const href = anchor.getAttribute?.('href') || '';
          const dataConversationId = anchor.getAttribute?.('data-conversation-id') || '';
          const dataUrn = anchor.getAttribute?.('data-urn') || '';
          const candidateId =
            extractThreadId(href) ||
            extractThreadId(dataConversationId) ||
            extractThreadId(dataUrn);
          if (!isValidThreadId(candidateId)) continue;

          const row =
            anchor.closest('.msg-conversation-listitem, .msg-conversation-card, li, [data-view-name*="conversation"]') ||
            anchor;
          const rowText = normalize(row?.textContent).toLowerCase();
          if (!rowText) continue;

          let score = 0;
          if (textNeedleInput && rowText.includes(textNeedleInput)) score += 5;
          if (nameNeedleInput && rowText.includes(nameNeedleInput)) score += 3;
          if (slugNeedleInput && rowText.includes(slugNeedleInput)) score += 2;
          if (Array.isArray(tokenNeedlesInput)) {
            let tokenHits = 0;
            for (const token of tokenNeedlesInput) {
              if (token && rowText.includes(String(token).toLowerCase())) {
                tokenHits += 1;
              }
            }
            score += Math.min(4, tokenHits);
          }

          if (score > bestMatch.score) {
            bestMatch = { id: String(candidateId).trim(), score };
          }
        }

        return bestMatch.score >= 2 ? bestMatch.id : '';
      }, slugNeedle, nameNeedle, textNeedle, tokenNeedles);

      if (isValidThreadId(chatId)) {
        return chatId;
      }
    } catch (_) {}

    await delay(600, 900);
  }

  return '';
}

async function resolveThreadIdByClickingConversationCandidates(
  page,
  { accountId, profileUrl, participantName, messageText },
  waitMs = 22000
) {
  const needles = buildConversationNeedles(profileUrl, participantName, messageText);
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    try {
      await page.goto('https://www.linkedin.com/messaging/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (_) {
      return '';
    }

    await page.waitForSelector('a[href*="/messaging/thread/"], .msg-conversation-listitem', {
      timeout: 12000,
    }).catch(() => null);

    const rowLocator = page.locator(
      '.msg-conversation-listitem, .msg-conversation-card, li[data-view-name*="conversation"]'
    );
    const rowCount = Math.min(await rowLocator.count().catch(() => 0), 15);
    if (rowCount === 0) {
      await delay(700, 1000);
      continue;
    }

    const ranked = [];
    for (let i = 0; i < rowCount; i += 1) {
      const row = rowLocator.nth(i);
      const rowText = await row.innerText().catch(() => '');
      const score = scoreConversationRowText(rowText, needles);
      if (score > 0) {
        ranked.push({ index: i, score, text: truncateForLog(rowText, 90) });
      }
    }

    ranked.sort((a, b) => b.score - a.score);
    const candidates = ranked.slice(0, Math.min(5, ranked.length));
    if (candidates.length === 0) {
      await delay(700, 1000);
      continue;
    }

    for (const candidate of candidates) {
      const row = rowLocator.nth(candidate.index);
      try {
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await row.click({ timeout: 5000 });
      } catch (_) {
        continue;
      }

      await delay(500, 900);
      const chatId = await resolveThreadIdAfterSend(page, 5000);
      if (isValidThreadId(chatId)) {
        logSendStep(
          accountId,
          `thread id resolved by opening conversation row (score=${candidate.score}): ${candidate.text}`
        );
        return chatId;
      }
    }

    await delay(700, 1000);
  }

  return '';
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

  const waitForPersistedText = async (waitMs) => {
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
        { timeout: waitMs }
      );
      return true;
    } catch {
      return false;
    }
  };

  await page.waitForSelector('.msg-s-message-list, [data-view-name="messaging-message-list"]', {
    timeout: 8000,
  }).catch(() => null);

  if (await waitForPersistedText(timeoutMs)) {
    return true;
  }

  // One reload pass for slower LinkedIn thread hydration.
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (_) {}

  await page.waitForSelector('.msg-s-message-list, [data-view-name="messaging-message-list"]', {
    timeout: 8000,
  }).catch(() => null);

  return waitForPersistedText(Math.max(8000, Math.floor(timeoutMs / 2)));
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
    return await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const selectors = [
        '.msg-form__contenteditable',
        '[contenteditable][role="textbox"]',
        'div[role="textbox"][contenteditable="true"]',
        '[data-view-name="messaging-compose-box"] [contenteditable="true"]',
        '.msg-form textarea',
        '.msg-form__msg-content-container textarea',
        '[data-view-name="messaging-compose-box"] textarea',
      ];

      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!node) continue;
        const value =
          node.tagName === 'TEXTAREA'
            ? normalize(node.value)
            : normalize(node.textContent);
        if (value) return false;
      }
      return true;
    });
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

      return patterns.some((p) => hay.includes(p));
    });
  } catch {
    return false;
  }
}

async function sendMessageNewInternal({ accountId, profileUrl, text, proxyUrl, __attempt = 1 }) {
  // W2 — checkAndIncrement moved to AFTER successful send.
  await cleanupContext(accountId).catch(() => {});
  const { context, cookiesLoaded } = await getAccountContext(accountId, proxyUrl);
  let page;
  let networkThreadProbe = null;
  let preResolvedChatId = '';

  try {
    // W1 — Only inject cookies on a cache miss.
    if (!cookiesLoaded) {
      const cookies = await loadCookies(accountId);
      if (!cookies) {
        const err = new Error(`No session for account ${accountId}`);
        err.code = 'NO_SESSION'; err.status = 401;
        throw err;
      }
      await context.addCookies(cookies);
    }
    page = await context.newPage();

    // W3 — Try the direct messaging URL first to avoid loading the heavy profile page.
    let participantName = normalizeParticipantName('', profileUrl);
    const memberIdMatch = profileUrl.match(/\/in\/([^/?#]+)/);
    const directUrl = memberIdMatch
      ? `https://www.linkedin.com/messaging/thread/new/?recipient=${memberIdMatch[1]}`
      : null;

    let usedDirectUrl = false;
    if (directUrl) {
      try {
        await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const directUrlLanding = page.url();
        if (!directUrlLanding.includes('/login') && !directUrlLanding.includes('/checkpoint') && !directUrlLanding.includes('/authwall')) {
          const composeBox = await page
            .waitForSelector(COMPOSER_SELECTORS, { timeout: 20000 })
            .catch(() => null);
          usedDirectUrl = !!composeBox;

          if (usedDirectUrl) {
            try {
              const nameFromComposer = await page.evaluate(() => {
                const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                const nameEl = document.querySelector(
                  '.msg-thread__name, .msg-entity-lockup__entity-title, [data-anonymize="person-name"], h1, h2'
                );
                return normalize(nameEl?.textContent);
              });
              participantName = normalizeParticipantName(nameFromComposer, profileUrl);
            } catch (_) {}
          }
        }
      } catch (_) {
        // Fall back to profile-page flow below.
        usedDirectUrl = false;
      }
    }

    if (!usedDirectUrl) {
      // Fallback 1: if conversation already exists, open from messaging home directly.
      try {
        const existingThreadId = await resolveThreadIdFromMessagingHome(
          page,
          { profileUrl, participantName, messageText: '' },
          12000
        );
        if (isValidThreadId(existingThreadId)) {
          await page.goto(`https://www.linkedin.com/messaging/thread/${existingThreadId}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          const threadComposer = await page
            .waitForSelector(COMPOSER_SELECTORS, { timeout: 20000 })
            .catch(() => null);
          if (threadComposer) {
            usedDirectUrl = true;
            preResolvedChatId = existingThreadId;
          }
        }
      } catch (_) {}
    }

    if (!usedDirectUrl) {
      // Fallback: navigate to recipient's profile page and click "Message"
      logSendStep(accountId, `opening profile URL: ${profileUrl}`);
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await page.waitForSelector('main, body', { timeout: 15000 }).catch(() => null);
      logSendStep(accountId, `profile page load successful: ${page.url()}`);
      const profileDebugSnapshot = await collectProfileActionDebugSnapshot(page, {
        messageSelectors: [
          ...PROFILE_DIRECT_MESSAGE_SELECTORS,
          ...PROFILE_TOP_ACTION_SELECTORS,
        ],
        moreSelectors: PROFILE_MORE_ACTION_SELECTORS,
      });
      logProfileActionDebug(accountId, profileDebugSnapshot);
      if (profileDebugSnapshot?.error) {
        logSendStep(accountId, `[debug] profile debug collection error: ${profileDebugSnapshot.error}`);
      }

      const landingUrl = page.url();
      if (landingUrl.includes('/login') || landingUrl.includes('/checkpoint') || landingUrl.includes('/authwall')) {
        const authwallShot = await captureFailureScreenshot(page, accountId, 'profile-authwall');
        const err = new Error(`Session expired for account ${accountId}. Re-import cookies.`);
        if (authwallShot) {
          err.message += ` Screenshot: ${authwallShot}`;
        }
        err.code = 'SESSION_EXPIRED'; err.status = 401;
        throw err;
      }
      await delay(2500, 5000); // simulate reading the profile

      await humanScroll(page, 200);
      await delay(800, 1500);

      // Extract profile name near the Message button
      try {
        const candidateName = await page.evaluate((fallbackName) => {
          const messageButton = document.querySelector('button[aria-label*="Message"], a[aria-label*="Message"]');
          const nearestCard   = messageButton?.closest('.pv-top-card, .ph5, .artdeco-card, main, section');
          const scopedName    = nearestCard?.querySelector('h1, [data-anonymize="person-name"], .text-heading-xlarge');
          const fallbackEl    = document.querySelector('h1, [data-anonymize="person-name"], .text-heading-xlarge');
          const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
          const raw = scopedName?.textContent || fallbackEl?.textContent || '';
          return normalize(raw) || fallbackName || 'Unknown';
        }, participantName);
        participantName = normalizeParticipantName(candidateName, profileUrl);
      } catch (_) {}

      const openComposerResult = await clickMessageTriggerOnProfile(page, {
        accountId,
        profileUrl,
        maxAttempts: 3,
      });
      if (!openComposerResult.opened) {
        const screenshotInfo = openComposerResult.screenshotPath
          ? ` Screenshot: ${openComposerResult.screenshotPath}`
          : '';
        const reason = openComposerResult.reason
          || 'Profile is not messageable for this account or LinkedIn UI does not expose a usable Message control.';
        const err = new Error(`Could not open message composer from profile. ${reason}${screenshotInfo}`);
        err.code = 'NOT_MESSAGEABLE';
        err.status = 400;
        throw err;
      }
      logSendStep(
        accountId,
        `composer opened successfully via ${openComposerResult.strategy} (${openComposerResult.matched})`
      );
      await delay(1500, 3000);
    }

    const composeSelector = COMPOSER_SELECTORS;
    const beforeSnapshot = await getMessageSnapshot(page).catch(() => ({ count: 0, lastText: '', recentTexts: [] }));
    try {
      await humanType(page, composeSelector, text, { timeout: 20000 });
    } catch (typeErr) {
      const typeScreenshot = await captureFailureScreenshot(page, accountId, 'composer-input-not-found');
      const msg = String(typeErr?.message || typeErr || '');
      if (msg.includes('waitForSelector') || msg.includes('contenteditable') || msg.includes('textarea')) {
        const err = new Error(
          `Message composer input not available after opening chat. Ensure recipient is messageable for this account.` +
          (typeScreenshot ? ` Screenshot: ${typeScreenshot}` : '')
        );
        err.code = 'NOT_MESSAGEABLE';
        err.status = 400;
        throw err;
      }
      throw typeErr;
    }
    await delay(800, 1800);

    networkThreadProbe = createNetworkThreadIdProbe(page);
    await humanClick(page, '.msg-form__send-button, button[type="submit"][aria-label*="Send"]');
    const verified = await verifyMessageEcho(page, text, beforeSnapshot);
    if (!verified) {
      const err = new Error('Message send could not be confirmed in thread. Retry once with fresh session.');
      err.code = 'SEND_NOT_CONFIRMED';
      err.status = 502;
      throw err;
    }

    // W2 — Burn quota only after the send click succeeds.
    let provisionalSendAccepted = false;
    let chatId = preResolvedChatId || (await resolveThreadIdAfterSend(page, 12000));
    if (!chatId) {
      logSendStep(accountId, 'thread id unresolved after URL probe; waiting on network probe');
      chatId = await networkThreadProbe.waitForThreadId(12000);
    }
    if (!chatId) {
      logSendStep(accountId, 'thread id unresolved after network probe; trying conversation preview match');
      chatId = await resolveThreadIdFromConversationPreview(page, text, 12000);
    }
    if (!chatId) {
      logSendStep(accountId, 'thread id unresolved after preview match; scanning messaging home');
      chatId = await resolveThreadIdFromMessagingHome(
        page,
        { profileUrl, participantName, messageText: text },
        20000
      );
    }
    if (!chatId) {
      logSendStep(accountId, 'thread id unresolved after messaging-home scan; opening ranked conversation rows');
      chatId = await resolveThreadIdByClickingConversationCandidates(
        page,
        { accountId, profileUrl, participantName, messageText: text },
        25000
      );
    }
    if (!chatId) {
      const messageStillVisible = await confirmMessageVisibleInCurrentView(page, text, 15000);
      const composerCleared = await isComposerDraftCleared(page);
      const hasSendErrorBanner = await detectSendErrorBanner(page);
      if (!hasSendErrorBanner && (messageStillVisible || composerCleared)) {
        logSendStep(
          accountId,
          `thread id unresolved, but send appears accepted (visible=${messageStillVisible}, composerCleared=${composerCleared}); returning provisional chatId=new`
        );
        chatId = 'new';
        provisionalSendAccepted = true;
      } else {
        const unresolvedShot = await captureFailureScreenshot(page, accountId, 'thread-id-unresolved');
        const err = new Error(
          `Send clicked but LinkedIn thread ID was not resolved. Message may not be delivered.` +
            (unresolvedShot ? ` Screenshot: ${unresolvedShot}` : '')
        );
        err.code = 'SEND_NOT_CONFIRMED';
        err.status = 502;
        throw err;
      }
    }

    let persisted =
      chatId === 'new'
        ? await confirmMessageVisibleInCurrentView(page, text, 15000)
        : await confirmMessagePersistedInThread(page, chatId, text, 30000);

    if (!persisted && chatId === 'new' && provisionalSendAccepted) {
      const composerClearedAfterSend = await isComposerDraftCleared(page);
      const hasSendErrorBannerAfterSend = await detectSendErrorBanner(page);
      if (!hasSendErrorBannerAfterSend && composerClearedAfterSend) {
        logSendStep(
          accountId,
          'message not visible yet for provisional chatId=new, but composer remains clear with no send-error banner; accepting provisional delivery'
        );
        persisted = true;
      }
    }

    if (!persisted) {
      const persistedShot = await captureFailureScreenshot(page, accountId, 'message-not-found-after-send');
      const err = new Error(
        'Message was not found in thread after send confirmation. Message may not be delivered.' +
        (persistedShot ? ` Screenshot: ${persistedShot}` : '')
      );
      err.code = 'SEND_NOT_CONFIRMED';
      err.status = 502;
      throw err;
    }

    await checkAndIncrement(accountId, 'messagesSent');
    await delay(2000, 4000);

    if (process.env.REFRESH_SESSION_COOKIES === '1') {
      await saveCookies(accountId, await context.cookies(), {
        skipIfMissingAuthCookies: true,
        source: 'sendMessageNew',
      });
    }

    const msgId = `sent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const redis = getRedis();
    const entry = JSON.stringify({
      type: 'messageSent',
      accountId,
      targetName: normalizeParticipantName(participantName, profileUrl),
      targetProfileUrl: profileUrl, // correct: real profile URL
      textPreview: (text || '').slice(0, 200),
      messageLength: text ? text.length : 0,
      timestamp: Date.now(),
    });
    await redis.lpush(`activity:log:${accountId}`, entry);
    await redis.ltrim(`activity:log:${accountId}`, 0, 999);
    await redis.incr(`stats:messages:${accountId}`);

    return {
      id:        msgId,
      chatId,
      senderId:  '__self__',
      text,
      createdAt: new Date().toISOString(),
      isRead:    true,
    };
  } catch (err) {
    if (__attempt < 3 && isRecoverableBrowserError(err)) {
      await cleanupContext(accountId).catch(() => {});
      await delay(700 + (__attempt * 300), 1300 + (__attempt * 300));
      return sendMessageNewInternal({ accountId, profileUrl, text, proxyUrl, __attempt: __attempt + 1 });
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
    if (networkThreadProbe) {
      networkThreadProbe.stop();
    }
    if (page) await page.close().catch(() => {});
  }
}

async function sendMessageNew({ accountId, profileUrl, text, proxyUrl }) {
  return withAccountLock(accountId, async () => {
    // Pre-gate before any browser work; quota is committed after confirmed send.
    await checkOnly(accountId, 'messagesSent');
    return sendMessageNewInternal({ accountId, profileUrl, text, proxyUrl, __attempt: 1 });
  });
}

module.exports = { sendMessageNew };
