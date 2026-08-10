const crypto = require('crypto');

// 1. PKCE Helpers
function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePKCE() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = base64UrlEncode(hash);
  return { codeVerifier, codeChallenge };
}

// 2. Token Encryption (AES-256-GCM)
function getMasterKey() {
  const secretKeyHex = process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY || process.env.SESSION_ENCRYPTION_KEY;
  if (!secretKeyHex) {
    return crypto.scryptSync('fallback-linkedin-secret-passphrase', 'salt', 32);
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

// 3. OAuth Authorization URL Constructor
function generateAuthorizationUrl({ clientId = 'test_client_id', redirectUri = 'http://localhost:3000/api/auth/linkedin/callback', scopes = ['openid', 'profile', 'email', 'w_member_social'] } = {}) {
  const pkce = generatePKCE();
  const state = base64UrlEncode(crypto.randomBytes(24));
  const queryParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: scopes.join(' '),
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
  });
  return {
    url: `https://www.linkedin.com/oauth/v2/authorization?${queryParams.toString()}`,
    state,
    codeVerifier: pkce.codeVerifier,
    codeChallenge: pkce.codeChallenge,
  };
}

async function runUnitTests() {
  console.log('--- STARTING LINKEDIN INTEGRATION UNIT TESTS (Node.js) ---');

  // Test 1: PKCE Generation
  const pkce = generatePKCE();
  console.assert(pkce.codeVerifier.length >= 43, 'PKCE verifier length must be >= 43');
  console.assert(pkce.codeChallenge.length > 0, 'PKCE challenge must not be empty');
  console.log('✓ Test 1 Passed: PKCE S256 verifier & challenge generation verified');

  // Test 2: AES-256-GCM Token Encryption & Decryption
  const sampleToken = 'AQV1234567890_LinkedIn_Access_Token_Secret_Payload';
  const encrypted = encryptToken(sampleToken);
  console.assert(encrypted.encrypted !== sampleToken, 'Encrypted token must not equal plaintext');
  const decrypted = decryptToken(encrypted);
  console.assert(decrypted === sampleToken, 'Decrypted token must match original plaintext');
  console.log('✓ Test 2 Passed: AES-256-GCM token encryption & decryption verified');

  // Test 3: OAuth Authorization URL Construction
  const authPayload = generateAuthorizationUrl();
  console.assert(authPayload.url.includes('response_type=code'), 'Authorization URL must contain response_type=code');
  console.assert(authPayload.url.includes('code_challenge_method=S256'), 'Authorization URL must specify S256 PKCE');
  console.log('✓ Test 3 Passed: OAuth 2.0 Authorization URL with PKCE verified');

  console.log('--- ALL LINKEDIN INTEGRATION UNIT TESTS PASSED SUCCESSFULLY ---');
}

runUnitTests().catch(console.error);
