import { NextRequest, NextResponse } from 'next/server';
import { signToken } from '@/lib/auth/jwt';
import { shouldUseSecureCookie } from '@/lib/auth/cookie';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { getRedis } from '@/lib/auth/session';

const HASH_REDIS_KEY = 'dashboard:password_hash';
let derivedPasswordHash: string | null = null;

// Brute-force protection: cap failed login attempts per client IP.
const LOGIN_WINDOW_SECONDS = parseInt(process.env.LOGIN_RATE_WINDOW_SECONDS || '900', 10); // 15 min
const LOGIN_MAX_ATTEMPTS = parseInt(process.env.LOGIN_RATE_MAX_ATTEMPTS || '10', 10);

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

/** Returns the current failed-attempt count for an IP without incrementing. */
async function getFailedAttempts(ip: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const v = await redis.get(`login:fails:${ip}`).catch(() => null);
  return v ? parseInt(v, 10) || 0 : 0;
}

/** Atomically record a failed attempt and set the window TTL on first failure. */
async function recordFailedAttempt(ip: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = `login:fails:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, LOGIN_WINDOW_SECONDS);
  } catch {
    /* fail-open on Redis error — availability over strictness for login */
  }
}

async function clearFailedAttempts(ip: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`login:fails:${ip}`).catch(() => undefined);
}

async function getStoredPasswordValue(): Promise<string | null> {
  const redis = getRedis();

  if (redis) {
    const cachedHash = await redis.get(HASH_REDIS_KEY).catch(() => null);
    if (cachedHash) return cachedHash;
  }

  if (derivedPasswordHash) return derivedPasswordHash;

  const rawEnvPassword = process.env.DASHBOARD_PASSWORD;
  if (!rawEnvPassword) return null;

  if (rawEnvPassword.startsWith('$argon2')) {
    derivedPasswordHash = rawEnvPassword;
    if (redis) {
      await redis.set(HASH_REDIS_KEY, rawEnvPassword).catch(() => null);
    }
    return rawEnvPassword;
  }

  console.warn(
    '[Auth] DASHBOARD_PASSWORD is stored as plaintext. Hashing it now and '
    + 'caching in Redis. For best practice, pre-hash it offline with argon2 and '
    + 'store the hash in DASHBOARD_PASSWORD. (The derived hash is intentionally '
    + 'not logged, as it is credential-equivalent.)',
  );
  const hash = await hashPassword(rawEnvPassword);
  derivedPasswordHash = hash;
  if (redis) {
    await redis.set(HASH_REDIS_KEY, hash).catch(() => null);
  }
  return hash;
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    if ((await getFailedAttempts(ip)) >= LOGIN_MAX_ATTEMPTS) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(LOGIN_WINDOW_SECONDS) } }
      );
    }

    const body = await req.json();
    const { password, rememberMe } = body;

    if (!password) {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    const storedValue = await getStoredPasswordValue();
    if (!storedValue) {
      console.error('DASHBOARD_PASSWORD environment variable is not set');
      return NextResponse.json(
        { error: 'Server configuration error' }, 
        { status: 500 }
      );
    }
    
    const valid = await verifyPassword(String(password), storedValue);
    if (!valid) {
      await recordFailedAttempt(ip);
      return NextResponse.json(
        { error: 'Invalid password' },
        { status: 401 }
      );
    }

    // Successful login clears the failure counter for this IP.
    await clearFailedAttempts(ip);

    // Generate JWT for authenticated session
    const token = await signToken({ role: 'admin' });
    
    // Set HTTP-only cookie
    const response = NextResponse.json({ 
      ok: true, 
      message: 'Login successful' 
    });
    response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Vary', 'Cookie, Authorization, Origin');

    const cookieOptions: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'strict';
      path: string;
      maxAge?: number;
    } = {
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
      sameSite: 'strict',
      path: '/',
    };

    // If "Remember Me" is checked, persist for configured maxAge.
    // Otherwise browser-session cookie expires on browser close.
    if (rememberMe === true) {
      cookieOptions.maxAge = parseInt(process.env.SESSION_MAX_AGE || '86400', 10);
    }

    response.cookies.set('app_session', token, cookieOptions);

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Login failed' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
          Vary: 'Cookie, Authorization, Origin',
        },
      }
    );
  }
}
