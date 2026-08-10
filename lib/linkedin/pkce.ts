import crypto from 'crypto';

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generates a high-entropy cryptographically random PKCE code verifier and S256 code challenge.
 * Conforms to RFC 7636 and LinkedIn OAuth 2.0 PKCE standards.
 */
export function generatePKCE(): PKCEPair {
  // Generate random 32 bytes -> base64url string (43 characters long)
  const buffer = crypto.randomBytes(32);
  const codeVerifier = base64UrlEncode(buffer);

  // Compute SHA-256 hash of the code verifier
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = base64UrlEncode(hash);

  return {
    codeVerifier,
    codeChallenge,
  };
}

/**
 * Base64URL encoding according to RFC 4648 § 5.
 */
export function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a high-entropy CSRF state token.
 */
export function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(24));
}
