// FILE: app/api/messages/send-new/route.ts
import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend, badRequest } from '@/lib/server/backend-api';

export async function POST(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { accountId, profileUrl, text } = body;

    if (!accountId || !profileUrl || !text) {
      return badRequest(new Error('Missing required fields: accountId, profileUrl, text'));
    }

    // Validate message length
    if (text.length > 3000) {
      return badRequest(new Error('Message must be 3000 characters or less'));
    }

    return forwardToBackend({
      method: 'POST',
      path: '/messages/send-new',
      body: { accountId, profileUrl, text },
      // send-new can perform profile flow + thread fallback; allow a longer upstream window.
      timeoutMs: 240_000,
    });
  } catch (err) {
    return badRequest(err);
  }
}
