import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export async function GET(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  return forwardToBackend({ method: 'GET', path: '/accounts' });
}
