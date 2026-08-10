// FILE: app/api/accounts/[id]/session/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller, forwardToBackend, badRequest } from '@/lib/server/backend-api';
import { validateLinkedInCookies } from '@/lib/validators/cookie-validator';

// POST - Import session cookies
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;
  
  try {
    const { id: accountId } = await params;
    const cookies = await req.json();
    
    // Validate account ID format
    if (!/^[a-z0-9_-]+$/i.test(accountId)) {
      return badRequest(new Error('Invalid account ID format'));
    }
    
    // Validate cookies
    const validation = validateLinkedInCookies(cookies);
    if (!validation.isValid) {
      return NextResponse.json(
        { 
          error: 'Invalid cookies', 
          details: validation.errors,
          warnings: validation.warnings 
        },
        { status: 400 }
      );
    }
    
    // Forward to worker
    return forwardToBackend({
      method: 'POST',
      path: `/accounts/${accountId}/session`,
      body: cookies,
    });
  } catch (err) {
    return badRequest(err);
  }
}

// DELETE - Remove session cookies
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await authenticateCaller(req);
  if (authError) return authError;
  
  const { id: accountId } = await params;
  
  return forwardToBackend({
    method: 'DELETE',
    path: `/accounts/${accountId}/session`,
  });
}
