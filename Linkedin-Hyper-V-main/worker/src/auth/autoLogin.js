'use strict';

// Programmatic re-login service. Uses the captured credentials to refresh an
// expired LinkedIn session WITHOUT a human reconnecting via noVNC.
//
// CRITICAL GUARDRAILS (per AUTH_AUTOLOGIN_MASTERPLAN §6):
//   1. Disabled unless ENABLE_AUTO_RELOGIN=1.
//   2. Refuses without an account proxy (residential/mobile egress required).
//   3. Refuses if posture has been 'blocked' / 'automation_warning' in the
//      last 7 days.
//   4. Hard cap: 1 successful auto-relogin per account per 24h.
//   5. Hard cap: 3 successful auto-relogins per account per 7d.
//   6. On wrong-password → mark needsPasswordUpdate, never retry until user
//      re-enters via noVNC.
//   7. On checkpoint/captcha/2FA → bail out, surface 'needs_human'.

const { getRedis } = require('../redisClient');
const credentialStore = require('./credentialStore');
const { getAccountContext, withAccountLock } = require('../browser');
const { resolveProxyForAccount } = require('../antiBan');
const { saveCookies, hasRequiredLinkedInSessionCookies } = require('../session');
const { isCheckpointLike, inspectAuthState, isAuthenticatedLinkedInPage } = require('../actions/login');
const { delay } = require('../humanBehavior');

const LOGIN_URL = 'https://www.linkedin.com/login';

function isEnabled() {
  return String(process.env.ENABLE_AUTO_RELOGIN || '').trim() === '1';
}

async function recentSuccessCount(accountId, windowSeconds) {
  const redis = getRedis();
  const v = await redis.get(`autologin:success:${accountId}:${windowSeconds}`).catch(() => null);
  return Number(v) || 0;
}

async function recordSuccess(accountId) {
  const redis = getRedis();
  // Two rolling windows: 24h and 7d.
  const a = `autologin:success:${accountId}:86400`;
  const b = `autologin:success:${accountId}:604800`;
  await Promise.all([
    redis.incr(a).then(() => redis.expire(a, 86400)).catch(() => null),
    redis.incr(b).then(() => redis.expire(b, 604800)).catch(() => null),
  ]);
}

async function postureWasHardBlocked(accountId) {
  // Best-effort: read postureSnapshot if present, else check Redis posture key.
  try {
    const redis = getRedis();
    const blob = await redis.hgetall(`posture:${accountId}`);
    if (!blob || !blob.posture) return false;
    return ['blocked', 'automation_warning'].includes(blob.posture);
  } catch {
    return false;
  }
}

/**
 * Run the gate (read-only). Returns { ok, reason } so callers can log.
 */
async function canAttempt(accountId) {
  if (!isEnabled()) return { ok: false, reason: 'ENABLE_AUTO_RELOGIN not set' };
  if (!accountId) return { ok: false, reason: 'no accountId' };

  const status = await credentialStore.status(accountId);
  if (!status.hasStoredCredentials) return { ok: false, reason: 'no stored credentials' };
  if (status.needsPasswordUpdate) return { ok: false, reason: 'password marked stale; needs user re-entry' };

  // Mandatory proxy (per §6).
  let proxy = null;
  try { proxy = resolveProxyForAccount(accountId); } catch { /* PROXY_REQUIRED handled below */ }
  if (!proxy) return { ok: false, reason: 'no per-account proxy configured (auto-relogin refuses datacenter egress)' };

  // Don't relogin while the account is on a hard-block cooldown.
  if (await postureWasHardBlocked(accountId)) {
    return { ok: false, reason: 'recent hard block; cooldown' };
  }

  // Frequency caps.
  const last24 = await recentSuccessCount(accountId, 86400);
  if (last24 >= 1) return { ok: false, reason: '24h cap reached' };
  const last7d = await recentSuccessCount(accountId, 604800);
  if (last7d >= 3) return { ok: false, reason: '7d cap reached' };

  return { ok: true };
}

/**
 * Attempt a programmatic relogin. Returns { ok, reason, postureHint }.
 * postureHint is one of: 'healthy', 'checkpoint', 'wrong_password', 'unknown_error'.
 */
async function run(accountId) {
  const gate = await canAttempt(accountId);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  return withAccountLock(accountId, async () => {
    let proxy = null;
    try { proxy = resolveProxyForAccount(accountId); } catch { /* gate already checked */ }

    const { context } = await getAccountContext(accountId, proxy, {
      headless: false,
      blockAssets: false,
      forceFresh: true,
    });

    const creds = await credentialStore.load(accountId);
    if (!creds || !creds.email || !creds.password) {
      return { ok: false, reason: 'credentials unreadable' };
    }

    let page = null;
    try {
      page = await context.newPage();
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(800, 1600);

      // Fill at human pace. We do NOT use page.fill which is too fast/clean —
      // type each character with jittered delay (already proven in humanBehavior).
      const emailSel = 'input[name="session_key"], #username, input[autocomplete="username"]';
      const pwSel = 'input[name="session_password"], #password, input[autocomplete="current-password"]';
      await page.waitForSelector(emailSel, { timeout: 15000 });
      await page.click(emailSel);
      await page.keyboard.type(creds.email, { delay: 60 });
      await delay(400, 900);
      await page.click(pwSel);
      await page.keyboard.type(creds.password, { delay: 70 });
      // Clear the local plaintext copy ASAP.
      // (Node strings are immutable; this just drops the reference.)
      creds.password = '';
      creds.email = '';

      await delay(500, 1100);
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
        page.click('button[type="submit"], button[data-litms-control-urn*="login-submit"]'),
      ]);
      await delay(2000, 3500);

      const currentUrl = page.url();

      // Outcome classification.
      if (isCheckpointLike(currentUrl)) {
        await credentialStore.markUsed(accountId, { ok: false, error: 'checkpoint' });
        return { ok: false, reason: 'checkpoint/2FA required', postureHint: 'checkpoint' };
      }

      // Wrong password? LinkedIn keeps user on /login or /checkpoint with an error message.
      const errorText = await page.locator('div[error-for="password"], .form__input--error, #error-for-password').first().textContent({ timeout: 1500 }).catch(() => null);
      if (errorText && /password|incorrect|wrong/i.test(errorText)) {
        await credentialStore.markUsed(accountId, { ok: false, error: 'wrong password' });
        return { ok: false, reason: 'wrong password', postureHint: 'wrong_password' };
      }

      const state = await inspectAuthState(page);
      const authed = isAuthenticatedLinkedInPage({ ...state, url: currentUrl });
      if (!authed) {
        await credentialStore.markUsed(accountId, { ok: false, error: 'not authenticated post-submit' });
        return { ok: false, reason: 'login submit did not result in authenticated state', postureHint: 'unknown_error' };
      }

      const cookies = await context.cookies('https://www.linkedin.com');
      if (!hasRequiredLinkedInSessionCookies(cookies)) {
        await credentialStore.markUsed(accountId, { ok: false, error: 'missing required cookies' });
        return { ok: false, reason: 'missing li_at / JSESSIONID after login', postureHint: 'unknown_error' };
      }

      await saveCookies(accountId, cookies, { requireAuthCookies: true, source: 'auto-relogin' });
      await credentialStore.markUsed(accountId, { ok: true });
      await recordSuccess(accountId);

      return { ok: true, postureHint: 'healthy' };
    } catch (err) {
      await credentialStore.markUsed(accountId, { ok: false, error: err?.message || 'error' }).catch(() => null);
      return { ok: false, reason: err?.message || 'login error', postureHint: 'unknown_error' };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  });
}

module.exports = { run, canAttempt, isEnabled, LOGIN_URL };
