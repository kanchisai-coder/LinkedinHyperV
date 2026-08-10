import { NextRequest } from 'next/server';
import { authenticateCaller, forwardToBackend } from '@/lib/server/backend-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function backendPath(params: { path?: string[] }) {
  const suffix = (params.path ?? [])
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/unified/${suffix}`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const auth = await authenticateCaller(req);
  if (auth) return auth;
  const params = await ctx.params;
  return forwardToBackend({
    method: 'GET',
    path: backendPath(params),
    query: req.nextUrl.searchParams,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const auth = await authenticateCaller(req);
  if (auth) return auth;
  const params = await ctx.params;
  const body = await req.json().catch(() => ({}));
  return forwardToBackend({
    method: 'POST',
    path: backendPath(params),
    body,
    timeoutMs: 180_000,
  });
}
