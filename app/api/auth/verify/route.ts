// FILE: app/api/auth/verify/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  const headers = {
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    Pragma: 'no-cache',
    Vary: 'Cookie, Authorization, Origin',
  };
  
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401, headers });
  }
  
  return NextResponse.json({ authenticated: true }, { headers });
}
