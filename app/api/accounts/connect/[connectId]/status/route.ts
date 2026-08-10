import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ connectId: string }> }
) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  const { connectId } = await params;

  return forwardToBackend({
    method: 'GET',
    path: `/accounts/connect/${encodeURIComponent(connectId)}/status`,
  });
}
