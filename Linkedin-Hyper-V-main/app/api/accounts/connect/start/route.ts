import { NextRequest } from 'next/server';
import { authenticateCaller, badRequest, forwardToBackend } from '@/lib/server/backend-api';

export async function POST(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const accountId = String(body?.accountId || '').trim();
    if (!/^[a-z0-9_-]+$/i.test(accountId)) {
      return badRequest(new Error('Invalid account ID format'));
    }

    return forwardToBackend({
      method: 'POST',
      path: '/accounts/connect/start',
      body: { accountId },
    });
  } catch (err) {
    return badRequest(err);
  }
}
