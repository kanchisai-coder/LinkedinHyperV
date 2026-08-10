'use strict';

const { getAccountContext, withAccountLock } = require('../browser');
const { loadCookies, saveCookies } = require('../session');
const { delay, humanScroll }       = require('../humanBehavior');
const { checkAndIncrement }        = require('../rateLimit');

async function searchPeople({ accountId, query, proxyUrl, limit = 10 }) {
  return withAccountLock(accountId, async () => {
  await checkAndIncrement(accountId, 'searchQueries'); // FIRST

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

    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr) {
      const msg = navErr instanceof Error ? navErr.message : String(navErr);
      if (msg.includes('ERR_TOO_MANY_REDIRECTS')) {
        const err = new Error(`Session expired for account ${accountId}. Re-import cookies.`);
        err.code = 'SESSION_EXPIRED'; err.status = 401;
        throw err;
      }
      throw navErr;
    }

    const landingUrl = page.url();
    if (landingUrl.includes('/login') || landingUrl.includes('/checkpoint') || landingUrl.includes('/authwall')) {
      const err = new Error(`Session expired for account ${accountId}. Re-import cookies.`);
      err.code = 'SESSION_EXPIRED'; err.status = 401;
      throw err;
    }

    await delay(2000, 4000);

    await page.waitForSelector('.reusable-search__result-container, .search-results-container', {
      timeout: 12000,
    }).catch(() => null);

    await humanScroll(page, 400);
    await delay(800, 1500);

    const profiles = await page.evaluate((maxItems) => {
      const results = [];
      const cards   = document.querySelectorAll(
        '.reusable-search__result-container li, .entity-result'
      );

      for (const card of Array.from(cards).slice(0, maxItems)) {
        try {
          const nameEl     = card.querySelector('.entity-result__title-text a span[aria-hidden], .actor-name');
          const headlineEl = card.querySelector('.entity-result__primary-subtitle');
          const locationEl = card.querySelector('.entity-result__secondary-subtitle');
          const avatarEl   = card.querySelector('img.presence-entity__image, img.evi-image');
          const linkEl     = card.querySelector('a[href*="/in/"]');
          const href       = linkEl?.href || '';
          const profileId  = href.match(/\/in\/([^/?]+)/)?.[1] || `unknown-${Date.now()}`;

          if (!nameEl) continue; // skip cards without a name

          results.push({
            id:         profileId,
            name:       nameEl.textContent?.trim()      || 'Unknown',
            headline:   headlineEl?.textContent?.trim() || null,
            location:   locationEl?.textContent?.trim() || null,
            avatarUrl:  avatarEl?.src                   || null,
            profileUrl: href                            || null,
            company:    null,
          });
        } catch (_) { /* skip */ }
      }
      return results;
    }, limit);

    if (process.env.REFRESH_SESSION_COOKIES === '1') {
      await saveCookies(accountId, await context.cookies(), {
        skipIfMissingAuthCookies: true,
        source: 'searchPeople',
      });
    }

    return profiles; // returns array directly, not wrapped in { items }
  } finally {
    if (page) await page.close().catch(() => {});
  }
  });
}

module.exports = { searchPeople };
