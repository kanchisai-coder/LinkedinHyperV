import { NextRequest } from 'next/server';
import {
  authenticateCaller,
  badRequest,
  forwardToBackend,
  requireString,
} from '@/lib/server/backend-api';

export async function GET(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  try {
    const accountId = requireString(
      req.nextUrl.searchParams.get('accountId'),
      'accountId'
    );
    const chatId = requireString(
      req.nextUrl.searchParams.get('chatId'),
      'chatId'
    );
    const cursor = req.nextUrl.searchParams.get('cursor');
    const limit = req.nextUrl.searchParams.get('limit');

    const query = new URLSearchParams({ accountId, chatId });
    if (cursor) query.set('cursor', cursor);
    if (limit) query.set('limit', limit);

    return forwardToBackend({
      method: 'GET',
      path: '/messages/thread',
      query,
    });
  } catch (error) {
    return badRequest(error);
  }
}
