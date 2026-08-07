import { timingSafeEqual } from 'crypto';
import argon2 from 'argon2';

const HASH_PREFIX = '$argon2';

/**
 * Hash a plaintext password with argon2id.
 * Use this once at setup or rotation time.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

/**
 * Verify a plaintext password against a stored argon2id hash.
 * Falls back to a constant-time plaintext compare for non-hashed values
 * so existing deployments keep working on first boot after upgrade.
 */
export async function verifyPassword(
  input: string,
  storedValue: string,
): Promise<boolean> {
  if (storedValue.startsWith(HASH_PREFIX)) {
    try {
      return await argon2.verify(storedValue, input);
    } catch {
      return false;
    }
  }

  const inputBuf = Buffer.from(input, 'utf8');
  const expectedBuf = Buffer.from(storedValue, 'utf8');
  const len = Math.max(inputBuf.length, expectedBuf.length);
  const paddedInput = Buffer.alloc(len);
  const paddedExpected = Buffer.alloc(len);
  inputBuf.copy(paddedInput);
  expectedBuf.copy(paddedExpected);
  const match = timingSafeEqual(paddedInput, paddedExpected);
  return match && inputBuf.length === expectedBuf.length;
}
