'use strict';

const CONNECTIONS_SCRAPER_VERSION = '2026-05-15-01';

function normalizeBrowserText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isAuthWall(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('/login') || value.includes('/checkpoint') || value.includes('/authwall') || value.includes('/challenge');
}

function canonicalizeLinkedInProfileUrl(href) {
  const raw = String(href || '').trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw, 'https://www.linkedin.com');
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith('linkedin.com')) return null;

    const pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    const match = pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match?.[1]) return null;

    const slug = decodeURIComponent(match[1]).trim();
    if (!slug) return null;

    return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
  } catch {
    return null;
  }
}

function checkpointVisible(sample) {
  const text = String(sample || '').toLowerCase();
  return text.includes('security verification')
    || text.includes('checkpoint')
    || text.includes('let us know that this is you')
    || text.includes('challenge');
}

function loginVisible(sample) {
  const text = String(sample || '').toLowerCase();
  return text.includes('sign in')
    || text.includes('forgot password')
    || text.includes('join linkedin')
    || text.includes('welcome back');
}

function buildBlockedPageError(accountId, diagnostics = {}) {
  const sample = String(diagnostics.textSample || '');
  const finalUrl = String(diagnostics.finalUrl || '').toLowerCase();
  const err = new Error(
    diagnostics.finalUrl
      ? `LinkedIn redirected the connections page for ${accountId} to ${diagnostics.finalUrl}.`
      : `LinkedIn blocked the connections page for ${accountId}.`
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

function buildAutomationWarningError(accountId, diagnostics = {}) {
  const err = new Error(`LinkedIn flagged automation or unusual activity for ${accountId}. Pause automation and reconnect manually.`);
  err.status = 401;
  err.code = 'AUTOMATION_WARNING';
  err.warningUrl = diagnostics.finalUrl || null;
  err.diagnostics = diagnostics;
  return err;
}

function normalizeConnectionCandidate(accountId, candidate = {}) {
  const profileUrl = canonicalizeLinkedInProfileUrl(candidate.profileUrl);
  const name = normalizeBrowserText(candidate.name || '');
  const headline = normalizeBrowserText(candidate.headline || '');
  const rowText = normalizeBrowserText(candidate.rowText || '');
  const accountToken = normalizeBrowserText(accountId).toLowerCase();
  const lowerText = rowText.toLowerCase();

  if (!profileUrl) {
    return { accepted: false, reason: 'missing_profile_url' };
  }

  if (!name) {
    return { accepted: false, reason: 'missing_name', profileUrl };
  }

  if (lowerText.includes('sponsored') || lowerText.includes('promoted')) {
    return { accepted: false, reason: 'sponsored_row', profileUrl, name };
  }

  if (lowerText.includes('page inbox') || lowerText.includes('messaging')) {
    return { accepted: false, reason: 'non_connection_module', profileUrl, name };
  }

  if (accountToken && name.toLowerCase() === accountToken) {
    return { accepted: false, reason: 'self_profile', profileUrl, name };
  }

  return {
    accepted: true,
    item: {
      id: profileUrl,
      profileUrl,
      name,
      headline: headline || null,
      avatarUrl: candidate.avatarUrl || null,
      connectedAt: candidate.connectedAt || new Date().toISOString(),
      status: 'connected',
      source: 'linkedin',
      raw: {
        rowText: rowText.slice(0, 300),
        extractionSource: candidate.source || 'unknown',
        rowIndex: candidate.rowIndex ?? null,
        selectors: candidate.selectors || null,
      },
    },
  };
}

module.exports = {
  CONNECTIONS_SCRAPER_VERSION,
  normalizeBrowserText,
  isAuthWall,
  canonicalizeLinkedInProfileUrl,
  checkpointVisible,
  loginVisible,
  buildBlockedPageError,
  buildAutomationWarningError,
  normalizeConnectionCandidate,
};
