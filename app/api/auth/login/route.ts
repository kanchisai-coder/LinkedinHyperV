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

// SECURITY (F6): Trusted-proxy-aware IP extraction.
// X-Forwarded-For is trusted ONLY when the immediate peer IP (via X-Real-IP) matches
// an explicitly configured trusted proxy. If TRUSTED_PROXY_IP is unset or empty,
// or if the request arrives from an untrusted peer, X-Forwarded-For is IGNORED
// and the direct connection address (X-Real-IP) is used to prevent header spoofing.
export function extractClientIp(req: NextRequest, trustedProxyOverride?: string): string {
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

  // Strict fail-secure: if not arriving from a verified trusted proxy,
  // ignore X-Forwarded-For entirely and use the direct socket IP.
  return realIp || 'unknown';
}

function clientIp(req: NextRequest): string {
  return extractClientIp(req);
}

// OBSERVABILITY (F7+F8): emit a structured warning once per process when Redis
// is unavailable so that log aggregation can alert operators to degraded
// brute-force protection.  We do NOT expose keys or secret values.
let _rateLimitRedisWarnEmitted = false;
function warnRateLimitDegraded(): void {
  if (_rateLimitRedisWarnEmitted) return;
  _rateLimitRedisWarnEmitted = true;
  console.warn(
    '[auth/login] SECURITY DEGRADED: Redis unavailable — login rate-limiting '
    + 'has fallen back to fail-open (no distributed counter). '
    + 'Brute-force protection is local to this process only. '
    + 'Restore Redis connectivity to re-enable global rate limiting.',
  );
}

/** Returns the current failed-attempt count for an IP without incrementing. */
async function getFailedAttempts(ip: string): Promise<number> {
  const redis = getRedis();
  if (!redis) { warnRateLimitDegraded(); return 0; }
  const v = await redis.get(`login:fails:${ip}`).catch(() => null);
  return v ? parseInt(v, 10) || 0 : 0;
}

/** Atomically record a failed attempt and set the window TTL on first failure. */
async function recordFailedAttempt(ip: string): Promise<void> {
  const redis = getRedis();
  if (!redis) { warnRateLimitDegraded(); return; }
  const key = `login:fails:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, LOGIN_WINDOW_SECONDS);
  } catch {
    warnRateLimitDegraded();
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
