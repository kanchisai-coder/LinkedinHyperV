'use strict';

const { readMessages } = require('../actions/readMessages');
const { readThread } = require('../actions/readThread');
const { searchPeople } = require('../actions/searchPeople');
const { checkAndIncrement } = require('../rateLimit');
const { getAccountContext, cleanupContext, withAccountLock } = require('../browser');
const { loadCookies, sessionMeta } = require('../session');
const { delay, humanScroll } = require('../humanBehavior');
const { getSyncPosture, isBlockedPosture, isAutomationWarningText } = require('../syncPosture');
const {
  CONNECTIONS_SCRAPER_VERSION,
  isAuthWall,
  checkpointVisible,
  loginVisible,
  buildBlockedPageError,
  buildAutomationWarningError,
  canonicalizeLinkedInProfileUrl,
  normalizeConnectionCandidate,
} = require('./connectionScraper');

async function inspectConnectionsPage(page, maxItems = 100) {
  return page.evaluate((limit) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const absolute = (href) => {
      if (!href) return '';
      try { return new URL(href, 'https://www.linkedin.com').toString(); } catch { return href; }
    };
    const preview = (value, max = 220) => normalize(value).slice(0, max);
    const isScrollable = (node) => Boolean(node) && node.scrollHeight > node.clientHeight + 80;
    const findScrollContainer = () => {
      const candidates = [
        document.querySelector('.scaffold-finite-scroll__content'),
        document.querySelector('.scaffold-finite-scroll'),
        document.querySelector('[data-view-name*="connections"]'),
        document.querySelector('main'),
        document.scrollingElement,
      ].filter(Boolean);
      const winner = candidates.find(isScrollable) || document.scrollingElement || document.documentElement;
      const label = winner === document.scrollingElement || winner === document.documentElement
        ? 'window'
        : (winner.className || winner.tagName || 'element');
      return { node: winner, label: String(label || 'window') };
    };

    const bodyText = normalize(document.body?.innerText || '');
    const title = normalize(document.title || '');
    const rowSelectors = [
      '.mn-connection-card',
      '[data-view-name*="connections"]',
      '[data-view-name*="connection"]',
      '.entity-result',
      'main li',
    ];
    const rows = Array.from(new Set([
      ...document.querySelectorAll('.mn-connection-card'),
      ...document.querySelectorAll('[data-view-name*="connections"], [data-view-name*="connection"]'),
      ...document.querySelectorAll('.entity-result'),
      ...document.querySelectorAll('main li'),
    ]));
    const profileAnchors = Array.from(document.querySelectorAll('main a[href*="/in/"], a[href*="linkedin.com/in/"]'));
    const selectorCounts = {
      main: document.querySelectorAll('main').length,
      cards: document.querySelectorAll('.mn-connection-card').length,
      connectionAnchors: profileAnchors.length,
      resultLists: document.querySelectorAll('ul, ol').length,
      listItems: document.querySelectorAll('main li').length,
      entityResults: document.querySelectorAll('.entity-result').length,
    };

    const candidates = [];
    const pushCandidate = (candidate) => {
      if (!candidate) return;
      candidates.push(candidate);
    };

    for (const [index, row] of rows.entries()) {
      const profileLink =
        row.querySelector('a[href*="/in/"]')
        || row.querySelector('a[data-control-name*="connection"]')
        || row.querySelector('a[href*="linkedin.com/in/"]');
      const profileUrl = absolute(profileLink?.getAttribute('href') || profileLink?.href || '');
      const name = normalize(
        profileLink?.textContent
        || row.querySelector('[data-anonymize="person-name"]')?.textContent
        || row.querySelector('.mn-connection-card__name')?.textContent
        || row.querySelector('.entity-result__title-text')?.textContent
      );
      const headline = normalize(
        row.querySelector('.mn-connection-card__occupation')?.textContent
        || row.querySelector('.entity-result__primary-subtitle')?.textContent
        || row.querySelector('.t-14.t-normal')?.textContent
      );
      const avatarUrl =
        row.querySelector('img')?.getAttribute('src')
        || row.querySelector('img')?.getAttribute('data-delayed-url')
        || '';
      const rowText = preview(row.textContent || '', 400);
      if (!profileUrl && !name) continue;
      pushCandidate({
        profileUrl,
        name,
        headline,
        avatarUrl: avatarUrl || null,
        rowIndex: index,
        rowText,
        source: row.matches('.mn-connection-card') ? 'card' : row.matches('.entity-result') ? 'entity-result' : 'row',
        selectors: {
          profileLink: Boolean(profileLink),
          card: row.matches('.mn-connection-card'),
          entityResult: row.matches('.entity-result'),
        },
      });
    }

    for (const [index, anchor] of profileAnchors.entries()) {
      const row = anchor.closest('.mn-connection-card, .entity-result, li, [data-view-name*="connections"], [data-view-name*="connection"]');
      const rowText = preview(row?.textContent || anchor.textContent || '', 400);
      const headline = normalize(
        row?.querySelector('.mn-connection-card__occupation')?.textContent
        || row?.querySelector('.entity-result__primary-subtitle')?.textContent
        || row?.querySelector('.t-14.t-normal')?.textContent
      );
      const avatarUrl =
        row?.querySelector('img')?.getAttribute('src')
        || row?.querySelector('img')?.getAttribute('data-delayed-url')
        || '';
      pushCandidate({
        profileUrl: absolute(anchor.getAttribute('href') || anchor.href || ''),
        name: normalize(anchor.textContent || row?.querySelector('[data-anonymize="person-name"]')?.textContent),
        headline,
        avatarUrl: avatarUrl || null,
        rowIndex: index,
        rowText,
        source: 'anchor',
        selectors: {
          anchorOnly: true,
          hasRow: Boolean(row),
        },
      });
    }

    const lowerText = bodyText.toLowerCase();
    const finalUrl = window.location.href;
    const automationWarning = lowerText.includes('automation') && (
      lowerText.includes('suspicious activity')
      || lowerText.includes('unusual activity')
      || lowerText.includes('temporarily restricted')
    );
    const explicitEmpty = lowerText.includes('you have no connections')
      || lowerText.includes('no connections found')
      || lowerText.includes('start growing your network')
      || lowerText.includes('grow your network');
    const authState = finalUrl.toLowerCase().includes('/checkpoint') || lowerText.includes('security verification')
      ? 'checkpoint'
      : automationWarning
        ? 'automation_warning'
      : (
          finalUrl.toLowerCase().includes('/login')
          || finalUrl.toLowerCase().includes('/authwall')
          || finalUrl.toLowerCase().includes('/challenge')
          || lowerText.includes('sign in')
          || lowerText.includes('forgot password')
        )
        ? 'login'
        : 'ok';

    const scrollContainer = findScrollContainer();

    return {
      candidates: candidates.slice(0, Math.max(limit * 3, 120)),
      diagnostics: {
        finalUrl,
        title,
        textSample: bodyText.slice(0, 400),
        authState,
        automationWarning,
        explicitEmpty,
        selectorCounts,
        rowCount: rows.length,
        rowSelectors,
        anchorsSeen: profileAnchors.length,
        rowSamples: candidates.slice(0, 6).map((candidate) => ({
          name: preview(candidate.name || '', 80),
          profileUrl: preview(candidate.profileUrl || '', 120),
          headline: preview(candidate.headline || '', 120),
          rowText: preview(candidate.rowText || '', 180),
          source: candidate.source,
        })),
        scroll: {
          containerType: scrollContainer.label,
          scrollTop: scrollContainer.node?.scrollTop || 0,
          scrollHeight: scrollContainer.node?.scrollHeight || 0,
          clientHeight: scrollContainer.node?.clientHeight || 0,
        },
      },
    };
  }, maxItems);
}

async function scrollConnectionsList(page) {
  return page.evaluate(() => {
    const isScrollable = (node) => Boolean(node) && node.scrollHeight > node.clientHeight + 80;
    const candidates = [
      document.querySelector('.scaffold-finite-scroll__content'),
      document.querySelector('.scaffold-finite-scroll'),
      document.querySelector('[data-view-name*="connections"]'),
      document.querySelector('main'),
      document.scrollingElement,
    ].filter(Boolean);
    const target = candidates.find(isScrollable) || document.scrollingElement || document.documentElement;
    const before = target.scrollTop || window.scrollY || 0;
    const delta = Math.max(Math.floor((target.clientHeight || window.innerHeight || 800) * 0.85), 500);
    if (target === document.scrollingElement || target === document.documentElement) {
      window.scrollTo({ top: before + delta, behavior: 'instant' });
    } else {
      target.scrollTop = before + delta;
    }
    const after = target.scrollTop || window.scrollY || 0;
    return {
      containerType: target === document.scrollingElement || target === document.documentElement
        ? 'window'
        : String(target.className || target.tagName || 'element'),
      before,
      after,
      changed: after !== before,
    };
  });
}

function describeSurface(surface) {
  const value = String(surface || 'page').replace(/[-_:]+/g, ' ').trim();
  return value || 'page';
}

function isRedirectLoopError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('err_too_many_redirects') || message.includes('too many redirects');
}

function buildSurfaceBlockedError(accountId, surface, diagnostics = {}) {
  const sample = String(diagnostics.textSample || '');
  const finalUrl = String(diagnostics.finalUrl || '').toLowerCase();
  const label = describeSurface(surface);
  const err = new Error(
    diagnostics.finalUrl
      ? `LinkedIn redirected the ${label} for ${accountId} to ${diagnostics.finalUrl}.`
      : `LinkedIn blocked the ${label} for ${accountId}.`
  );
  err.status = 401;
  err.diagnostics = diagnostics;
  if (checkpointVisible(sample) || finalUrl.includes('/checkpoint') || finalUrl.includes('/challenge')) {
    err.code = 'CHECKPOINT_INCOMPLETE';
  } else if (finalUrl.includes('/authwall')) {
    err.code = 'AUTHWALL_REDIRECT';
  } else {
    err.code = 'SESSION_EXPIRED';
  }
  return err;
}

function buildSurfaceRedirectError(accountId, surface, requestedUrl, err, diagnostics = {}) {
  const label = describeSurface(surface);
  const wrapped = new Error(
    `LinkedIn redirected the ${label} for ${accountId} while loading ${requestedUrl}. ${String(err?.message || err || '')}`.trim()
  );
  wrapped.status = 401;
  wrapped.code = 'AUTHWALL_REDIRECT';
  wrapped.diagnostics = {
    ...diagnostics,
    requestedUrl,
    finalUrl: diagnostics.finalUrl || diagnostics.currentUrl || null,
    rawError: String(err?.message || err || ''),
  };
  return wrapped;
}

async function inspectLinkedInPageState(page) {
  const diagnostics = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const textSample = normalize(document.body?.innerText || '').slice(0, 500);
    const finalUrl = window.location.href;
    const title = normalize(document.title || '');
    return {
      finalUrl,
      title,
      textSample,
    };
  }).catch(() => ({
    finalUrl: page.url(),
    title: '',
    textSample: '',
  }));

  const finalUrl = String(diagnostics.finalUrl || page.url() || '');
  const textSample = String(diagnostics.textSample || '');
  const authState = checkpointVisible(textSample) || /\/checkpoint|\/challenge/i.test(finalUrl)
    ? 'checkpoint'
    : isAutomationWarningText(textSample)
      ? 'automation_warning'
      : (loginVisible(textSample) || isAuthWall(finalUrl))
        ? 'login'
        : 'ok';

  return {
    ...diagnostics,
    authState,
    warningUrl: authState === 'automation_warning' ? finalUrl : null,
  };
}

function shouldRetryFreshContext(err, diagnostics, cookiesLoaded, attempt) {
  if (attempt > 0 || !cookiesLoaded) return false;
  if (isRedirectLoopError(err)) return true;
  const authState = String(diagnostics?.authState || '').toLowerCase();
  return authState === 'login' || authState === 'checkpoint' || isAuthWall(diagnostics?.finalUrl);
}

async function openLinkedInPage({ accountId, proxyUrl, url, waitForSelector, scrollY = 300, surface = 'page' }) {
  const openAttempt = async (attempt = 0, forceCookieReload = false) => {
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
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        if (shouldRetryFreshContext(err, null, cookiesLoaded, attempt)) {
          await page.close().catch(() => {});
          await cleanupContext(accountId).catch(() => {});
          return openAttempt(attempt + 1, true);
        }
        throw buildSurfaceRedirectError(accountId, surface, url, err, {
          currentUrl: page.url(),
        });
      }

      let diagnostics = await inspectLinkedInPageState(page);
      if (diagnostics.authState === 'automation_warning') {
        throw buildAutomationWarningError(accountId, diagnostics);
      }
      if (diagnostics.authState === 'login' || diagnostics.authState === 'checkpoint' || isAuthWall(diagnostics.finalUrl)) {
        if (shouldRetryFreshContext(null, diagnostics, cookiesLoaded, attempt)) {
          await page.close().catch(() => {});
          await cleanupContext(accountId).catch(() => {});
          return openAttempt(attempt + 1, true);
        }
        throw buildSurfaceBlockedError(accountId, surface, diagnostics);
      }

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout: 12000 }).catch(() => null);
      }

      await delay(700, 1400);
      if (scrollY) {
        await humanScroll(page, scrollY);
        await delay(500, 1000);
      }

      diagnostics = await inspectLinkedInPageState(page);
      if (diagnostics.authState === 'automation_warning') {
        throw buildAutomationWarningError(accountId, diagnostics);
      }
      if (diagnostics.authState === 'login' || diagnostics.authState === 'checkpoint' || isAuthWall(diagnostics.finalUrl)) {
        throw buildSurfaceBlockedError(accountId, surface, diagnostics);
      }

      return page;
    } catch (err) {
      if (page) await page.close().catch(() => {});
      throw err;
    }
  };

  return openAttempt();
}

async function withPageRead(accountId, fn) {
  return withAccountLock(accountId, fn);
}

async function inspectInvitationsPage(page, direction, maxItems = 50) {
  return page.evaluate(({ readDirection, limit }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const absolute = (href) => {
      if (!href) return '';
      try { return new URL(href, 'https://www.linkedin.com').toString(); } catch { return href; }
    };
    const preview = (value, max = 220) => normalize(value).slice(0, max);
    const text = normalize(document.body?.innerText || '');
    const lowerText = text.toLowerCase();
    const finalUrl = window.location.href;
    const title = normalize(document.title || '');
    const authState = finalUrl.toLowerCase().includes('/checkpoint') || lowerText.includes('security verification')
      ? 'checkpoint'
      : (
          finalUrl.toLowerCase().includes('/login')
          || finalUrl.toLowerCase().includes('/authwall')
          || finalUrl.toLowerCase().includes('/challenge')
          || lowerText.includes('sign in')
          || lowerText.includes('forgot password')
        )
        ? 'login'
        : (
            lowerText.includes('automation')
            && (lowerText.includes('suspicious activity') || lowerText.includes('unusual activity') || lowerText.includes('temporarily restricted'))
          )
          ? 'automation_warning'
          : 'ok';
    const explicitEmpty = lowerText.includes('no sent invitations')
      || lowerText.includes('you haven’t sent any invitations')
      || lowerText.includes("you haven't sent any invitations")
      || lowerText.includes('no pending invitations')
      || lowerText.includes('you have no invitations')
      || lowerText.includes('nothing to show right now');
    const rows = Array.from(document.querySelectorAll(
      'main li, .invitation-card, [data-view-name*="invitation"], [data-view-name*="invite"], .mn-invitation-manager__invitation-card'
    ));
    const selectorCounts = {
      main: document.querySelectorAll('main').length,
      invitationCards: document.querySelectorAll('.invitation-card, .mn-invitation-manager__invitation-card').length,
      invitationViews: document.querySelectorAll('[data-view-name*="invitation"], [data-view-name*="invite"]').length,
      listItems: document.querySelectorAll('main li').length,
      anchors: document.querySelectorAll('main a[href*="/in/"], a[href*="linkedin.com/in/"]').length,
    };
    const candidates = rows.slice(0, Math.max(limit * 3, 120)).map((row, idx) => {
      const profileLink = row.querySelector('a[href*="/in/"], a[href*="linkedin.com/in/"]');
      const name = normalize(
        profileLink?.textContent
        || row.querySelector('[data-anonymize="person-name"], .invitation-card__title, .entity-result__title-text')?.textContent
      );
      const headline = normalize(
        row.querySelector('.invitation-card__subtitle, .entity-result__primary-subtitle, .t-14.t-normal')?.textContent
      );
      const profileUrl = absolute(profileLink?.getAttribute('href') || profileLink?.href || '');
      return {
        id: profileUrl || `invitation-${readDirection}-${idx}-${name || 'unknown'}`,
        profileUrl,
        name: name || 'Unknown',
        headline: headline || null,
        direction: readDirection,
        status: 'pending',
        rowText: preview(row.textContent || '', 220),
      };
    }).filter((item) => item.profileUrl || item.name !== 'Unknown');

    return {
      items: candidates.slice(0, limit),
      diagnostics: {
        finalUrl,
        title,
        textSample: text.slice(0, 400),
        authState,
        explicitEmpty,
        selectorCounts,
        rowCount: rows.length,
        rowSamples: candidates.slice(0, 6).map((item) => ({
          name: preview(item.name || '', 80),
          profileUrl: preview(item.profileUrl || '', 120),
          headline: preview(item.headline || '', 120),
          rowText: preview(item.rowText || '', 160),
        })),
      },
    };
  }, { readDirection: direction, limit: maxItems });
}

class LinkedInProvider {
  async getAccountHealth(accountId) {
    const meta = await sessionMeta(accountId).catch(() => null);
    const accountRepo = require('../db/repositories/AccountRepository');
    const account = await accountRepo.getAccountById(accountId).catch(() => null);
    const posture = await getSyncPosture(accountId).catch(() => ({ posture: 'healthy' }));
    const hasSession = Boolean(meta?.exists || meta?.savedAt || meta);
    const storedReachability = String(account?.liveReachability || '').trim();
    const liveReachability = storedReachability && storedReachability !== 'unknown'
      ? storedReachability
      : String(account?.sessionStatus || '') === 'restricted'
        ? 'automation_warning'
        : String(account?.sessionStatus || '') === 'checkpoint'
          ? 'checkpoint'
          : String(account?.sessionStatus || '') === 'expired'
            ? 'login_redirect'
            : (
              isBlockedPosture(posture?.posture)
                ? posture?.posture === 'expired'
                  ? 'login_redirect'
                  : posture?.posture
                : hasSession ? 'unknown' : 'missing_session'
            );
    const blockedReachability = new Set(['login_redirect', 'checkpoint', 'blocked', 'automation_warning']);
    const coverage = !hasSession
      ? 'missing_session'
      : (isBlockedPosture(posture?.posture) || blockedReachability.has(liveReachability))
        ? 'blocked'
        : posture?.posture === 'degraded' || liveReachability === 'unknown'
          ? 'stale'
          : 'available';
    return {
      accountId,
      hasSession,
      lastSeen: meta?.savedAt || meta?.updatedAt || null,
      coverage,
      syncPosture: posture?.posture || 'healthy',
      postureReason: posture?.reason || null,
      nextAllowedAt: posture?.nextAllowedAt || null,
      sessionStatus: account?.sessionStatus || (hasSession ? 'connected' : 'disconnected'),
      liveReachability,
      liveReachabilityAt: account?.liveReachabilityAt || null,
      liveReachabilityUrl: account?.liveReachabilityUrl || null,
    };
  }

  async readInbox({ accountId, proxyUrl, limit = 50 }) {
    await checkAndIncrement(accountId, 'inboxReads');
    const payload = await readMessages({ accountId, proxyUrl, limit });
    return {
      surface: 'inbox',
      coverage: 'available',
      items: payload.items || [],
      cursor: payload.cursor || null,
      hasMore: Boolean(payload.hasMore),
    };
  }

  async readThread({ accountId, chatId, threadUrl, participantName, participantProfileUrl, proxyUrl, limit = 100 }) {
    const payload = await readThread({
      accountId,
      chatId,
      threadUrl,
      participantName,
      participantProfileUrl,
      proxyUrl,
      limit,
    });
    return {
      surface: 'thread',
      coverage: payload.ok === false ? 'partial' : 'available',
      items: payload.items || [],
      participant: payload.participant || null,
      resolvedChatId: payload.resolvedChatId || chatId,
      threadUrl: payload.threadUrl || threadUrl || null,
      code: payload.code || 'OK',
      diagnostics: payload.diagnostics || null,
      partialParticipant: payload.partialParticipant || null,
      cursor: payload.cursor || null,
      hasMore: Boolean(payload.hasMore),
    };
  }

  async searchProfiles({ accountId, query, proxyUrl, limit = 10 }) {
    const items = await searchPeople({ accountId, query, proxyUrl, limit });
    return {
      surface: 'search',
      coverage: 'available',
      items: Array.isArray(items) ? items : [],
    };
  }

  async readProfile({ accountId, profileUrl, proxyUrl }) {
    return withPageRead(accountId, async () => {
      const page = await openLinkedInPage({
        accountId,
        proxyUrl,
        url: profileUrl,
        waitForSelector: 'main, .pv-top-card, h1',
        scrollY: 350,
        surface: 'profile page',
      });

      try {
        const profile = await page.evaluate(() => {
          const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
          const absolute = (href) => {
            if (!href) return '';
            try { return new URL(href, 'https://www.linkedin.com').toString(); } catch { return href; }
          };
          const root = document.querySelector('main') || document;
          const name = normalize(root.querySelector('h1, [data-anonymize="person-name"], .text-heading-xlarge')?.textContent);
          const headline = normalize(root.querySelector('.text-body-medium, .pv-text-details__left-panel div.text-body-medium')?.textContent);
          const profileLocation = normalize(root.querySelector('.text-body-small.inline, .pv-text-details__left-panel span.text-body-small')?.textContent);
          const avatarUrl = root.querySelector('img.pv-top-card-profile-picture__image, .pv-top-card img')?.getAttribute('src') || '';
          const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || window.location.href;

          return {
            name: name || 'Unknown',
            headline: headline || null,
            location: profileLocation || null,
            avatarUrl: avatarUrl || null,
            profileUrl: absolute(canonical),
          };
        });

        return {
          surface: 'profile',
          coverage: profile?.name && profile.name !== 'Unknown' ? 'available' : 'partial',
          item: profile,
        };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async readNotifications({ accountId, proxyUrl, limit = 50 }) {
    return withPageRead(accountId, async () => {
      const page = await openLinkedInPage({
        accountId,
        proxyUrl,
        url: 'https://www.linkedin.com/notifications/',
        waitForSelector: 'main',
        scrollY: 450,
        surface: 'notifications page',
      });

      try {
        const items = await page.evaluate((maxItems) => {
          const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
          const absolute = (href) => {
            if (!href) return '';
            try { return new URL(href, 'https://www.linkedin.com').toString(); } catch { return href; }
          };
          const rows = Array.from(document.querySelectorAll('main li, [data-view-name*="notification"], .nt-card-list__item'));
          return rows.slice(0, maxItems).map((row, idx) => {
            const link = row.querySelector('a[href]');
            const time = row.querySelector('time');
            const profileLink = row.querySelector('a[href*="/in/"]');
            const text = normalize(row.textContent);
            return {
              id: row.getAttribute('data-urn') || link?.getAttribute('href') || `notification-${idx}-${text.slice(0, 32)}`,
              type: 'notification',
              title: text.slice(0, 120) || 'LinkedIn notification',
              text,
              url: absolute(link?.getAttribute('href') || ''),
              targetProfileUrl: absolute(profileLink?.getAttribute('href') || ''),
              targetName: normalize(profileLink?.textContent),
              occurredAt: time?.getAttribute('datetime') || new Date().toISOString(),
            };
          }).filter((item) => item.text);
        }, limit);

        return {
          surface: 'notifications',
          coverage: items.length > 0 ? 'available' : 'empty_or_unavailable',
          items,
        };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async readInvitations({ accountId, proxyUrl, direction = 'sent', limit = 50 }) {
    return withPageRead(accountId, async () => {
      const url = direction === 'received'
        ? 'https://www.linkedin.com/mynetwork/invitation-manager/'
        : 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
      const page = await openLinkedInPage({
        accountId,
        proxyUrl,
        url,
        waitForSelector: 'main',
        scrollY: 450,
        surface: `${direction} invitations page`,
      });

      try {
        let inspection = await inspectInvitationsPage(page, direction, limit);
        let scrollPasses = 0;
        for (let pass = 0; pass < 3; pass += 1) {
          const authState = inspection?.diagnostics?.authState;
          if (authState === 'automation_warning') {
            throw buildAutomationWarningError(accountId, inspection.diagnostics);
          }
          if (authState === 'login' || authState === 'checkpoint' || isAuthWall(inspection?.diagnostics?.finalUrl)) {
            throw buildSurfaceBlockedError(accountId, `${direction} invitations page`, inspection.diagnostics);
          }
          if ((inspection.items || []).length > 0 || inspection?.diagnostics?.explicitEmpty) {
            break;
          }
          await humanScroll(page, 420).catch(() => {});
          await delay(500, 900);
          scrollPasses += 1;
          inspection = await inspectInvitationsPage(page, direction, limit);
        }

        return {
          surface: `invitations:${direction}`,
          coverage: inspection.items.length > 0
            ? 'available'
            : (inspection.diagnostics.explicitEmpty ? 'empty' : 'partial'),
          items: inspection.items,
          diagnostics: {
            ...inspection.diagnostics,
            scrollPasses,
          },
        };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async readConnections({ accountId, proxyUrl, limit = 100 }) {
    return withPageRead(accountId, async () => {
      const page = await openLinkedInPage({
        accountId,
        proxyUrl,
        url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
        waitForSelector: 'main',
        scrollY: 600,
        surface: 'connections page',
      });

      try {
        let inspection = await inspectConnectionsPage(page, limit);
        const seenUrls = new Set();
        let stableAnchorPasses = 0;
        let lastAnchorCount = -1;
        let scrollPasses = 0;
        let lastScroll = { containerType: inspection?.diagnostics?.scroll?.containerType || 'window' };

        for (let pass = 0; pass < 10; pass += 1) {
          const authState = inspection?.diagnostics?.authState;
          const finalUrl = inspection?.diagnostics?.finalUrl;
          const textSample = inspection?.diagnostics?.textSample || '';

          if (authState === 'automation_warning' || isAutomationWarningText(textSample)) {
            throw buildAutomationWarningError(accountId, inspection.diagnostics);
          }
          if (authState === 'login' || authState === 'checkpoint' || isAuthWall(finalUrl)) {
            throw buildBlockedPageError(accountId, inspection.diagnostics);
          }

          for (const candidate of inspection.candidates || []) {
            const key = canonicalizeLinkedInProfileUrl(candidate.profileUrl) || `${candidate.name}:${candidate.rowIndex}`;
            if (key) seenUrls.add(key);
          }

          if (inspection.diagnostics.explicitEmpty || seenUrls.size >= limit) {
            break;
          }

          const anchorCount = Number(inspection?.diagnostics?.anchorsSeen || 0);
          if (anchorCount === lastAnchorCount) {
            stableAnchorPasses += 1;
          } else {
            stableAnchorPasses = 0;
          }
          if (stableAnchorPasses >= 2) {
            break;
          }

          lastAnchorCount = anchorCount;
          lastScroll = await scrollConnectionsList(page);
          scrollPasses += 1;
          await delay(500, 900);
          inspection = await inspectConnectionsPage(page, limit);
        }

        const deduped = new Map();
        const rejectedRows = [];
        for (const candidate of inspection.candidates || []) {
          const normalized = normalizeConnectionCandidate(accountId, candidate);
          if (!normalized.accepted) {
            rejectedRows.push({
              reason: normalized.reason,
              profileUrl: normalized.profileUrl || candidate.profileUrl || null,
              name: candidate.name || null,
              source: candidate.source || 'unknown',
            });
            continue;
          }
          if (!deduped.has(normalized.item.profileUrl)) {
            deduped.set(normalized.item.profileUrl, normalized.item);
          }
          if (deduped.size >= limit) break;
        }

        const items = Array.from(deduped.values());
        const payloadCoverage = items.length > 0
          ? 'available'
          : (inspection.diagnostics.explicitEmpty ? 'empty' : 'partial');
        const diagnostics = {
          ...inspection.diagnostics,
          scrollPasses,
          anchorsSeen: seenUrls.size || inspection.diagnostics.anchorsSeen || 0,
          validRows: items.length,
          rejectedRows: rejectedRows.length,
          rejectedSamples: rejectedRows.slice(0, 6),
          scraperVersion: CONNECTIONS_SCRAPER_VERSION,
          scrollContainerType: lastScroll.containerType || inspection?.diagnostics?.scroll?.containerType || 'window',
        };

        return {
          surface: 'connections',
          coverage: payloadCoverage,
          items,
          diagnostics,
        };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async repairAccountContext(accountId) {
    await cleanupContext(accountId).catch(() => {});
  }
}

module.exports = new LinkedInProvider();
module.exports.__private = {
  canonicalizeLinkedInProfileUrl,
  normalizeConnectionCandidate,
  buildBlockedPageError,
  buildAutomationWarningError,
  buildSurfaceBlockedError,
  buildSurfaceRedirectError,
  checkpointVisible,
  loginVisible,
  isAuthWall,
};
