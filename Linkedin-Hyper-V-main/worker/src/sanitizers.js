'use strict';

const ID_PATTERN = /^[A-Za-z0-9._:=+-]+$/;
const LINKEDIN_HOST_PATTERN = /(^|\.)linkedin\.com$/i;

function toNormalizedString(value) {
  return String(value ?? '').normalize('NFKC');
}

function sanitizeText(value, { maxLength = 3000 } = {}) {
  const normalized = toNormalizedString(value)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''); // strip C0/C1 except \n

  return normalized.trim().slice(0, maxLength);
}

function sanitizeNote(value) {
  // Same as sanitizeText + max 300 chars + collapse ALL internal whitespace
  return sanitizeText(value, { maxLength: 300 }).replace(/\s+/g, ' ').trim();
}

function sanitizeId(value) {
  return toNormalizedString(value).trim();
}

function validateId(value, { field, min = 3, max = 128 } = {}) {
  const sanitized = sanitizeId(value);
  if (!sanitized) throw new Error(`${field} is required`);
  if (sanitized.length < min || sanitized.length > max) {
    throw new Error(`${field} must be ${min}-${max} characters`);
  }
  if (!ID_PATTERN.test(sanitized)) {
    throw new Error(`${field} contains invalid characters`);
  }
  return sanitized;
}

function validateProfileUrl(value) {
  const profileUrl = sanitizeId(value);
  if (!profileUrl) throw new Error('profileUrl is required');

  let parsed;
  try {
    parsed = new URL(profileUrl);
  } catch (_) {
    throw new Error('profileUrl must be a valid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('profileUrl must use http or https');
  }
  if (!LINKEDIN_HOST_PATTERN.test(parsed.hostname)) {
    throw new Error('profileUrl must point to linkedin.com');
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('profileUrl must include a LinkedIn profile path');
  }

  return parsed.toString();
}

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

module.exports = {
  sanitizeText,
  sanitizeNote,
  validateId,
  validateProfileUrl,
  parseLimit,
};
