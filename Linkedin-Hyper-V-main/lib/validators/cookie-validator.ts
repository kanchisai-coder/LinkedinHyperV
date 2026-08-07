// FILE: lib/validators/cookie-validator.ts
export interface LinkedInCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface CookieValidationResult {
  isValid: boolean;
  hasLiAt: boolean;
  hasJSessionId: boolean;
  errors: string[];
  warnings: string[];
}

export function validateLinkedInCookies(input: unknown): CookieValidationResult {
  const result: CookieValidationResult = {
    isValid: false,
    hasLiAt: false,
    hasJSessionId: false,
    errors: [],
    warnings: [],
  };
  
  // Must be array
  if (!Array.isArray(input)) {
    result.errors.push('Input must be a JSON array of cookies');
    return result;
  }
  
  if (input.length === 0) {
    result.errors.push('Cookie array is empty');
    return result;
  }
  
  // Check for required cookies
  for (const cookie of input) {
    if (!cookie.name || !cookie.value || !cookie.domain) {
      result.warnings.push('Cookie missing name, value, or domain');
      continue;
    }
    
    if (cookie.name === 'li_at') {
      result.hasLiAt = true;
      
      // Validate li_at specifics
      if (!cookie.value.startsWith('AQ')) {
        result.warnings.push('li_at value should start with "AQ"');
      }
      if (cookie.domain !== '.linkedin.com') {
        result.warnings.push('li_at domain should be .linkedin.com');
      }
      if (cookie.httpOnly !== true) {
        result.warnings.push('li_at should be httpOnly');
      }
    }
    
    if (cookie.name === 'JSESSIONID') {
      result.hasJSessionId = true;
      
      if (cookie.domain !== '.linkedin.com') {
        result.warnings.push('JSESSIONID domain should be .linkedin.com');
      }
    }
  }
  
  // Validate required cookies present
  if (!result.hasLiAt) {
    result.errors.push('Missing required cookie: li_at');
  }
  if (!result.hasJSessionId) {
    result.errors.push('Missing required cookie: JSESSIONID');
  }
  
  result.isValid = result.errors.length === 0;
  
  return result;
}
