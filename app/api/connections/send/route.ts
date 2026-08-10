// FILE: app/api/connections/send/route.ts
import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend, badRequest } from '@/lib/server/backend-api';

export async function POST(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { accountId, profileUrl, note } = body;

    if (!accountId || !profileUrl) {
      return badRequest(new Error('Missing required fields: accountId, profileUrl'));
    }

    // Validate note length (max 300 chars)
    if (note && note.length > 300) {
      return badRequest(new Error('Note must be 300 characters or less'));
    }

    return forwardToBackend({
      method: 'POST',
      path: '/connections/send',
      body: { accountId, profileUrl, note },
    });
  } catch (err) {
    return badRequest(err);
  }
}
