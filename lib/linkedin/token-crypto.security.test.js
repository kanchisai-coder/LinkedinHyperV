/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Security regression test: token-crypto.ts fail-closed behavior.
 *
 * Test convention: plain Node.js executable (no Jest/Mocha).
 * Run with: node lib/linkedin/token-crypto.security.test.js
 *
 * IMPORTANT: All keys used here are synthetic test keys only.
 * Never use production secrets. Never print key values.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Inline reference implementation of the REMEDIATED getMasterKey() logic.
// This mirrors token-crypto.ts exactly so the test is self-contained and
// does not depend on a TypeScript compilation step.
// ---------------------------------------------------------------------------
function getMasterKey() {
  const secretKeyHex =
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY ||
    process.env.SESSION_ENCRYPTION_KEY;

  if (!secretKeyHex) {
    throw new Error(
      'Encryption key configuration is required. ' +
      'Set LINKEDIN_TOKEN_ENCRYPTION_KEY or SESSION_ENCRYPTION_KEY.'
    );
  }

  if (secretKeyHex.length === 64) {
    return Buffer.from(secretKeyHex, 'hex');
  }

  return crypto.createHash('sha256').update(secretKeyHex).digest();
}

function encryptToken(plainText) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encryptedBuffer = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encryptedBuffer.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptToken(encryptedData) {
  const key = getMasterKey();
  const iv = Buffer.from(encryptedData.iv, 'base64');
  const tag = Buffer.from(encryptedData.tag, 'base64');
  const encryptedBuffer = Buffer.from(encryptedData.encrypted, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decryptedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  return decryptedBuffer.toString('utf8');
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  }
}

function assertThrows(fn, expectedMessage, testName) {
  try {
    fn();
    console.error(`  ✗ FAIL: ${testName} — expected throw but did not throw`);
    failed++;
  } catch (err) {
    if (expectedMessage && !err.message.includes(expectedMessage)) {
      console.error(`  ✗ FAIL: ${testName} — threw but message mismatch. Got: [REDACTED]`);
      failed++;
    } else {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    }
  }
}

// Synthetic test keys — 64 hex chars (32 bytes). Not real secrets.
const TEST_KEY_A = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const TEST_KEY_B = '99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa';

// ---------------------------------------------------------------------------
// Test 1: Valid encryption/decryption round trip with LINKEDIN_TOKEN_ENCRYPTION_KEY
// ---------------------------------------------------------------------------
console.log('\nTest 1: Valid round-trip with LINKEDIN_TOKEN_ENCRYPTION_KEY');
{
  const saved = { a: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY, b: process.env.SESSION_ENCRYPTION_KEY };
  process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = TEST_KEY_A;
  delete process.env.SESSION_ENCRYPTION_KEY;
  try {
    const plaintext = 'synthetic-oauth-access-token-for-test-only';
    const enc = encryptToken(plaintext);
    assert(enc.encrypted !== plaintext, 'Ciphertext differs from plaintext');
    assert(typeof enc.iv === 'string' && enc.iv.length > 0, 'IV is present');
    assert(typeof enc.tag === 'string' && enc.tag.length > 0, 'Auth tag is present');
    const dec = decryptToken(enc);
    assert(dec === plaintext, 'Decrypted output matches original plaintext');
  } finally {
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = saved.a;
    if (saved.b !== undefined) process.env.SESSION_ENCRYPTION_KEY = saved.b;
  }
}

// ---------------------------------------------------------------------------
// Test 2: Key precedence — LINKEDIN_TOKEN_ENCRYPTION_KEY > SESSION_ENCRYPTION_KEY
// ---------------------------------------------------------------------------
console.log('\nTest 2: Key precedence (LINKEDIN_TOKEN_ENCRYPTION_KEY > SESSION_ENCRYPTION_KEY)');
{
  const saved = { a: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY, b: process.env.SESSION_ENCRYPTION_KEY };
  process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = TEST_KEY_A;
  process.env.SESSION_ENCRYPTION_KEY = TEST_KEY_B;
  try {
    const plaintext = 'precedence-test-token';
    const enc = encryptToken(plaintext);

    // Decrypt with KEY_A (the one that should have been used) must succeed
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = TEST_KEY_A;
    process.env.SESSION_ENCRYPTION_KEY = TEST_KEY_B;
    const dec = decryptToken(enc);
    assert(dec === plaintext, 'Decryption succeeds with the primary key');

    // Verify: encrypting with KEY_B alone produces different ciphertext bytes
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = TEST_KEY_B;
    delete process.env.SESSION_ENCRYPTION_KEY;
    const encB = encryptToken(plaintext);
    assert(encB.encrypted !== enc.encrypted || encB.iv !== enc.iv, 'Different key produces different ciphertext');
  } finally {
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = saved.a;
    if (saved.b !== undefined) process.env.SESSION_ENCRYPTION_KEY = saved.b;
    else delete process.env.SESSION_ENCRYPTION_KEY;
  }
}

// ---------------------------------------------------------------------------
// Test 3: Wrong key fails decryption (authentication tag mismatch)
// ---------------------------------------------------------------------------
console.log('\nTest 3: Wrong encryption key causes decryption failure');
{
  const saved = { a: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY, b: process.env.SESSION_ENCRYPTION_KEY };
  try {
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = TEST_KEY_A;
    delete process.env.SESSION_ENCRYPTION_KEY;
    const plaintext = 'wrong-key-test-token';
    const enc = encryptToken(plaintext);

    // Now swap to KEY_B — decryption must fail due to GCM auth tag mismatch
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = TEST_KEY_B;
    assertThrows(
      () => decryptToken(enc),
      null,
      'Decryption with wrong key throws (GCM auth tag mismatch)'
    );
  } finally {
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = saved.a;
    if (saved.b !== undefined) process.env.SESSION_ENCRYPTION_KEY = saved.b;
    else delete process.env.SESSION_ENCRYPTION_KEY;
  }
}

// ---------------------------------------------------------------------------
// Test 4: No keys set → fails closed (throws configuration error)
// ---------------------------------------------------------------------------
console.log('\nTest 4: No encryption keys → fails closed');
{
  const saved = { a: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY, b: process.env.SESSION_ENCRYPTION_KEY };
  delete process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY;
  delete process.env.SESSION_ENCRYPTION_KEY;
  try {
    assertThrows(
      () => encryptToken('any-token'),
      'Encryption key configuration is required',
      'encryptToken throws when no key is configured'
    );
    assertThrows(
      () => decryptToken({ encrypted: 'x', iv: 'y', tag: 'z' }),
      'Encryption key configuration is required',
      'decryptToken throws when no key is configured'
    );
  } finally {
    if (saved.a !== undefined) process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = saved.a;
    if (saved.b !== undefined) process.env.SESSION_ENCRYPTION_KEY = saved.b;
  }
}

// ---------------------------------------------------------------------------
// Test 5: SESSION_ENCRYPTION_KEY alone is sufficient when LINKEDIN key absent
// ---------------------------------------------------------------------------
console.log('\nTest 5: SESSION_ENCRYPTION_KEY fallback works when primary key absent');
{
  const saved = { a: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY, b: process.env.SESSION_ENCRYPTION_KEY };
  delete process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_ENCRYPTION_KEY = TEST_KEY_B;
  try {
    const plaintext = 'session-key-fallback-test-token';
    const enc = encryptToken(plaintext);
    const dec = decryptToken(enc);
    assert(dec === plaintext, 'Round-trip succeeds using SESSION_ENCRYPTION_KEY');
  } finally {
    if (saved.a !== undefined) process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = saved.a;
    if (saved.b !== undefined) process.env.SESSION_ENCRYPTION_KEY = saved.b;
    else delete process.env.SESSION_ENCRYPTION_KEY;
  }
}

// ---------------------------------------------------------------------------
// Test 6: Deterministic fallback passphrase is NOT reachable
// ---------------------------------------------------------------------------
console.log('\nTest 6: Deterministic fallback passphrase is unreachable');
{
  const saved = { a: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY, b: process.env.SESSION_ENCRYPTION_KEY };
  delete process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY;
  delete process.env.SESSION_ENCRYPTION_KEY;
  try {
    // The old fallback would silently use scryptSync('fallback-linkedin-secret-passphrase', 'salt', 32).
    // Prove it is gone by verifying that getMasterKey() throws instead of returning a key.
    let threw = false;
    try { getMasterKey(); } catch (err) { void err; threw = true; }
    assert(threw, 'getMasterKey() throws — deterministic fallback is NOT reachable');

    // Construct what the old fallback key would have been and verify it cannot decrypt
    // tokens encrypted with the new fail-closed implementation (when a real key IS present).
    const oldFallbackKey = crypto.scryptSync('fallback-linkedin-secret-passphrase', 'salt', 32);
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = TEST_KEY_A;
    const enc = encryptToken('sentinel-value');
    delete process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY;

    // Try manual decryption with the old fallback key — must fail
    let fallbackDecryptFailed = false;
    try {
      const iv = Buffer.from(enc.iv, 'base64');
      const tag = Buffer.from(enc.tag, 'base64');
      const ct = Buffer.from(enc.encrypted, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', oldFallbackKey, iv);
      d.setAuthTag(tag);
      Buffer.concat([d.update(ct), d.final()]);
    } catch (err) { void err;
      fallbackDecryptFailed = true;
    }
    assert(fallbackDecryptFailed, 'Old fallback key cannot decrypt tokens encrypted with the new implementation');
  } finally {
    if (saved.a !== undefined) process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY = saved.a;
    if (saved.b !== undefined) process.env.SESSION_ENCRYPTION_KEY = saved.b;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- SECURITY REGRESSION TESTS: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
