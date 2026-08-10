import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateCaller(req);
  if (auth) return auth;
  const { id } = await context.params;
  return forwardToBackend({
    method: 'DELETE',
    path: `/webhooks/subscriptions/${encodeURIComponent(id)}`,
  });
}
