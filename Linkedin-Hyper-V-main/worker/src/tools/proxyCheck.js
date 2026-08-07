'use strict';

// Proxy egress verifier — the test you run BEFORE trusting a proxy for an
// account. It launches a browser through the proxy and reports the egress IP
// LinkedIn would actually see, the geo, and whether linkedin.com loads without
// a redirect-to-login. This is how you confirm a residential/mobile proxy is
// real (not your datacenter IP) and not already burned.
//
// Usage (inside the worker container):
//   node src/tools/proxyCheck.js --proxy="socks5://user:pass@host:1080"
//   node src/tools/proxyCheck.js personl        # uses PROXY_FOR_PERSONL / PROXY_URL
//   node src/tools/proxyCheck.js --direct        # baseline: no proxy (shows the datacenter IP)
//
// Exit code 0 = proxy looks usable; 1 = problem (no proxy, burned IP, redirect).

const { chromium } = process.env.USE_REBROWSER_PLAYWRIGHT === '1'
  ? require('rebrowser-playwright')
  : require('playwright-core');
const { resolveProxyForAccount } = require('../antiBan');

const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

function parseArgs(argv) {
  const out = { accountId: null, proxy: null, direct: false };
  for (const a of argv) {
    if (a === '--direct') out.direct = true;
    else if (a.startsWith('--proxy=')) out.proxy = a.slice('--proxy='.length).replace(/^["']|["']$/g, '');
    else if (!a.startsWith('--')) out.accountId = a;
  }
  return out;
}

function resolveExecutable() {
  if (process.env.BROWSER_USE_SYSTEM_CHROME === '1') {
    const fs = require('fs');
    const p = '/usr/bin/google-chrome-stable';
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

// Navigate the page directly to a JSON endpoint and parse the body. We navigate
// (rather than fetch() from a fixed origin) so an http geo endpoint isn't blocked
// as mixed content from an https page.
async function getJsonByNavigation(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    return { ok: true, json: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let proxyUrl = args.proxy;
  if (!proxyUrl && !args.direct && args.accountId) {
    try { proxyUrl = resolveProxyForAccount(args.accountId); } catch { /* none */ }
  }

  const usingProxy = Boolean(proxyUrl) && !args.direct;
  console.log('=== Proxy egress check ===');
  console.log('account   :', args.accountId || '(none)');
  console.log('mode      :', args.direct ? 'DIRECT (no proxy)' : usingProxy ? 'PROXY' : 'NO PROXY CONFIGURED');
  if (usingProxy) {
    // Redact credentials in the printed URL.
    console.log('proxy     :', proxyUrl.replace(/\/\/[^@]*@/, '//***:***@'));
  }

  const launchOpts = { headless: true, args: CHROME_ARGS };
  const exe = resolveExecutable();
  if (exe) launchOpts.executablePath = exe;
  if (usingProxy) {
    // Split credentials into separate fields — Chromium ignores user:pass@ in
    // the proxy URL (would 407). SOCKS5 auth is unsupported by Chromium.
    try {
      const u = new URL(proxyUrl);
      const server = `${u.protocol}//${u.host}`;
      if (u.username) {
        launchOpts.proxy = { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') };
        if (/^socks/i.test(u.protocol)) console.log('WARNING: authenticated SOCKS5 is unsupported by Chromium — use http(s):// or IP-whitelisted SOCKS5.');
      } else {
        launchOpts.proxy = { server };
      }
    } catch {
      launchOpts.proxy = { server: proxyUrl };
    }
  }

  const browser = await chromium.launch(launchOpts);
  const verdict = { egressIp: null, geo: null, linkedinOk: false, problems: [] };
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    });
    ctx.setDefaultTimeout(25000);
    const page = await ctx.newPage();

    const ip = await getJsonByNavigation(page, 'https://api.ipify.org/?format=json');
    if (ip.ok && ip.json) verdict.egressIp = ip.json.ip;
    console.log('egress IP :', verdict.egressIp || `(failed: ${ip.error})`);

    // Geo + ASN — ip-api.com (free, HTTP) returns isp/org + the hosting & proxy
    // flags that tell residential/mobile apart from datacenter. Navigated
    // directly so the http endpoint isn't mixed-content-blocked.
    const geo = await getJsonByNavigation(page, 'http://ip-api.com/json/?fields=status,country,regionName,city,isp,org,as,proxy,hosting');
    if (geo.ok && geo.json) {
      const g = geo.json;
      verdict.geo = g;
      console.log('geo       :', `${g.city || '?'}, ${g.regionName || '?'}, ${g.country || '?'}`);
      console.log('ISP/org   :', g.isp || g.org || '?', g.as ? `(${g.as})` : '');
      console.log('hosting?  :', g.hosting ? 'YES — datacenter/hosting IP (LinkedIn will flag)' : 'no (looks residential/mobile)');
      if (g.hosting) verdict.problems.push('egress is a hosting/datacenter IP');
      if (g.proxy) verdict.problems.push('IP flagged as a known proxy/VPN');
    } else {
      console.log('geo       : (lookup failed:', geo.error + ')');
    }

    // Does LinkedIn load, or redirect to auth/login (burned/blocked signal)?
    const resp = await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => ({ _err: e.message }));
    const finalUrl = page.url();
    if (resp && resp._err) {
      console.log('linkedin  :', `navigation error: ${resp._err}`);
      verdict.problems.push('linkedin.com navigation failed: ' + resp._err);
    } else {
      const redirected = /\/authwall|\/login|\/checkpoint/.test(finalUrl);
      verdict.linkedinOk = !redirected;
      console.log('linkedin  :', finalUrl, redirected ? '→ REDIRECTED (authwall/login)' : '→ loaded OK');
      if (redirected) verdict.problems.push('linkedin.com redirected to ' + finalUrl);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('\n=== verdict ===');
  if (!usingProxy && !args.direct) {
    console.log('RESULT: NO PROXY configured for this account — egress is the host/datacenter IP. NOT usable for LinkedIn.');
    process.exit(1);
  }
  if (verdict.problems.length === 0) {
    console.log('RESULT: PASS — egress', verdict.egressIp, 'looks usable (no hosting flag, linkedin.com loaded).');
    process.exit(0);
  }
  console.log('RESULT: PROBLEM —');
  verdict.problems.forEach((p) => console.log('  -', p));
  process.exit(1);
}

main().catch((e) => { console.error('proxyCheck crashed:', e.message); process.exit(1); });
