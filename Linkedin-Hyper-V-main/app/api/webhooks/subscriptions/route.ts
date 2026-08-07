import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateCaller(req);
  if (auth) return auth;
  return forwardToBackend({
    method: 'GET',
    path: '/webhooks/subscriptions',
  });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateCaller(req);
  if (auth) return auth;
  const body = await req.json().catch(() => ({}));
  return forwardToBackend({
    method: 'POST',
    path: '/webhooks/subscriptions',
    body,
  });
}
