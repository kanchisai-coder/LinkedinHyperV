import { generatePKCE, generateState } from './pkce';
import { LinkedInApiError } from './linkedin-client';

export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface AuthorizationUrlParams {
  clientId?: string;
  redirectUri?: string;
  scopes?: string[];
  state?: string;
  codeChallenge?: string;
}

export class LinkedInOAuthService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private defaultScopes: string[];

  constructor() {
    this.clientId = process.env.LINKEDIN_CLIENT_ID || 'mock-client-id';
    this.clientSecret = process.env.LINKEDIN_CLIENT_SECRET || 'mock-client-secret';
    this.redirectUri = process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3000/api/auth/linkedin/callback';
    this.defaultScopes = ['openid', 'profile', 'email', 'w_member_social'];
  }

  /**
   * Generates complete LinkedIn OAuth 2.0 Authorization URL with PKCE.
   */
  public generateAuthorizationUrl(params?: AuthorizationUrlParams): {
    url: string;
    state: string;
    codeVerifier: string;
    codeChallenge: string;
  } {
    const pkce = generatePKCE();
    const state = params?.state || generateState();
    const scopes = params?.scopes || this.defaultScopes;
    const clientId = params?.clientId || this.clientId;
    const redirectUri = params?.redirectUri || this.redirectUri;

    const queryParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: state,
      scope: scopes.join(' '),
      code_challenge: params?.codeChallenge || pkce.codeChallenge,
      code_challenge_method: 'S256',
    });

    const url = `https://www.linkedin.com/oauth/v2/authorization?${queryParams.toString()}`;

    return {
      url,
      state,
      codeVerifier: pkce.codeVerifier,
      codeChallenge: pkce.codeChallenge,
    };
  }

  /**
   * Exchanges authorization code and PKCE code_verifier for Access Token & Refresh Token.
   */
  public async exchangeCodeForToken(code: string, codeVerifier: string, customRedirectUri?: string): Promise<OAuthTokenResponse> {
    const redirectUri = customRedirectUri || this.redirectUri;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      code_verifier: codeVerifier,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
    });

    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      let errBody: unknown;
      try {
        errBody = await response.json();
      } catch {
        errBody = await response.text();
      }
      throw new LinkedInApiError(
        `OAuth token exchange failed with status ${response.status}`,
        response.status,
        (errBody as { error?: string })?.error || 'TOKEN_EXCHANGE_FAILED',
        errBody
      );
    }

    return (await response.json()) as OAuthTokenResponse;
  }

  /**
   * Refreshes an expired access token using refresh_token.
   */
  public async refreshToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      let errBody: unknown;
      try {
        errBody = await response.json();
      } catch {
        errBody = await response.text();
      }
      throw new LinkedInApiError(
        `OAuth token refresh failed with status ${response.status}`,
        response.status,
        (errBody as { error?: string })?.error || 'TOKEN_REFRESH_FAILED',
        errBody
      );
    }

    return (await response.json()) as OAuthTokenResponse;
  }
}

export const oauthService = new LinkedInOAuthService();
