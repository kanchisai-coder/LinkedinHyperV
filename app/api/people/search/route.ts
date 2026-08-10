// FILE: app/api/people/search/route.ts
import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export async function GET(req: NextRequest) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;

  const searchParams = req.nextUrl.searchParams;
  const query = new URLSearchParams();
  
  searchParams.forEach((value, key) => {
    query.set(key, value);
  });

  return forwardToBackend({
    method: 'GET',
    path: '/people/search',
    query,
  });
}
