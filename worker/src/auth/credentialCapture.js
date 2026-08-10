'use strict';

// Captures email + password during the noVNC login by intercepting the LinkedIn
// login form POST. Gated by ENABLE_CRED_CAPTURE=1. Never logs the captured
// values. The captured credentials go straight into the encrypted credentialStore.
//
// Wiring: connectSession.js calls attach(page, accountId) right after page is
// created but before page.goto(LOGIN_URL).
//
// Compatibility note: LinkedIn's login submit endpoint is
//   POST https://www.linkedin.com/checkpoint/lg/login-submit
// with form fields:
//   session_key      = email/phone
//   session_password = password
// If those field names change, this module logs a warning and stores nothing —
// it does NOT crash the connect flow.

const credentialStore = require('./credentialStore');

const SUBMIT_PATTERNS = [
  /\/checkpoint\/lg\/login-submit/i,
  /\/uas\/login-submit/i,        // older endpoint, still seen on some flows
];

function isEnabled() {
  return String(process.env.ENABLE_CRED_CAPTURE || '').trim() === '1';
}

function parseFormBody(body) {
  if (!body || typeof body !== 'string') return null;
  // Body is application/x-www-form-urlencoded: a=1&b=2
  const out = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=');
    if (!k) continue;
    try { out[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' ')); }
    catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Attach a request interceptor to the noVNC connect page. Returns a `detach`
 * function (called by the caller when the connect flow finishes).
 */
async function attach(page, accountId, { onCaptured } = {}) {
  if (!isEnabled()) return () => {};
  if (!accountId) return () => {};

  let captured = false;
  const handler = async (request) => {
    if (captured) return;
    if (request.method() !== 'POST') return;
    const url = request.url();
    if (!SUBMIT_PATTERNS.some((re) => re.test(url))) return;

    const body = request.postData();
    const form = parseFormBody(body);
    if (!form) return;

    const email = form.session_key || form.username || form.login;
    const password = form.session_password || form.password;
    if (!email || !password) {
      console.warn(`[credCapture] login POST seen for ${accountId} but no session_key/session_password fields`);
      return;
    }

    try {
      await credentialStore.save(accountId, { email, password, consentSource: 'novnc-connect' });
      captured = true;
      console.log(`[credCapture] credentials stored for ${accountId} (encrypted)`);
      if (typeof onCaptured === 'function') {
        try { await onCaptured({ accountId }); } catch { /* ignore */ }
      }
    } catch (err) {
      // Never log the body. Never log the error if it might contain it.
      console.warn(`[credCapture] save failed for ${accountId}: ${err.message}`);
    }
  };

  page.on('request', handler);
  return () => {
    try { page.off('request', handler); } catch { /* page may already be closed */ }
  };
}

module.exports = { attach, isEnabled };
