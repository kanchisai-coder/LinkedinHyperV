/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Security unit and regression tests for authentication and proxy helpers.
 * Tests:
 * 1. extractClientIp() - trusted proxy validation and anti-spoofing
 * 2. shouldUseSecureCookie() - secure cookie auto-detection and proxy awareness
 * 3. CSP headers in next.config.ts - policy string validation
 */

const assert = require('assert');

// Mock helper to build NextRequest-like objects for testing
function createMockRequest({
  headers = {},
  protocol = 'http:',
  pathname = '/api/auth/login',
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }

  return {
    headers: {
      get(name) {
        return headerMap.get(name.toLowerCase()) || null;
      },
    },
    nextUrl: {
      protocol: protocol.endsWith(':') ? protocol : `${protocol}:`,
      pathname,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. extractClientIp Tests (F6 Trusted Proxy & Anti-Spoofing)
// ---------------------------------------------------------------------------
console.log('=== Test Suite 1: extractClientIp() (F6 Anti-Spoofing) ===');

// Replicate extractClientIp logic for testing in CJS environment
function extractClientIp(req, trustedProxyOverride) {
  const realIp = req.headers.get('x-real-ip')?.trim() || '';
  const configured = (trustedProxyOverride !== undefined ? trustedProxyOverride : (process.env.TRUSTED_PROXY_IP || '')).trim();

  if (configured && realIp) {
    const trustedList = configured.split(',').map((s) => s.trim()).filter(Boolean);
    if (trustedList.includes(realIp)) {
      const fwd = req.headers.get('x-forwarded-for');
      if (fwd) {
        const firstIp = fwd.split(',')[0].trim();
        if (firstIp) return firstIp;
      }
    }
  }

  return realIp || 'unknown';
}

// Case A: Trusted proxy + valid XFF -> returns client IP
{
  const req = createMockRequest({
    headers: {
      'x-real-ip': '127.0.0.1',
      'x-forwarded-for': '203.0.113.195',
    },
  });
  const ip = extractClientIp(req, '127.0.0.1');
  assert.strictEqual(ip, '203.0.113.195', 'Case A: Should return client IP from XFF when from trusted proxy');
  console.log('  ✓ Case A PASS: Trusted proxy + valid XFF extracts client IP');
}

// Case B: Untrusted peer + spoofed XFF -> returns direct socket IP, ignores XFF
{
  const req = createMockRequest({
    headers: {
      'x-real-ip': '198.51.100.23',
      'x-forwarded-for': '10.0.0.1',
    },
  });
  const ip = extractClientIp(req, '127.0.0.1');
  assert.strictEqual(ip, '198.51.100.23', 'Case B: Should ignore spoofed XFF and return actual peer IP');
  console.log('  ✓ Case B PASS: Untrusted peer with forged XFF returns peer IP (spoofing prevented)');
}

// Case C: Direct request with no XFF -> returns socket IP
{
  const req = createMockRequest({
    headers: {
      'x-real-ip': '198.51.100.23',
    },
  });
  const ip = extractClientIp(req, '127.0.0.1');
  assert.strictEqual(ip, '198.51.100.23', 'Case C: Direct request returns socket IP');
  console.log('  ✓ Case C PASS: Direct request with no XFF returns socket IP');
}

// Case D: Missing/empty TRUSTED_PROXY_IP -> fail-secure, does not trust XFF
{
  const req = createMockRequest({
    headers: {
      'x-real-ip': '198.51.100.23',
      'x-forwarded-for': '1.2.3.4',
    },
  });
  const ip = extractClientIp(req, '');
  assert.strictEqual(ip, '198.51.100.23', 'Case D: Missing TRUSTED_PROXY_IP must NOT blindly trust XFF');
  console.log('  ✓ Case D PASS: Unset TRUSTED_PROXY_IP ignores XFF (no blind fallback)');
}

// Case E: Multiple XFF values -> returns first IP in chain
{
  const req = createMockRequest({
    headers: {
      'x-real-ip': '127.0.0.1',
      'x-forwarded-for': '203.0.113.195, 10.0.0.1, 172.16.0.1',
    },
  });
  const ip = extractClientIp(req, '127.0.0.1');
  assert.strictEqual(ip, '203.0.113.195', 'Case E: Multiple XFF values returns first IP in chain');
  console.log('  ✓ Case E PASS: Multiple XFF values correctly extracts first (client) IP');
}

// Case F: Comma-separated trusted proxies list
{
  const req = createMockRequest({
    headers: {
      'x-real-ip': '10.0.0.2',
      'x-forwarded-for': '192.0.2.1',
    },
  });
  const ip = extractClientIp(req, '127.0.0.1, 10.0.0.2, 10.0.0.3');
  assert.strictEqual(ip, '192.0.2.1', 'Case F: Comma-separated trusted proxy list');
  console.log('  ✓ Case F PASS: Comma-separated trusted proxies list recognized');
}

// ---------------------------------------------------------------------------
// 2. shouldUseSecureCookie Tests (F4 Cookie Security)
// ---------------------------------------------------------------------------
console.log('\n=== Test Suite 2: shouldUseSecureCookie() (F4 Cookie Security) ===');

function parseBoolean(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return null;
}

function shouldUseSecureCookie(req) {
  const explicit = parseBoolean(process.env.COOKIE_SECURE);
  if (explicit !== null) return explicit;

  const forwardedProto = req.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    .trim()
    .toLowerCase();

  const requestProto = req.nextUrl.protocol.replace(':', '').toLowerCase();
  return forwardedProto === 'https' || requestProto === 'https';
}

// Case 1: X-Forwarded-Proto: https -> true
{
  delete process.env.COOKIE_SECURE;
  const req = createMockRequest({
    headers: { 'x-forwarded-proto': 'https' },
    protocol: 'http:',
  });
  assert.strictEqual(shouldUseSecureCookie(req), true);
  console.log('  ✓ PASS: X-Forwarded-Proto: https sets secure=true');
}

// Case 2: Plain HTTP -> false
{
  delete process.env.COOKIE_SECURE;
  const req = createMockRequest({
    headers: {},
    protocol: 'http:',
  });
  assert.strictEqual(shouldUseSecureCookie(req), false);
  console.log('  ✓ PASS: Plain HTTP development sets secure=false');
}

// Case 3: Explicit COOKIE_SECURE=1 override
{
  process.env.COOKIE_SECURE = '1';
  const req = createMockRequest({
    headers: {},
    protocol: 'http:',
  });
  assert.strictEqual(shouldUseSecureCookie(req), true);
  delete process.env.COOKIE_SECURE;
  console.log('  ✓ PASS: COOKIE_SECURE=1 forces secure=true');
}

// Case 4: Explicit COOKIE_SECURE=0 override
{
  process.env.COOKIE_SECURE = '0';
  const req = createMockRequest({
    headers: { 'x-forwarded-proto': 'https' },
    protocol: 'https:',
  });
  assert.strictEqual(shouldUseSecureCookie(req), false);
  delete process.env.COOKIE_SECURE;
  console.log('  ✓ PASS: COOKIE_SECURE=0 forces secure=false');
}

// ---------------------------------------------------------------------------
// 3. CSP Policy Verification (F5 Content Security Policy)
// ---------------------------------------------------------------------------
console.log('\n=== Test Suite 3: CSP Policy Structure (F5) ===');

const fs = require('fs');
const path = require('path');
const nextConfigContent = fs.readFileSync(path.join(__dirname, '../../next.config.ts'), 'utf8');

assert(nextConfigContent.includes("key: 'Content-Security-Policy'"), 'CSP header must be defined');
console.log('  ✓ PASS: Content-Security-Policy header defined in next.config.ts');

assert(nextConfigContent.includes("connect-src 'self' wss:"), 'connect-src must restrict to self and wss:');
console.log('  ✓ PASS: connect-src restricted to self and wss: (no arbitrary ws:)');

assert(!nextConfigContent.includes("connect-src 'self' ws: wss:"), 'connect-src must NOT contain broad ws:');
console.log('  ✓ PASS: connect-src does NOT contain unencrypted wildcard ws:');

assert(nextConfigContent.includes("frame-ancestors 'self'"), 'frame-ancestors must be set to self');
console.log('  ✓ PASS: frame-ancestors set to self (clickjacking protection)');

console.log('\n--- ALL AUTH AND SECURITY TESTS PASSED (14/14) ---');
