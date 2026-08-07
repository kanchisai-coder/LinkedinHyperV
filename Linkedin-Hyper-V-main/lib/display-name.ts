function normalizeWhitespace(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isGenericUiLabel(value: string | undefined): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) return true;

  if (/^\d+$/.test(normalized)) return true;
  if (/^\d+\s*(notification|notifications|message|messages)(\s+total)?$/.test(normalized)) return true;
  if (/^(notification|notifications|message|messages)\s+total$/.test(normalized)) return true;

  const blocked = new Set([
    'unknown',
    'inbox',
    'messages',
    'messaging',
    'linkedin messaging',
    'activity',
    'notifications',
    'notifications total',
    'loading',
    'linkedin',
    'feed',
    'search',
  ]);
  return blocked.has(normalized);
}

function isOpaqueLinkedInIdentifier(value: string | undefined): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  const compact = normalized.replace(/[^A-Za-z0-9]/g, '');
  return /^ACo[A-Za-z0-9]{12,}$/i.test(compact) || /^A[A-Za-z0-9]{15,}$/i.test(compact);
}

export function deriveDisplayName(name?: string, profileUrl?: string): string {
  const normalized = normalizeWhitespace(name);
  if (normalized && !isGenericUiLabel(normalized) && !isOpaqueLinkedInIdentifier(normalized)) {
    return normalized;
  }

  const match = String(profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match?.[1]) return 'Unknown';

  const fromSlug = normalizeWhitespace(
    decodeURIComponent(match[1])
      .replace(/[-_]+/g, ' ')
      .replace(/\b\d+\b/g, '')
  );
  if (!fromSlug || isOpaqueLinkedInIdentifier(fromSlug)) {
    return 'Unknown';
  }
  return fromSlug;
}

function deriveNameFromPreview(preview?: string): string {
  const normalizedPreview = normalizeWhitespace(preview);
  if (!normalizedPreview) return 'Unknown';

  const match = normalizedPreview.match(/^([^:]{2,40}):\s*/);
  if (!match?.[1]) return 'Unknown';

  const candidate = normalizeWhitespace(match[1]);
  if (!candidate || /^you$/i.test(candidate) || isGenericUiLabel(candidate)) {
    return 'Unknown';
  }

  return candidate;
}

export function deriveConversationName(input: {
  name?: string;
  profileUrl?: string;
  lastMessageText?: string;
  messages?: Array<{ senderName?: string; sentByMe?: boolean }>;
}): string {
  const fromName = deriveDisplayName(input.name, input.profileUrl);
  if (fromName !== 'Unknown') {
    return fromName;
  }

  const fromMessages = (input.messages || []).find((message) => {
    const candidate = normalizeWhitespace(message.senderName);
    return !message.sentByMe && candidate && !isGenericUiLabel(candidate);
  });
  if (fromMessages?.senderName) {
    return normalizeWhitespace(fromMessages.senderName);
  }

  const fromPreview = deriveNameFromPreview(input.lastMessageText);
  if (fromPreview !== 'Unknown') {
    return fromPreview;
  }

  return 'Unknown';
}
