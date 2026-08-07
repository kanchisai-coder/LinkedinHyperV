import { NextRequest } from 'next/server';
import { authenticateCaller, badRequest, forwardToBackend } from '@/lib/server/backend-api';

const ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

export async function POST(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const format = String(body?.format || 'csv').toLowerCase();
    if (!['csv', 'json'].includes(format)) {
      throw new Error('Invalid format. Allowed values: csv, json');
    }

    const accountId = body?.accountId ? String(body.accountId).trim() : undefined;
    if (accountId && !ID_RE.test(accountId)) {
      throw new Error('Invalid accountId');
    }

    // Backward-compatible alias: frontend may still send chatId.
    const conversationIdRaw = body?.conversationId ?? body?.chatId;
    const conversationId = conversationIdRaw ? String(conversationIdRaw).trim() : undefined;
    if (conversationId && !ID_RE.test(conversationId)) {
      throw new Error('Invalid conversationId');
    }

    return forwardToBackend({
      method: 'POST',
      path: '/export/messages',
      body: {
        format,
        ...(accountId ? { accountId } : {}),
        ...(conversationId ? { conversationId } : {}),
      },
    });
  } catch (error) {
    return badRequest(error);
  }
}
