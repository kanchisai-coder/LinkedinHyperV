'use strict';

const { getAccountContext, cleanupContext, withAccountLock } = require('../browser');
const { loadCookies, saveCookies } = require('../session');
const { delay }                    = require('../humanBehavior');
const { isAutomationWarningText } = require('../syncPosture');
const accountRepo = require('../db/repositories/AccountRepository');
const fs = require('fs');
const path = require('path');

const DEBUG_SCREENSHOT_DIR =
  process.env.LI_DEBUG_SCREENSHOT_DIR || '/tmp/linkedin-hyper-debug';

function isBlockedAuthPage(url) {
  const value = String(url || '').toLowerCase();
  return (
    value.includes('/uas/login') ||
    value.includes('/login') ||
    value.includes('/checkpoint') ||
    value.includes('/authwall') ||
    value.includes('challenge')
  );
}

function isCheckpointLike(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('/checkpoint') || value.includes('challenge');
}

async function inspectAuthState(page) {
  try {
    return await page.evaluate(() => {
      const txt = (document.body?.innerText || '').toLowerCase();
      const hasLoginForm =
        Boolean(document.querySelector('input[name="session_key"], input[name="session_password"], form[action*="login"]'));
      const hasAuthwallMarkers =
        txt.includes('join linkedin') ||
        txt.includes('sign in') ||
        txt.includes('new to linkedin') ||
        txt.includes('continue to linkedin') ||
        txt.includes('unlock your profile') ||
        txt.includes('create your account');
      const navLinkSelectors = [
        'a[href*="/feed"]',
        'a[href*="/mynetwork"]',
        'a[href*="/messaging"]',
        'a[href*="/notifications"]',
      ].join(', ');
      const navLinks = Array.from(document.querySelectorAll(navLinkSelectors))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const hasPrimaryNavLinks = navLinks.length >= 2;
      const hasSignedInNav = hasPrimaryNavLinks || Boolean(
        document.querySelector(
          [
            '.global-nav__me',
            '.global-nav__me-photo',
            '.global-nav__primary-link-me-menu-trigger',
            '#global-nav-search',
            '.search-global-typeahead',
            '[data-test-global-nav-me]',
            'header.global-nav',
            '.global-nav',
          ].join(', ')
        )
      );
      const hasMessagingShell =
        Boolean(document.querySelector('.msg-conversations-container, .msg-overlay-list-bubble, .msg-s-message-list'));
      const hasGuestCta =
        Boolean(
          document.querySelector(
            [
              'a[data-tracking-control-name*="guest_homepage"]',
              'a[data-test-id="home-hero-sign-in-cta"]',
              '.nav__button-secondary',
              'main section a[href*="/signup"]',
            ].join(', ')
          )
        );
      const hasAutomationWarning =
        txt.includes('automated behavior') ||
        txt.includes('using automation') ||
        txt.includes('unusual activity') ||
        txt.includes('temporarily restricted');

      return {
        hasLoginForm,
        hasAuthwallMarkers,
        hasSignedInNav,
        hasMessagingShell,
        hasGuestCta,
        hasAutomationWarning,
        textSample: txt.slice(0, 400),
        url: location.href,
      };
    });
  } catch (err) {
    return {
      hasLoginForm: false,
      hasAuthwallMarkers: false,
      hasSignedInNav: false,
      hasMessagingShell: false,
      hasGuestCta: false,
      hasAutomationWarning: false,
      textSample: '',
      url: page.url(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isAuthenticatedState(state) {
  return Boolean(state?.hasSignedInNav || state?.hasMessagingShell);
}

function isLoggedOutState(state) {
  const guestOnlyState = Boolean(
    state?.hasGuestCta &&
    !state?.hasSignedInNav &&
    !state?.hasMessagingShell
  );
  return Boolean(state?.hasLoginForm || state?.hasAuthwallMarkers || guestOnlyState);
}

function isStrongMemberUrl(url) {
  const value = String(url || '').toLowerCase();
  if (!value.includes('linkedin.com')) return false;
  if (isBlockedAuthPage(value)) return false;
  try {
    const parsed = new URL(value);
    const memberPath = String(parsed.pathname || '/').toLowerCase();
    return (
      memberPath === '/feed/' ||
      memberPath.startsWith('/feed') ||
      memberPath.startsWith('/messaging') ||
      memberPath.startsWith('/mynetwork') ||
      memberPath.startsWith('/notifications') ||
      memberPath.startsWith('/jobs') ||
      memberPath.startsWith('/search') ||
      memberPath.startsWith('/in/') ||
      memberPath.startsWith('/sales/') ||
      memberPath.startsWith('/groups/')
    );
  } catch {
    return false;
  }
}

function isAuthenticatedLinkedInPage(state) {
  const hasUiSignal = Boolean(state?.hasSignedInNav || state?.hasMessagingShell);
  const hasStrongUrlSignal = isStrongMemberUrl(state?.url);
  return Boolean(
    state &&
    !isBlockedAuthPage(state.url) &&
    !isLoggedOutState(state) &&
    (hasUiSignal || hasStrongUrlSignal)
  );
}

async function waitForSettledAuthState(page, timeoutMs = 20000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let lastState = await inspectAuthState(page);

  while (Date.now() < deadline) {
    if (isAuthenticatedLinkedInPage(lastState)) {
      return lastState;
    }
    await delay(700, 1000);
    lastState = await inspectAuthState(page);
  }

  return lastState;
}

function getCookieFlags(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  const linkedIn = list.filter((c) => String(c?.domain || '').includes('linkedin.com'));
  return {
    total: linkedIn.length,
    hasLiAt: linkedIn.some((c) => c?.name === 'li_at' && c?.value),
    hasJsession: linkedIn.some((c) => c?.name === 'JSESSIONID' && c?.value),
  };
}

function classifyVerifyFailure({ accountId, feedUrl, messagingUrl, feedState, messagingState, cookieFlags }) {
  if (
    feedState?.hasAutomationWarning ||
    messagingState?.hasAutomationWarning ||
    isAutomationWarningText(feedState?.textSample) ||
    isAutomationWarningText(messagingState?.textSample)
  ) {
    return {
      code: 'AUTOMATION_WARNING',
      message: `LinkedIn flagged automation or unusual activity for account ${accountId}. Pause automation and reconnect manually.`,
      warningUrl: messagingState?.url || feedState?.url || messagingUrl || feedUrl,
    };
  }
  if (!cookieFlags.hasLiAt || !cookieFlags.hasJsession) {
    return {
      code: 'COOKIES_MISSING',
      message: `Required LinkedIn cookies (li_at/JSESSIONID) are missing for account ${accountId}. Re-import cookies.`,
    };
  }
  if (isCheckpointLike(feedUrl) || isCheckpointLike(messagingUrl)) {
    return {
      code: 'CHECKPOINT_INCOMPLETE',
      message: `LinkedIn checkpoint/challenge is still pending for account ${accountId}. Complete checkpoint and re-import cookies.`,
    };
  }
  if (isBlockedAuthPage(feedUrl) || isBlockedAuthPage(messagingUrl) || isLoggedOutState(feedState) || isLoggedOutState(messagingState)) {
    return {
      code: 'LOGIN_NOT_FINISHED',
      message: `LinkedIn login is not fully completed for account ${accountId}. Complete login and re-import cookies.`,
    };
  }
  return {
    code: 'AUTHENTICATED_STATE_NOT_REACHED',
    message: `Authenticated LinkedIn member state was not reached for account ${accountId}. Re-import cookies.`,
  };
}

function hasRequiredAuthCookies(flags) {
  return Boolean(flags?.hasLiAt && flags?.hasJsession);
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
    fs.mkdirSync(DEBUG_SCREENSHOT_DIR, { recursive: true });
    const filename = `${safeName(accountId)}-${Date.now()}-${safeName(label)}.png`;
    const filePath = path.join(DEBUG_SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch (_) {
    return null;
  }
}

async function tryNavigate(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    return { ok: true, url: page.url() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      url: page.url(),
    };
  }
}

async function verifySessionInternal({ accountId, proxyUrl, useFreshContext = true }) {
  // Always verify from a fresh browser context to avoid false positives from
  // previously authenticated in-memory contexts.
  if (useFreshContext) {
    await cleanupContext(accountId).catch(() => {});
  }
  const { context } = await getAccountContext(accountId, proxyUrl, {
    forceFresh: false,
  });
  let page;

  try {
    const cookies = await loadCookies(accountId);
    if (!cookies || cookies.length === 0) {
      const err = new Error(`No session for account ${accountId}. Import cookies first via POST /accounts/${accountId}/session`);
      err.code   = 'NO_SESSION';
      err.status = 401;
      throw err;
    }

    await context.addCookies(cookies);
    let lastVerifyError = null;
    const maxVerifyAttempts = 2;

    for (let attempt = 1; attempt <= maxVerifyAttempts; attempt += 1) {
      page = await context.newPage();

      // Check feed first for baseline auth signal.
      const feedResult = await tryNavigate(page, 'https://www.linkedin.com/feed/');
      await delay(600, 1200);
      const feedUrl = page.url();
      const feedState = await waitForSettledAuthState(page, 20000);

      // Messaging must be accessible for automation sends.
      const messagingResult = await tryNavigate(page, 'https://www.linkedin.com/messaging/');
      await delay(600, 1200);
      const messagingUrl = page.url();
      const messagingState = await waitForSettledAuthState(page, 20000);
      const contextCookies = await context.cookies().catch(() => []);
      const cookieFlags = getCookieFlags(contextCookies);

      // LinkedIn UI markers can be flaky; accept strong member URL signal when required cookies exist.
      const feedAuthenticated = (
        feedResult.ok &&
        !isBlockedAuthPage(feedUrl) &&
        hasRequiredAuthCookies(cookieFlags) &&
        !isLoggedOutState(feedState) &&
        (isAuthenticatedLinkedInPage(feedState) || isStrongMemberUrl(feedUrl))
      );

      const messagingAuthenticated = (
        messagingResult.ok &&
        !isBlockedAuthPage(messagingUrl) &&
        hasRequiredAuthCookies(cookieFlags) &&
        !isLoggedOutState(messagingState) &&
        (isAuthenticatedLinkedInPage(messagingState) || isStrongMemberUrl(messagingUrl))
      );

      // Soft fallback: member cookies + no logged-out markers + non-blocked page.
      const feedSoftAuthenticated = (
        feedResult.ok &&
        !isBlockedAuthPage(feedUrl) &&
        hasRequiredAuthCookies(cookieFlags) &&
        !isLoggedOutState(feedState)
      );

      const messagingSoftAuthenticated = (
        messagingResult.ok &&
        !isBlockedAuthPage(messagingUrl) &&
        hasRequiredAuthCookies(cookieFlags) &&
        !isLoggedOutState(messagingState)
      );

      if (messagingAuthenticated || feedAuthenticated || messagingSoftAuthenticated || feedSoftAuthenticated) {
        if (process.env.REFRESH_SESSION_COOKIES === '1') {
          await saveCookies(accountId, await context.cookies(), {
            skipIfMissingAuthCookies: true,
            source: 'verifySession',
          });
        }
        const via = messagingAuthenticated
          ? (feedAuthenticated ? 'feed+messaging' : 'messaging-only')
          : messagingSoftAuthenticated
            ? 'messaging-soft'
            : feedAuthenticated
              ? 'feed-only'
              : 'feed-soft';
        await accountRepo.updateSessionState(accountId, {
          sessionStatus: 'connected',
          verifiedAt: new Date(),
          liveReachability: 'reachable',
          liveReachabilityAt: new Date(),
          liveReachabilityUrl: (messagingAuthenticated || messagingSoftAuthenticated) ? messagingUrl : feedUrl,
        }).catch(() => {});
        return {
          ok: true,
          url: (messagingAuthenticated || messagingSoftAuthenticated) ? messagingUrl : feedUrl,
          via,
          liveReachability: 'reachable',
        };
      }

      const details = {
        feed: { ok: feedResult.ok, url: feedUrl, error: feedResult.error || null },
        messaging: { ok: messagingResult.ok, url: messagingUrl, error: messagingResult.error || null },
        authState: {
          feed: feedState,
          messaging: messagingState,
        },
        cookieFlags,
        attempt,
      };
      const failure = classifyVerifyFailure({
        accountId,
        feedUrl,
        messagingUrl,
        feedState,
        messagingState,
        cookieFlags,
      });

      const screenshot = await captureFailureScreenshot(page, accountId, `verify-${failure.code.toLowerCase()}-attempt-${attempt}`);
      const err = new Error(failure.message);
      if (screenshot) {
        err.message += ` Screenshot: ${screenshot}`;
      }
      err.code = failure.code;
      err.status = 401;
      if (failure.warningUrl) err.warningUrl = failure.warningUrl;
      err.details = details;
      const derivedReachability = failure.code === 'AUTOMATION_WARNING'
        ? 'automation_warning'
        : failure.code === 'CHECKPOINT_INCOMPLETE'
          ? 'checkpoint'
          : (failure.code === 'LOGIN_NOT_FINISHED' || failure.code === 'COOKIES_MISSING')
            ? 'login_redirect'
            : 'unknown';
      await accountRepo.updateSessionState(accountId, {
        sessionStatus: derivedReachability === 'automation_warning'
          ? 'restricted'
          : derivedReachability === 'checkpoint'
            ? 'checkpoint'
            : 'expired',
        liveReachability: derivedReachability,
        liveReachabilityAt: new Date(),
        liveReachabilityUrl: failure.warningUrl || messagingUrl || feedUrl || null,
      }).catch(() => {});
      lastVerifyError = err;

      // Retry once for this flaky LinkedIn state before failing.
      if (failure.code === 'AUTHENTICATED_STATE_NOT_REACHED' && attempt < maxVerifyAttempts) {
        await page.close().catch(() => {});
        page = null;
        await delay(1200, 1800);
        continue;
      }

      throw err;
    }

    if (lastVerifyError) {
      throw lastVerifyError;
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function verifySession({ accountId, proxyUrl, useFreshContext = true, acquireLock = true }) {
  if (!acquireLock) {
    return verifySessionInternal({ accountId, proxyUrl, useFreshContext });
  }

  return withAccountLock(accountId, async () => (
    verifySessionInternal({ accountId, proxyUrl, useFreshContext })
  ));
}

module.exports = {
  verifySession,
  inspectAuthState,
  waitForSettledAuthState,
  isAuthenticatedLinkedInPage,
  isCheckpointLike,
};
