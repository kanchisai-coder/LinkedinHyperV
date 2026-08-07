import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth/jwt';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const API_SECRET = process.env.API_SECRET ?? '';

/** Constant-time string comparison that never short-circuits on length. */
function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function applyPrivateNoStore(headers: Headers): void {
  headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Vary', 'Cookie, Authorization, Origin');
}

function buildAllowedOrigins(req: NextRequest): Set<string> {
  const origins = new Set<string>();

  // Next.js computed origin (works in most local deployments).
  origins.add(req.nextUrl.origin);

  // Forwarded headers are required when app is accessed via public IP/domain/reverse proxy.
  const host =
    req.headers.get('x-forwarded-host') ??
    req.headers.get('host') ??
    '';
  const protoHeader =
    req.headers.get('x-forwarded-proto') ??
    req.nextUrl.protocol.replace(':', '');
  const proto = protoHeader || 'http';

  if (host) {
    origins.add(`${proto}://${host}`);
  }

  return origins;
}

/**
 * Authenticate incoming requests to the BFF.
 *
 * Authorization requires ONE of:
 *   1. A service bearer token that matches API_ROUTE_AUTH_TOKEN exactly, OR
 *   2. A valid, signed `app_session` JWT (verified, not merely present).
 *
 * A bare/unknown `Authorization` header and a present-but-invalid session
 * cookie are both rejected. Cookie-authenticated (browser) requests are also
 * subject to Origin / Sec-Fetch-Site checks as CSRF defense-in-depth.
 */
export async function authenticateCaller(req: NextRequest): Promise<NextResponse | null> {
  const authHeader = req.headers.get('authorization');
  const expectedToken = process.env.API_ROUTE_AUTH_TOKEN?.trim();

  // 1. Service-to-service: a bearer token that matches the configured secret is
  //    fully authorized (used for non-browser callers). Compared in constant time.
  if (expectedToken && authHeader && timingSafeStrEqual(authHeader, `Bearer ${expectedToken}`)) {
    return null;
  }

  // 2. Browser/dashboard: require a cryptographically valid session JWT.
  //    Presence of the cookie is NOT enough — it must verify and be authenticated.
  const sessionCookie = req.cookies.get('app_session')?.value;
  const session = sessionCookie ? await verifyToken(sessionCookie) : null;
  if (!session?.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 3. CSRF defense-in-depth for cookie-authenticated requests: validate Origin
  //    and Sec-Fetch-Site (in addition to the cookie's SameSite=strict).
  const origin = req.headers.get('origin');
  if (origin) {
    const allowedOrigins = buildAllowedOrigins(req);
    const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    const isTrusted = allowedOrigins.has(origin) || trustedOrigins.includes(origin);
    if (!isTrusted) {
      return NextResponse.json({ error: 'Forbidden: Invalid Origin' }, { status: 403 });
    }
  }

  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) {
    return NextResponse.json({ error: 'Forbidden: Invalid Sec-Fetch-Site' }, { status: 403 });
  }

  return null;
}

interface ForwardOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  timeoutMs?: number;
}

function shortBodyPreview(value: string, limit = 500): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Forward a request to the worker Express API.
 * Adds X-Api-Key header automatically.
 * Includes a default 120-second AbortSignal timeout (override via timeoutMs).
 */
export async function forwardToBackend(opts: ForwardOptions): Promise<NextResponse> {
  const { method, path, query, body, timeoutMs } = opts;
  const qs = query ? `?${query.toString()}` : '';
  const url = `${API_URL}${path}${qs}`;
  const parsedTimeoutMs = typeof timeoutMs === 'number' ? timeoutMs : NaN;
  const effectiveTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
    ? parsedTimeoutMs
    : 120_000;
  const requestId = crypto.randomUUID();

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_SECRET,
        'X-Request-Id': requestId,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    });

    const data = await res.text();
    const isNoContentStatus = res.status === 204 || res.status === 205 || res.status === 304;

    const headers = new Headers();
    // Dashboard state is user-specific and should never be cached publicly.
    applyPrivateNoStore(headers);
    headers.set('X-Request-Id', res.headers.get('x-request-id') || requestId);

    const upstreamType = res.headers.get('content-type');
    if (!res.ok) {
      console.error(`[BFF] Upstream ${method} ${path} failed`, {
        requestId,
        status: res.status,
        contentType: upstreamType,
        body: shortBodyPreview(data),
      });
    }
    if (!isNoContentStatus) {
      headers.set('Content-Type', upstreamType ?? 'application/json');
      return new NextResponse(data, { status: res.status, headers });
    }

    // 204/205/304 must not include a response body.
    return new NextResponse(null, { status: res.status, headers });
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    console.error(`[BFF] Upstream ${method} ${path} unreachable`, {
      requestId,
      timeoutMs: effectiveTimeoutMs,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: isTimeout ? 'Backend request timed out' : 'Backend unreachable',
        requestId,
      },
      {
        status: 502,
        headers: { 'X-Request-Id': requestId },
      }
    );
  }
}

/** Validate and return a required string param; throws on failure. */
export function requireString(value: string | null, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required field: ${name}`);
  }
  return value.trim();
}

interface IntegerOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

/** Parse an optional integer param with min/max bounds and an optional fallback. */
export function requireInteger(
  value: string | null,
  name: string,
  opts: IntegerOptions = {}
): number {
  const { min, max, fallback } = opts;

  if (value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required integer: ${name}`);
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: "${value}"`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return parsed;
}

/** Return a 400 JSON response from a caught Error or unknown. */
export function badRequest(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : 'Bad request';
  const res = NextResponse.json({ error: message }, { status: 400 });
  res.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.headers.set('Pragma', 'no-cache');
  res.headers.set('Vary', 'Cookie, Authorization, Origin');
  return res;
}
