import { NextRequest } from 'next/server';
import {
  authenticateCaller,
  badRequest,
  forwardToBackend,
  requireString,
} from '@/lib/server/backend-api';

export async function POST(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  try {
    const body = (await req.json()) as {
      accountId?: string;
      chatId?: string;
      text?: string;
    };

    const accountId = requireString(body.accountId ?? null, 'accountId');
    const chatId    = requireString(body.chatId    ?? null, 'chatId');
    const text      = requireString(body.text      ?? null, 'text');

    return forwardToBackend({
      method: 'POST',
      path: '/messages/send',
      body: { accountId, chatId, text },
    });
  } catch (error) {
    return badRequest(error);
  }
}
