import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authenticateCaller(req);
  if (auth) return auth;
  const body = await req.json().catch(() => ({}));
  return forwardToBackend({
    method: 'POST',
    path: '/maintenance/messages/dedupe',
    body,
    timeoutMs: 180_000,
  });
}
