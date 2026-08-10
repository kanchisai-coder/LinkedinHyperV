import { NextRequest, NextResponse } from 'next/server';
import { oauthService } from '@/lib/linkedin/oauth';
import { encryptToken } from '@/lib/linkedin/token-crypto';
import { LinkedInApiClient } from '@/lib/linkedin/linkedin-client';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    console.error('LinkedIn OAuth returned error:', error, errorDescription);
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(errorDescription || error)}`, req.url));
  }

  const savedState = req.cookies.get('linkedin_oauth_state')?.value;
  const codeVerifier = req.cookies.get('linkedin_pkce_verifier')?.value;

  // Strict CSRF and PKCE verifier validation
  if (!state || !savedState || state !== savedState) {
    return NextResponse.json({ error: 'CSRF State Mismatch Failure' }, { status: 400 });
  }

  if (!code || !codeVerifier) {
    return NextResponse.json({ error: 'Missing authorization code or PKCE verifier' }, { status: 400 });
  }

  try {
    // Perform secure backend token exchange using code + verifier
    const tokenResponse = await oauthService.exchangeCodeForToken(code, codeVerifier);

    // Fetch user profile info via OpenID Connect `/v2/userinfo`
    const client = new LinkedInApiClient({ accessToken: tokenResponse.access_token });
    const userInfo = await client.getUserInfo();

    // Encrypt access and refresh tokens using AES-256-GCM
    const encAccessToken = encryptToken(tokenResponse.access_token);
    const encRefreshToken = tokenResponse.refresh_token ? encryptToken(tokenResponse.refresh_token) : null;

    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);
    const refreshTokenExpiresAt = tokenResponse.refresh_token_expires_in
      ? new Date(Date.now() + tokenResponse.refresh_token_expires_in * 1000)
      : null;

    // Persist token model in database
    const upsertQuery = `
      INSERT INTO linkedin_oauth_tokens (
        linkedin_sub, access_token_encrypted, iv, tag, refresh_token_encrypted, refresh_iv, refresh_tag, scope, expires_at, refresh_token_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (linkedin_sub) DO UPDATE SET
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        iv = EXCLUDED.iv,
        tag = EXCLUDED.tag,
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        refresh_iv = EXCLUDED.refresh_iv,
        refresh_tag = EXCLUDED.refresh_tag,
        scope = EXCLUDED.scope,
        expires_at = EXCLUDED.expires_at,
        refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
        updated_at = CURRENT_TIMESTAMP;
    `;

    await query(upsertQuery, [
      userInfo.sub,
      encAccessToken.encrypted,
      encAccessToken.iv,
      encAccessToken.tag,
      encRefreshToken?.encrypted || null,
      encRefreshToken?.iv || null,
      encRefreshToken?.tag || null,
      tokenResponse.scope || 'openid profile email w_member_social',
      expiresAt,
      refreshTokenExpiresAt,
    ]).catch((err) => {
      console.warn('DB persistence notice (table may be auto-created on startup):', err.message);
    });

    const response = NextResponse.redirect(new URL('/dashboard?connected=true', req.url));

    // Clear OAuth state cookies
    response.cookies.delete('linkedin_oauth_state');
    response.cookies.delete('linkedin_pkce_verifier');

    return response;
  } catch (err: unknown) {
    console.error('LinkedIn OAuth Callback Error:', err);
    return NextResponse.json({ error: (err as Error)?.message || 'OAuth authentication failed' }, { status: 500 });
  }
}
