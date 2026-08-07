'use strict';

const { getAccountContext, withAccountLock } = require('../browser');
const { loadCookies, saveCookies } = require('../session');
const { delay, humanClick, humanType, humanScroll } = require('../humanBehavior');
const { checkAndIncrement, checkOnly } = require('../rateLimit');
const { getRedis } = require('../redisClient');

async function sendConnectionRequest({ accountId, profileUrl, note, proxyUrl }) {
  return withAccountLock(accountId, async () => {
  // Pre-gate: refuse before opening the browser if already at the cap, so an
  // over-limit request never reaches LinkedIn. Quota is committed after the
  // successful send-invitation click below (checkAndIncrement).
  await checkOnly(accountId, 'connectRequests');
  const { context, cookiesLoaded } = await getAccountContext(accountId, proxyUrl);
  let page;

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

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2500, 5000);

    await humanScroll(page, 150);
    await delay(800, 1500);

    // Extract name from scope hierarchy near the Connect button
    let participantName = 'Unknown';
    try {
      participantName = await page.evaluate(() => {
        const connectButton = document.querySelector('button[aria-label*="Connect"], button[aria-label*="connect"]');
        const nearestCard = connectButton?.closest('.pv-top-card, .ph5, .artdeco-card, main, section');
        const scopedName = nearestCard?.querySelector('h1, [data-anonymize="person-name"], .text-heading-xlarge');
        const fallbackName = document.querySelector('h1, [data-anonymize="person-name"], .text-heading-xlarge');
        const raw = scopedName?.textContent || fallbackName?.textContent || '';
        return raw.trim() || 'Unknown';
      });
    } catch (_) { }

    // Try direct Connect button first — if not present, use More Actions dropdown
    const connectBtn = await page.$('button[aria-label*="Connect"], button[aria-label*="connect"]');
    if (!connectBtn) {
      await humanClick(page, 'button[aria-label*="More actions"]', { timeout: 8000 });
      await delay(500, 1000);
      await humanClick(page, '[aria-label*="Connect"]', { timeout: 5000 });
    } else {
      await humanClick(page, 'button[aria-label*="Connect"]');
    }

    await delay(1000, 2000);

    if (note && note.trim().length > 0) {
      const addNoteBtn = await page.$('button[aria-label*="Add a note"]');
      if (addNoteBtn) {
        await humanClick(page, 'button[aria-label*="Add a note"]');
        await delay(500, 1000);
        // Two selectors for the note textarea
        await humanType(page, '#custom-message, textarea[name="message"]', note.slice(0, 300));
        await delay(600, 1200);
      }
    }

    await humanClick(page, 'button[aria-label*="Send invitation"], button[aria-label*="Send now"]');
    // W2 — Burn quota only after the click that actually sends the invitation.
    await checkAndIncrement(accountId, 'connectRequests');
    await delay(1500, 3000);

    if (process.env.REFRESH_SESSION_COOKIES === '1') {
      await saveCookies(accountId, await context.cookies(), {
        skipIfMissingAuthCookies: true,
        source: 'sendConnectionRequest',
      });
    }

    // Activity log — this is what populates the Connections page
    const redis = getRedis();
    const entry = JSON.stringify({
      type: 'connectionSent',
      accountId,
      targetName: participantName,
      targetProfileUrl: profileUrl,
      message: note || '',
      timestamp: Date.now(),
    });
    await redis.lpush(`activity:log:${accountId}`, entry);
    await redis.ltrim(`activity:log:${accountId}`, 0, 999);
    await redis.incr(`stats:connections:${accountId}`);

    return { success: true, profileUrl };
  } finally {
    if (page) await page.close().catch(() => { });
  }
  });
}

module.exports = { sendConnectionRequest };
