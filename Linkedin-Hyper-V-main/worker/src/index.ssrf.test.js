'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The guard is now shared (security/ssrfGuard) and re-exported by index.js.
// Test it directly to avoid booting the whole app for a pure-function test.
const { assertSafeWebhookTarget } = require('./security/ssrfGuard');

const blockedTargets = [
  'http://localhost/steal',
  'http://127.0.0.1/steal',
  'http://192.168.1.1/steal',
  'http://10.0.0.1/steal',
  'http://172.16.0.1/steal',
  'http://169.254.169.254/latest/meta-data',
  'http://0.0.0.0/steal',                       // 0.0.0.0/8
  'http://100.64.0.1/steal',                    // CGNAT
  'http://[::1]/steal',                         // IPv6 loopback literal
  'http://[::ffff:169.254.169.254]/meta',       // IPv4-mapped IPv6 → link-local
  'http://[::ffff:127.0.0.1]/steal',            // IPv4-mapped IPv6 → loopback
];

for (const url of blockedTargets) {
  test(`assertSafeWebhookTarget blocks ${url}`, async () => {
    await assert.rejects(() => assertSafeWebhookTarget(url));
  });
}

test('assertSafeWebhookTarget blocks non-http protocols', async () => {
  await assert.rejects(() => assertSafeWebhookTarget('ftp://example.com'));
});

test('assertSafeWebhookTarget blocks bare hostnames', async () => {
  await assert.rejects(() => assertSafeWebhookTarget('http://redis/flush'));
});

test('assertSafeWebhookTarget allows a public IP literal', async () => {
  // 8.8.8.8 is a public literal (no DNS needed) — must pass.
  await assert.doesNotReject(() => assertSafeWebhookTarget('https://8.8.8.8/hook'));
});
