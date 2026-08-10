import { NextRequest } from 'next/server';
import {
  authenticateCaller,
  badRequest,
  forwardToBackend,
  requireInteger,
  requireString,
} from '@/lib/server/backend-api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  try {
    // Next.js 15+: params is a Promise — must be awaited
    const { accountId: rawAccountId } = await params;
    const accountId = requireString(rawAccountId, 'accountId');

    const page = requireInteger(req.nextUrl.searchParams.get('page'), 'page', {
      min: 0,
      fallback: 0,
    });
    const limit = requireInteger(req.nextUrl.searchParams.get('limit'), 'limit', {
      min: 1,
      max: 200,
      fallback: 50,
    });

    return forwardToBackend({
      method: 'GET',
      path: `/stats/${encodeURIComponent(accountId)}/activity`,
      query: new URLSearchParams({ page: String(page), limit: String(limit) }),
    });
  } catch (error) {
    return badRequest(error);
  }
}
