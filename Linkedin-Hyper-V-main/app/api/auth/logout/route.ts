// FILE: app/api/auth/logout/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSession, blacklistToken } from '@/lib/auth/session';
import { shouldUseSecureCookie } from '@/lib/auth/cookie';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    
    // Blacklist the token if it has a JTI
    if (session?.jti) {
      const ttl = session.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await blacklistToken(session.jti, ttl);
      }
    }
    
    const response = NextResponse.json({ ok: true });
    response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Vary', 'Cookie, Authorization, Origin');
    
    // Clear the cookie
    response.cookies.set('app_session', '', {
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
      sameSite: 'strict',
      maxAge: 0,
      path: '/',
    });
    
    return response;
  } catch {
    return NextResponse.json(
      { error: 'Logout failed' },
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
