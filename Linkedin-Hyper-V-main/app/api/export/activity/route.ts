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

    const parsedLimit = body?.limit == null ? 1000 : Number.parseInt(String(body.limit), 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 5000) {
      throw new Error('limit must be an integer between 1 and 5000');
    }

    return forwardToBackend({
      method: 'POST',
      path: '/export/activity',
      body: {
        format,
        limit: parsedLimit,
        ...(accountId ? { accountId } : {}),
      },
    });
  } catch (error) {
    return badRequest(error);
  }
}
