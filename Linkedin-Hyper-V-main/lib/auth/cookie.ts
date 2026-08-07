import { NextRequest } from 'next/server';

function parseBoolean(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return null;
}

/**
 * Determine if auth cookies should be set as secure.
 * - Honors COOKIE_SECURE=true/false when explicitly set.
 * - Auto-detects HTTPS via URL protocol or reverse-proxy headers.
 */
export function shouldUseSecureCookie(req: NextRequest): boolean {
  const explicit = parseBoolean(process.env.COOKIE_SECURE);
  if (explicit !== null) return explicit;

  const forwardedProto = req.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    .trim()
    .toLowerCase();

  const requestProto = req.nextUrl.protocol.replace(':', '').toLowerCase();
  return forwardedProto === 'https' || requestProto === 'https';
}

