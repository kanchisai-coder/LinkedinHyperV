// FILE: middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth/jwt';

const publicPaths = ['/login', '/api/auth/login', '/api/auth/logout', '/api/auth/register'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // API routes are protected by route-level auth checks (backend-api.ts).
  // Do not redirect API requests to /login, or non-browser clients will get 405.
  if (pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  // Allow public paths
  if (publicPaths.some(path => pathname.startsWith(path))) {
    return NextResponse.next();
  }
  
  // Allow Next.js internals
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }
  
  // Check authentication
  const token = request.cookies.get('app_session')?.value;

  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Middleware runs on the Edge runtime, so keep it free of Node-only
  // dependencies like Redis clients. Deeper blacklist enforcement still
  // happens in the Node runtime auth routes.
  const payload = await verifyToken(token);
  if (!payload?.authenticated) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    const res = NextResponse.redirect(loginUrl);
    res.cookies.set('app_session', '', { path: '/', maxAge: 0 });
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
