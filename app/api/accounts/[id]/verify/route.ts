// FILE: app/api/accounts/[id]/verify/route.ts
import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;
  
  const { id: accountId } = await params;
  
  // This endpoint takes 10-30 seconds as it launches a browser
  return forwardToBackend({
    method: 'POST',
    path: `/accounts/${accountId}/verify`,
    // Verify can now take longer because we wait for feed/messaging auth state to settle.
    timeoutMs: 240_000,
  });
}
