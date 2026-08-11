import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard 96-bit IV for AES-GCM

/**
 * Resolves the AES-256-GCM master key from environment configuration.
 *
 * Key precedence:
 *   1. LINKEDIN_TOKEN_ENCRYPTION_KEY  (preferred — dedicated OAuth token key)
 *   2. SESSION_ENCRYPTION_KEY         (fallback — shared session key)
 *
 * Fail-closed: if neither variable is set, throws a configuration error.
 * No deterministic or hardcoded fallback exists in any environment.
 */
function getMasterKey(): Buffer {
  const secretKeyHex =
    process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY ||
    process.env.SESSION_ENCRYPTION_KEY;

  if (!secretKeyHex) {
    // SECURITY: Fail closed. No deterministic fallback is permitted.
    // Set LINKEDIN_TOKEN_ENCRYPTION_KEY or SESSION_ENCRYPTION_KEY (64 hex chars).
    throw new Error(
      'Encryption key configuration is required. ' +
      'Set LINKEDIN_TOKEN_ENCRYPTION_KEY or SESSION_ENCRYPTION_KEY.'
    );
  }

  if (secretKeyHex.length === 64) {
    return Buffer.from(secretKeyHex, 'hex');
  }

  // Derive 32-byte key using SHA-256 if key string is not 64 hex characters
  return crypto.createHash('sha256').update(secretKeyHex).digest();
}

export interface EncryptedData {
  encrypted: string; // Base64
  iv: string;        // Base64
  tag: string;       // Base64
}

/**
 * Encrypts a sensitive string (e.g. access token, refresh token) using AES-256-GCM.
 */
export function encryptToken(plainText: string): EncryptedData {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encryptedBuffer = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    encrypted: encryptedBuffer.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypts an AES-256-GCM encrypted token payload.
 */
export function decryptToken(encryptedData: EncryptedData): string {
  const key = getMasterKey();
  const iv = Buffer.from(encryptedData.iv, 'base64');
  const tag = Buffer.from(encryptedData.tag, 'base64');
  const encryptedBuffer = Buffer.from(encryptedData.encrypted, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decryptedBuffer = Buffer.concat([
    decipher.update(encryptedBuffer),
    decipher.final(),
  ]);

  return decryptedBuffer.toString('utf8');
}
