// FILE: lib/auth/jwt.ts
import { SignJWT, jwtVerify } from 'jose';

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return new TextEncoder().encode(secret);
}
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE || '86400', 10);

export interface JWTPayload {
  authenticated: boolean;
  userId?: string;
  role?: string;
  iat: number;
  exp: number;
  jti?: string; // JWT ID for blacklist tracking
}

/**
 * Sign a JWT token with session data
 */
export async function signToken(payload: Partial<JWTPayload> = {}): Promise<string> {
  const jti = crypto.randomUUID(); // Unique token ID for revocation
  
  return await new SignJWT({ 
    authenticated: true,
    jti,
    ...payload
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecret());
}

/**
 * Verify and decode a JWT token
 */
export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    // Pin the algorithm to prevent algorithm-confusion attacks.
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}
