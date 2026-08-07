'use strict';

const { getAccountContext, cleanupContext, withAccountLock } = require('../browser');
const { delay } = require('../humanBehavior');
const { saveCookies, getLinkedInCookieFlags } = require('../session');
const accountRepo = require('../db/repositories/AccountRepository');
const {
  CONNECT_SESSION_TTL_MS,
  LOGIN_URL,
  updateConnectSession,
} = require('../connectSessions');
const {
  verifySession,
  inspectAuthState,
  isAuthenticatedLinkedInPage,
  isCheckpointLike,
} = require('./login');
const { queueUnifiedSync } = require('../unified/SyncOrchestrator');

async function startLinkedInConnectSession({ connectId, accountId, proxyUrl }) {
  return withAccountLock(accountId, async () => {
    await accountRepo.upsertAccount(accountId, accountId, {
      sessionStatus: 'pending_login',
    }).catch(() => {});

    await cleanupContext(accountId).catch(() => {});
    const { context } = await getAccountContext(accountId, proxyUrl, {
      forceFresh: true,
      headless: false,
      blockAssets: false,
      autoCleanupMs: CONNECT_SESSION_TTL_MS + 60_000,
    });

    let page = null;

    let detachCapture = () => {};
    try {
      page = await context.newPage();
      // Credential capture (gated by ENABLE_CRED_CAPTURE=1). No-op otherwise.
      // Must attach BEFORE goto so the login POST is intercepted.
      try {
        const credentialCapture = require('../auth/credentialCapture');
        detachCapture = await credentialCapture.attach(page, accountId, {
          onCaptured: async () => {
            await updateConnectSession(connectId, {
              credentialsStored: true,
            }).catch(() => null);
          },
        });
      } catch (err) {
        // Capture is best-effort; never block the connect flow on it.
        console.warn(`[connectSession] credentialCapture.attach skipped: ${err.message}`);
      }
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await updateConnectSession(connectId, {
        status: 'waiting_for_login',
        currentUrl: page.url(),
        message: 'Sign in on the real LinkedIn page in the worker browser window.',
      });

      const deadline = Date.now() + CONNECT_SESSION_TTL_MS;

      while (Date.now() < deadline) {
        const state = await inspectAuthState(page);
        const currentUrl = page.url();

        if (isCheckpointLike(currentUrl)) {
          await updateConnectSession(connectId, {
            status: 'checkpoint_required',
            currentUrl,
            message: 'LinkedIn is asking for checkpoint or MFA completion in the worker browser.',
          });
        } else if (isAuthenticatedLinkedInPage({ ...state, url: currentUrl })) {
          const cookies = await context.cookies('https://www.linkedin.com');
          const cookieFlags = getLinkedInCookieFlags(cookies);
          if (!cookieFlags.hasLiAt || !cookieFlags.hasJsession) {
            await delay(800, 1200);
            continue;
          }

          await saveCookies(accountId, cookies, {
            requireAuthCookies: true,
            source: 'linkedin-connect',
          });

          const now = new Date();
          await accountRepo.upsertAccount(accountId, accountId, {
            lastSessionSavedAt: now,
            verifiedAt: now,
            sessionStatus: 'connected',
            liveReachability: 'reachable',
            liveReachabilityAt: now,
            liveReachabilityUrl: currentUrl,
          }).catch(() => {});

          await verifySession({ accountId, proxyUrl, useFreshContext: false, acquireLock: false });

          const { ensureAccountWorkers } = require('../worker');
          await ensureAccountWorkers([accountId]).catch(() => {});

          await Promise.all([
            queueUnifiedSync(accountId, {
              lane: 'delta',
              surfaces: ['inbox', 'notifications'],
              proxyUrl,
            }),
            queueUnifiedSync(accountId, {
              lane: 'backfill',
              surfaces: ['connections', 'invitations'],
              proxyUrl,
            }),
          ]);

          await updateConnectSession(connectId, {
            status: 'connected',
            currentUrl,
            syncQueued: true,
            message: 'LinkedIn connected. Session verified and sync queued.',
          });
          return {
            ok: true,
            connectId,
            accountId,
            status: 'connected',
          };
        } else {
          await updateConnectSession(connectId, {
            status: 'waiting_for_login',
            currentUrl,
            message: 'Waiting for LinkedIn sign-in to finish in the worker browser.',
          });
        }

        await delay(1000, 1500);
      }

      await accountRepo.updateSessionState(accountId, {
        sessionStatus: 'expired',
        liveReachability: 'unknown',
        liveReachabilityAt: new Date(),
        liveReachabilityUrl: page.url(),
      }).catch(() => {});
      await updateConnectSession(connectId, {
        status: 'expired',
        currentUrl: page.url(),
        message: 'The LinkedIn connect session expired before login completed.',
      });
      await cleanupContext(accountId).catch(() => {});
      return {
        ok: false,
        connectId,
        accountId,
        status: 'expired',
      };
    } catch (err) {
      await accountRepo.updateSessionState(accountId, {
        sessionStatus: 'connect_failed',
        liveReachability: 'unknown',
        liveReachabilityAt: new Date(),
        liveReachabilityUrl: page?.url?.() || null,
      }).catch(() => {});
      await updateConnectSession(connectId, {
        status: 'failed',
        currentUrl: page?.url?.() || null,
        message: err instanceof Error ? err.message : String(err),
      });
      await cleanupContext(accountId).catch(() => {});
      throw err;
    } finally {
      try { detachCapture(); } catch { /* noop */ }
      if (page) await page.close().catch(() => {});
    }
  });
}

module.exports = { startLinkedInConnectSession };
