import { NextResponse } from 'next/server';
import { oauthService } from '@/lib/linkedin/oauth';

export async function GET() {
  try {
    const { url, state, codeVerifier } = oauthService.generateAuthorizationUrl();

    const response = NextResponse.redirect(url);

    // Set secure HTTP-only cookies for CSRF state and PKCE verifier validation
    response.cookies.set('linkedin_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    });

    response.cookies.set('linkedin_pkce_verifier', codeVerifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('LinkedIn authorization initiation error:', error);
    return NextResponse.json({ error: 'Failed to initiate LinkedIn OAuth' }, { status: 500 });
  }
}
