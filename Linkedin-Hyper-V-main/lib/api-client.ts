import type {
  Account,
  ActivityEntry,
  Connection,
  Conversation,
  Message,
  MessageRepairResult,
  BrowserBudgetStatus,
  QueueStatus,
  SyncRunSummary,
  SyncPostureStatus,
  SyncCursor,
  SyncRun,
  ThreadResolutionStats,
  UnifiedAccount,
  UnifiedNotification,
  ConnectSessionStatus,
} from '@/types/dashboard';
import { deriveConversationName } from '@/lib/display-name';

const BASE = '/api';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const rest = options ?? {};
  // Every BFF route responds with Cache-Control: no-store and this runs in the
  // browser (the `next` revalidate option is a server-only no-op), so the old
  // force-cache/ttl path never actually cached — and would have served stale
  // per-user data if used server-side. Always fetch fresh.
  const res = await fetch(`${BASE}/${path}`, {
    cache: 'no-store',
    ...rest,
    headers: { 'Content-Type': 'application/json', ...rest.headers },
  } as RequestInit);

  if (!res.ok) {
    let errorDetail = res.statusText;
    try {
      const errBody = await res.json();
      if (errBody.error) errorDetail = errBody.error;
    } catch {}
    throw new Error(`API ${res.status}: ${errorDetail}`);
  }

  return res.json() as Promise<T>;
}

export async function getAccounts(): Promise<{ accounts: Account[] }> {
  return apiFetch<{ accounts: Account[] }>('accounts');
}

export async function startLinkedInConnect(accountId: string): Promise<{
  connectId: string;
  accountId: string;
  status: ConnectSessionStatus['status'];
  loginUrl: string;
  browserUrl?: string | null;
  fullscreenBrowserUrl?: string | null;
}> {
  return apiFetch('accounts/connect/start', {
    method: 'POST',
    body: JSON.stringify({ accountId }),
  });
}

export async function getLinkedInConnectStatus(connectId: string): Promise<ConnectSessionStatus> {
  return apiFetch<ConnectSessionStatus>(`accounts/connect/${encodeURIComponent(connectId)}/status`);
}

export async function getUnifiedAccounts(): Promise<{ accounts: UnifiedAccount[] }> {
  return apiFetch<{ accounts: UnifiedAccount[] }>('unified/accounts');
}

export async function getUnifiedSyncStatus(): Promise<{
  cursors: SyncCursor[];
  runs: SyncRun[];
  runsSummary?: SyncRunSummary[];
  threadResolution?: ThreadResolutionStats;
  queue?: QueueStatus;
  syncPosture?: string;
  safetyPosture?: string | null;
  nextAllowedAt?: string | null;
  lastAuthFailure?: string | null;
  lastSafetyWarning?: string | null;
  lastWarningUrl?: string | null;
  safetyPausedSurfaces?: string[];
  blockedAccounts?: number;
  browserMinutesEstimate?: number;
  browserRecycles?: number;
  lastBrowserFatalError?: string | null;
  threadsAttempted?: number;
  threadsRefreshed?: number;
  threadFailures?: number;
  postures?: SyncPostureStatus[];
  browser?: BrowserBudgetStatus[];
}> {
  return apiFetch('unified/sync-status');
}

export async function queueUnifiedSync(
  lane: 'delta' | 'backfill',
  options: {
    accountId?: string;
    surfaces?: string[];
    wait?: boolean;
  } = {},
): Promise<{ success: boolean; queued: boolean; accountId?: string | null; lane?: string; surfaces?: string[] }> {
  return apiFetch<{ success: boolean; queued: boolean; accountId?: string | null; lane?: string; surfaces?: string[] }>('unified/sync', {
    method: 'POST',
    body: JSON.stringify({
      lane,
      accountId: options.accountId,
      surfaces: options.surfaces,
      wait: options.wait,
    }),
  });
}

export async function getUnifiedInbox(options: { limit?: number; cursor?: string | null } = {}): Promise<{ conversations: Conversation[]; nextCursor?: string | null; hasMore?: boolean }> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString() ? `?${params.toString()}` : '';
  const payload = await apiFetch<{ conversations: Conversation[]; nextCursor?: string | null; hasMore?: boolean }>(`unified/inbox${query}`);
  // Guard against a 2xx body missing the array (contract drift / empty {}) —
  // apiFetch only throws on !res.ok, so an unguarded .map would crash opaquely.
  const list = Array.isArray(payload.conversations) ? payload.conversations : [];
  return {
    conversations: list.map((conv) => ({
      ...conv,
      participant: {
        ...conv.participant,
        name: deriveConversationName({
          name: conv.participant?.name || 'Unknown',
          profileUrl: conv.participant?.profileUrl || '',
          lastMessageText: conv.lastMessage?.text || '',
          messages: Array.isArray(conv.messages) ? conv.messages : [],
        }),
      },
      lastMessage: {
        ...conv.lastMessage,
        text: conv.lastMessage?.text || '',
      },
      messages: Array.isArray(conv.messages) ? conv.messages : [],
      shell: Boolean(conv.shell),
      syncState: conv.syncState || (conv.shell ? 'shell_only' : 'available'),
      resolutionState: conv.resolutionState || conv.syncState || (conv.shell ? 'shell_only' : 'available'),
      shellReason: conv.shellReason || null,
      threadUrl: conv.threadUrl || null,
      messageCount: typeof conv.messageCount === 'number' ? conv.messageCount : 0,
      messageCountCanonical: typeof conv.messageCountCanonical === 'number'
        ? conv.messageCountCanonical
        : (typeof conv.messageCount === 'number' ? conv.messageCount : 0),
      lastResolvedAt: conv.lastResolvedAt || null,
      resolveAttempts: typeof conv.resolveAttempts === 'number' ? conv.resolveAttempts : 0,
      sourceQuality: typeof conv.sourceQuality === 'number' ? conv.sourceQuality : 0,
    })),
    nextCursor: payload.nextCursor || null,
    hasMore: Boolean(payload.hasMore),
  };
}

export async function queueThreadResolution(input: {
  accountId?: string;
  conversationIds?: string[];
  priority?: 'visible' | 'recent' | 'backfill';
  limit?: number;
  wait?: boolean;
}): Promise<{ queued: boolean; accountId?: string; count?: number; resolved?: number; failed?: number; messagesCaptured?: number }> {
  return apiFetch('unified/thread-resolution', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getConversationThread(
  accountId: string,
  chatId: string,
  options: { liveFallback?: boolean; cursor?: string | null; limit?: number } = {},
): Promise<{ messages: Message[]; participant?: { name: string; profileUrl: string }; source?: 'db' | 'live'; stale?: boolean; cursor?: string | null; hasMore?: boolean }> {
  const params = new URLSearchParams({
    accountId,
    chatId,
    liveFallback: options.liveFallback === true ? 'true' : 'false',
  });
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const res = await apiFetch<{
    items: Array<{
      id: string;
      chatId: string;
      senderId?: string;
      isSentByMe?: boolean;
      text: string;
      createdAt?: string;
      sentAt?: string;
      senderName?: string;
      visibilityState?: Message['visibilityState'];
      senderConfidence?: number;
      timestampConfidence?: number;
      isCanonical?: boolean;
    }>;
    participant?: {
      name?: string;
      profileUrl?: string;
    };
    cursor?: string | null;
    hasMore?: boolean;
    source?: 'db' | 'live';
    stale?: boolean;
  }>(`messages/thread?${params.toString()}`);

  const participantDisplayName = deriveConversationName({
    name: res.participant?.name || 'Unknown',
    profileUrl: res.participant?.profileUrl || '',
    messages: res.items,
  });

  const mappedMessages = res.items.map((message) => ({
    id: message.id,
    text: message.text,
    sentAt: (() => {
      const rawTs = message.createdAt ?? message.sentAt;
      if (!rawTs) return null;
      const parsed = new Date(rawTs).getTime();
      return Number.isFinite(parsed) ? parsed : null;
    })(),
    sentByMe: message.senderId === '__self__' || message.isSentByMe === true,
    senderName:
      (message.senderId === '__self__' || message.isSentByMe === true)
        ? (message.senderName || accountId)
        : (
            message.senderName && message.senderName !== 'Unknown'
              ? message.senderName
              : participantDisplayName
          ),
    visibilityState: message.visibilityState || 'visible',
    senderConfidence: typeof message.senderConfidence === 'number' ? message.senderConfidence : 1,
    timestampConfidence: typeof message.timestampConfidence === 'number' ? message.timestampConfidence : 1,
    isCanonical: message.isCanonical !== false,
  }));

  return {
    messages: mappedMessages,
    participant: res.participant ? {
      name: deriveConversationName({
        name: participantDisplayName,
        profileUrl: res.participant.profileUrl || '',
        messages: mappedMessages,
      }),
      profileUrl: res.participant.profileUrl || '',
    } : undefined,
    cursor: res.cursor,
    hasMore: res.hasMore,
    source: res.source,
    stale: res.stale,
  };
}

export async function getAccountActivity(accountId: string, page = 0, limit = 50): Promise<{ entries: ActivityEntry[]; total: number }> {
  return apiFetch<{ entries: ActivityEntry[]; total: number }>(
    `stats/${encodeURIComponent(accountId)}/activity?page=${page}&limit=${limit}`
  );
}

export async function getUnifiedConnections(limit = 300): Promise<{ connections: Connection[] }> {
  return apiFetch<{ connections: Connection[] }>(`unified/connections?limit=${encodeURIComponent(String(limit))}`);
}

export async function getUnifiedNotifications(limit = 100): Promise<{ notifications: UnifiedNotification[] }> {
  return apiFetch<{ notifications: UnifiedNotification[] }>(`unified/notifications?limit=${encodeURIComponent(String(limit))}`);
}

export async function sendMessage(accountId: string, chatId: string, text: string): Promise<{
  success?: boolean;
  id?: string;
  chatId?: string;
  createdAt?: string;
  deliveryState?: 'accepted' | 'accepted_unverified';
}> {
  return apiFetch<{
    success?: boolean;
    id?: string;
    chatId?: string;
    createdAt?: string;
    deliveryState?: 'accepted' | 'accepted_unverified';
  }>('messages/send', {
    method: 'POST',
    body: JSON.stringify({ accountId, chatId, text }),
  });
}

export async function repairMessages(input: {
  accountId?: string;
  conversationId?: string;
  dryRun?: boolean;
}): Promise<MessageRepairResult> {
  return apiFetch<MessageRepairResult>('maintenance/messages/dedupe', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
