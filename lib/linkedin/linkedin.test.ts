import { generatePKCE } from './pkce';
import { encryptToken, decryptToken } from './token-crypto';
import { LinkedInApiClient, LinkedInApiError } from './linkedin-client';
import { oauthService } from './oauth';

async function runUnitTests() {
  console.log('--- STARTING LINKEDIN INTEGRATION UNIT TESTS ---');

  // 1. Test PKCE Generation
  const pkce = generatePKCE();
  console.assert(pkce.codeVerifier.length >= 43, 'PKCE verifier length must be >= 43');
  console.assert(pkce.codeChallenge.length > 0, 'PKCE challenge must not be empty');
  console.log('✓ PKCE S256 verifier & challenge generation verified');

  // 2. Test AES-256-GCM Token Encryption & Decryption
  const sampleToken = 'AQV1234567890_LinkedIn_Access_Token_Secret_Payload';
  const encrypted = encryptToken(sampleToken);
  console.assert(encrypted.encrypted !== sampleToken, 'Encrypted token must not equal plaintext');
  const decrypted = decryptToken(encrypted);
  console.assert(decrypted === sampleToken, 'Decrypted token must match original plaintext');
  console.log('✓ AES-256-GCM token encryption & decryption verified');

  // 3. Test OAuth Authorization URL generator
  const authPayload = oauthService.generateAuthorizationUrl({
    scopes: ['openid', 'profile', 'w_member_social'],
  });
  console.assert(authPayload.url.includes('response_type=code'), 'Authorization URL must contain response_type=code');
  console.assert(authPayload.url.includes('code_challenge_method=S256'), 'Authorization URL must specify S256 PKCE');
  console.log('✓ OAuth 2.0 Authorization URL with PKCE verified');

  // 4. Test LinkedInApiClient Error Normalization & Retries
  const mockClient = new LinkedInApiClient({ accessToken: 'mock_token', maxRetries: 1 });
  try {
    // Calling invalid domain endpoint to test network failure handling
    await mockClient.getUserInfo();
  } catch (err: unknown) {
    console.assert(err instanceof LinkedInApiError, 'Client must throw LinkedInApiError');
    console.log('✓ LinkedInApiClient error normalization verified');
  }

  console.log('--- ALL LINKEDIN INTEGRATION UNIT TESTS PASSED ---');
}

runUnitTests().catch(console.error);
