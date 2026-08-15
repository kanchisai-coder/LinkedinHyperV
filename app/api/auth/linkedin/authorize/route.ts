import { NextRequest, NextResponse } from 'next/server';
import { oauthService } from '@/lib/linkedin/oauth';
import { shouldUseSecureCookie } from '@/lib/auth/cookie';

export async function GET(req: NextRequest) {
  try {
    const { url, state, codeVerifier } = oauthService.generateAuthorizationUrl();

    const response = NextResponse.redirect(url);

    // SECURITY (F4): Use shouldUseSecureCookie() so that the Secure flag is set
    // correctly behind a reverse proxy that terminates TLS (nginx sets
    // X-Forwarded-Proto: https).  Raw NODE_ENV check misses this case in
    // production-behind-proxy and in HTTPS staging environments.
    response.cookies.set('linkedin_oauth_state', state, {
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    });

    response.cookies.set('linkedin_pkce_verifier', codeVerifier, {
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
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
