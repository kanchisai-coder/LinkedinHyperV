'use strict';

// Shared SSRF guard for outbound webhook delivery.
//
// Used both at subscription-creation time (reject obviously-unsafe targets) and
// at every delivery attempt (re-resolve to defeat DNS-rebinding/TOCTOU). Callers
// that actually perform the request must ALSO use redirect: 'manual', because a
// validated public URL can still 3xx to a private address.

const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivateIpv4(address) {
  if (!address || net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map((part) => Number(part));
  return a === 0                                   // 0.0.0.0/8 ("this host"; routes to localhost)
    || a === 10                                    // 10.0.0.0/8 private
    || a === 127                                   // 127.0.0.0/8 loopback
    || (a === 100 && b >= 64 && b <= 127)          // 100.64.0.0/10 CGNAT
    || (a === 169 && b === 254)                    // 169.254.0.0/16 link-local (cloud metadata)
    || (a === 172 && b >= 16 && b <= 31)           // 172.16.0.0/12 private
    || (a === 192 && b === 168);                   // 192.168.0.0/16 private
}

function isPrivateIpv6(address) {
  if (!address || net.isIP(address) !== 6) return false;
  const normalized = String(address).toLowerCase();

  // IPv4-mapped (::ffff:a.b.c.d, canonicalized to ::ffff:xxxx:yyyy) and the
  // deprecated IPv4-compatible (::a.b.c.d) forms are treated as unsafe outright:
  // many stacks route them to the embedded IPv4, and no legitimate public
  // webhook target is ever expressed as such a literal.
  if (normalized.startsWith('::ffff:')) return true;
  if (/^::(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized)) return true;

  return normalized === '::1'                       // loopback
    || normalized === '::'                          // unspecified
    || normalized.startsWith('fc')                  // fc00::/7 unique-local
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:');              // link-local
}

function isPrivateAddress(address) {
  return isPrivateIpv4(address) || isPrivateIpv6(address);
}

// Strip the brackets WHATWG URL keeps around IPv6 literals (e.g. "[::1]").
function stripBrackets(hostname) {
  const h = String(hostname || '').trim();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function isBlockedWebhookHostname(hostname) {
  const normalized = stripBrackets(hostname).toLowerCase();
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  // An IP literal is allowed through here (validated separately); a bare
  // hostname with no dot is not a routable public host.
  if (net.isIP(normalized)) return false;
  return !normalized.includes('.');
}

function ssrfError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'WEBHOOK_TARGET_UNSAFE';
  return err;
}

async function assertSafeWebhookTarget(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw ssrfError('targetUrl must be a valid absolute HTTP(S) URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ssrfError('targetUrl must be an absolute HTTP(S) URL');
  }

  const hostname = stripBrackets(parsed.hostname);
  if (isBlockedWebhookHostname(hostname)) {
    throw ssrfError('targetUrl resolves to a private or internal host');
  }

  // Direct IP literal (v4 or v6, incl. mapped) — validate without DNS.
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw ssrfError('targetUrl resolves to a private or internal address');
    }
    return;
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (resolved.length === 0) {
    throw ssrfError('targetUrl hostname could not be resolved');
  }
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw ssrfError('targetUrl resolves to a private or internal address');
  }
}

module.exports = {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateAddress,
  isBlockedWebhookHostname,
  assertSafeWebhookTarget,
};
