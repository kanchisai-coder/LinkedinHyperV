'use strict';

// Shared helpers for the Voyager API + realtime layer.
// Derives the auth material (cookies, csrf token) and provides a browser
// context that already has the account's cookies loaded — so every Voyager
// request and the realtime stream egress through the SAME proxy + cookie jar +
// fingerprint as the account's interactive login (critical for anti-ban).

const { getAccountContext } = require('../browser');
const { loadCookies } = require('../session');
const { resolveProxyForAccount } = require('../antiBan');

/**
 * Get (or reuse) a browser context for an account with its cookies loaded.
 * Returns { browser, context, csrfToken, hasSession }.
 */
async function getAuthedContext(accountId, options = {}) {
  let proxyUrl = null;
  try {
    proxyUrl = resolveProxyForAccount(accountId);
  } catch (err) {
    if (err.code === 'PROXY_REQUIRED') throw err;
  }

  const { browser, context, cookiesLoaded } = await getAccountContext(
    accountId,
    proxyUrl,
    { headless: options.headless, blockAssets: options.blockAssets !== false }
  );

  // Inject stored cookies if the context is fresh.
  if (!cookiesLoaded) {
    const cookies = await loadCookies(accountId);
    if (cookies && cookies.length) {
      await context.addCookies(cookies).catch(() => {});
    }
  }

  const csrfToken = await deriveCsrfToken(context);
  return {
    browser,
    context,
    csrfToken,
    hasSession: Boolean(csrfToken),
  };
}

/**
 * The Voyager CSRF token is the JSESSIONID cookie value with surrounding
 * quotes stripped. Returns null if not logged in.
 */
async function deriveCsrfToken(context) {
  const cookies = await context.cookies('https://www.linkedin.com').catch(() => []);
  const jsession = cookies.find((c) => c.name === 'JSESSIONID');
  if (!jsession || !jsession.value) return null;
  return jsession.value.replace(/^"+|"+$/g, '');
}

/**
 * Standard Voyager request headers. user-agent + cookies are supplied
 * automatically by the browser context's request API.
 */
// DST-aware "hours from UTC, west-negative" for an IANA zone (e.g. GMT-4 -> -4),
// matching LinkedIn's x-li-track timezoneOffset convention. Uses Intl (not
// Date.getTimezoneOffset, whose sign/minutes are inverted for this purpose).
function offsetHoursForZone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date());
    const label = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
    const m = label.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    const hours = parseInt(m[2], 10) + (m[3] ? parseInt(m[3], 10) / 60 : 0);
    return sign * hours;
  } catch {
    return -5; // America/New_York (EST) fallback
  }
}

function voyagerHeaders(csrfToken, extra = {}, { timezone } = {}) {
  // Use the account's fingerprint timezone so the REST header matches the
  // in-page Playwright timezone (a mismatch is a flaggable fingerprint). The
  // offset is computed DST-aware from that zone.
  const zone = timezone || 'America/New_York';
  return {
    'csrf-token': csrfToken,
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-track': JSON.stringify({
      clientVersion: '1.13.0',
      mpVersion: '1.13.0',
      osName: 'web',
      timezoneOffset: offsetHoursForZone(zone),
      timezone: zone,
      deviceFormFactor: 'DESKTOP',
      mpName: 'voyager-web',
    }),
    ...extra,
  };
}

module.exports = { getAuthedContext, deriveCsrfToken, voyagerHeaders, offsetHoursForZone };
