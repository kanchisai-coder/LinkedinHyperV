export class LinkedInApiError extends Error {
  public status: number;
  public code?: string;
  public details?: unknown;
  public headers?: Record<string, string>;

  constructor(message: string, status: number, code?: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.name = 'LinkedInApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export interface LinkedInClientOptions {
  accessToken: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseUrl?: string;
}

export interface LinkedInUserInfo {
  sub: string;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  locale?: {
    country: string;
    language: string;
  };
}

export interface LinkedInProfile {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  vanityName?: string;
  profilePicture?: unknown;
}

export interface CreatePostRequest {
  authorUrn: string; // e.g. "urn:li:person:12345" or "urn:li:organization:67890"
  text: string;
  visibility?: 'PUBLIC' | 'CONNECTIONS';
  title?: string;
  targetUrl?: string;
}

export interface CreatePostResponse {
  id: string; // Post URN e.g., "urn:li:share:7123456789"
  status: 'PUBLISHED' | 'PENDING';
}

export class LinkedInApiClient {
  private accessToken: string;
  private timeoutMs: number;
  private maxRetries: number;
  private baseUrl: string;

  constructor(options: LinkedInClientOptions) {
    this.accessToken = options.accessToken;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseUrl = options.baseUrl ?? 'https://api.linkedin.com';
  }

  /**
   * Universal HTTP fetch wrapper with rate-limiting, exponential backoff, and error normalization.
   */
  private async request<T>(endpoint: string, init?: RequestInit): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    let attempt = 0;
    let delayMs = 500;

    while (attempt <= this.maxRetries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${this.accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202401',
          ...(init?.headers as Record<string, string> || {}),
        };

        const response = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          if (response.status === 204) {
            return {} as T;
          }
          return (await response.json()) as T;
        }

        // Handle 429 Too Many Requests or 503 Service Unavailable with exponential backoff
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          const retryAfterHeader = response.headers.get('retry-after');
          const waitTime = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : delayMs;
          
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          attempt++;
          delayMs *= 2;
          continue;
        }

        let errorDetails: unknown;
        try {
          errorDetails = await response.json();
        } catch {
          errorDetails = await response.text();
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          responseHeaders[key] = val;
        });

        throw new LinkedInApiError(
          `LinkedIn API request failed with status ${response.status}: ${response.statusText}`,
          response.status,
          (errorDetails as { code?: string })?.code || `HTTP_${response.status}`,
          errorDetails,
          responseHeaders
        );
      } catch (err: unknown) {
        clearTimeout(timeoutId);

        if (err instanceof LinkedInApiError) {
          throw err;
        }

        if (attempt < this.maxRetries) {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
          continue;
        }

        const isAbort = (err as Error)?.name === 'AbortError';
        throw new LinkedInApiError(
          isAbort ? `LinkedIn API request timed out after ${this.timeoutMs}ms` : (err as Error)?.message || 'Unknown network error',
          isAbort ? 408 : 500,
          isAbort ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
          err
        );
      }
    }

    throw new LinkedInApiError('Max retries exceeded', 500, 'MAX_RETRIES_EXCEEDED');
  }

  /**
   * Fetches user profile info using OpenID Connect standard `/v2/userinfo` endpoint.
   */
  public async getUserInfo(): Promise<LinkedInUserInfo> {
    return this.request<LinkedInUserInfo>('/v2/userinfo');
  }

  /**
   * Fetches basic member profile via `/v2/me` (requires profile scope or r_basicprofile).
   */
  public async getProfile(): Promise<LinkedInProfile> {
    return this.request<LinkedInProfile>('/v2/me');
  }

  /**
   * Retrieves organization access control lists (ACLs) for the authenticated user.
   */
  public async getOrganizations(): Promise<{ elements: unknown[] }> {
    return this.request<{ elements: unknown[] }>('/v2/organizationalEntityAcls?q=roleAssignee');
  }

  /**
   * Posts content (text/share) to a member profile or organization using standard Share/Posts API.
   */
  public async createPost(post: CreatePostRequest): Promise<CreatePostResponse> {
    const payload = {
      author: post.authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: post.text,
          },
          shareMediaCategory: post.targetUrl ? 'ARTICLE' : 'NONE',
          media: post.targetUrl
            ? [
                {
                  status: 'READY',
                  originalUrl: post.targetUrl,
                  title: { text: post.title || post.targetUrl },
                },
              ]
            : [],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': post.visibility || 'PUBLIC',
      },
    };

    const res = await this.request<{ id: string }>('/v2/ugcPosts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      id: res.id,
      status: 'PUBLISHED',
    };
  }

  /**
   * Registers a media upload asset (Image/Video) on LinkedIn.
   */
  public async registerMediaUpload(authorUrn: string, mediaType: 'IMAGE' | 'VIDEO'): Promise<{ uploadUrl: string; assetUrn: string }> {
    const payload = {
      registerUploadRequest: {
        recipes: [mediaType === 'IMAGE' ? 'urn:li:digitalmediaRecipe:feedshare-image' : 'urn:li:digitalmediaRecipe:feedshare-video'],
        owner: authorUrn,
        serviceRelationships: [
          {
            relationshipType: 'OWNER',
            identifier: 'urn:li:userGeneratedContent',
          },
        ],
      },
    };

    const res = await this.request<{
      value: {
        uploadMechanism: {
          'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': {
            uploadUrl: string;
          };
        };
        asset: string;
      };
    }>('/v2/assets?action=registerUpload', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      uploadUrl: res.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl,
      assetUrn: res.value.asset,
    };
  }
}
