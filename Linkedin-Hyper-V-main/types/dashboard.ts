// All shared TypeScript interfaces for the LinkedIn Dashboard
// Shapes match the real backend API responses

export interface Account {
  id: string;
  displayName: string;
  isActive: boolean;
  lastSeen: string | number | null;
  verifiedAt?: string | null;
  sessionStatus?: string | null;
  lastSessionSavedAt?: string | number | null;
  liveReachability?: string | null;
  liveReachabilityAt?: string | null;
  liveReachabilityUrl?: string | null;
}

export interface UnifiedAccount {
  id: string;
  displayName?: string | null;
  status?: string | null;
  hasSession?: boolean;
  sessionSavedAt?: number | null;
  verifiedAt?: string | null;
  lastSessionSavedAt?: string | null;
}

export interface ConnectSessionStatus {
  connectId: string;
  accountId: string;
  status: 'waiting_for_login' | 'checkpoint_required' | 'connected' | 'failed' | 'expired';
  loginUrl: string;
  browserUrl?: string | null;
  fullscreenBrowserUrl?: string | null;
  message?: string;
  currentUrl?: string | null;
  syncQueued?: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface Message {
  id: string;
  text: string;
  sentAt: number | null;       // unix ms
  sentByMe: boolean;
  senderName: string;
  deliveryState?: 'accepted' | 'accepted_unverified' | 'failed';
  visibilityState?: 'visible' | 'pending_repair' | 'quarantined';
  senderConfidence?: number;
  timestampConfidence?: number;
  isCanonical?: boolean;
}

export interface Conversation {
  conversationId: string;
  accountId: string;    // which LinkedIn account owns this thread
  externalId?: string;
  threadUrl?: string | null;
  participant: {
    name: string;
    profileUrl: string;
  };
  lastMessage: {
    text: string;
    sentAt: number;     // unix ms
    sentByMe: boolean;
  };
  unreadCount: number;
  messages: Message[];
  shell?: boolean;
  syncState?: 'available' | 'shell_only' | 'partial' | 'resolving' | 'failed' | 'replaced';
  resolutionState?: 'available' | 'shell_only' | 'partial' | 'resolving' | 'failed' | 'replaced';
  shellReason?: string | null;
  messageCount?: number;
  messageCountCanonical?: number;
  lastResolvedAt?: string | null;
  resolveAttempts?: number;
  sourceQuality?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface ActivityEntry {
  type: string;
  accountId: string;
  targetName?: string;
  targetProfileUrl?: string;
  message?: string;
  stats?: {
    conversations?: number;
    newMessages?: number;
    errors?: number;
  };
  timestamp: number;   // unix ms
}

export interface Connection {
  accountId: string;
  name: string;
  profileUrl: string;
  headline?: string;
  connectedAt?: number; // unix ms
}

export interface UnifiedNotification {
  id: string;
  accountId: string;
  type: string;
  title: string;
  text?: string | null;
  url?: string | null;
  occurredAt: string;
}

export interface SyncCursor {
  id: string;
  accountId: string;
  surface: string;
  coverage: string;
  highWatermark?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  nextRunAt?: string | null;
  lagSeconds?: number | null;
  failureCount: number;
  metadata?: Record<string, unknown> | null;
}

export interface SyncRun {
  id: string;
  accountId: string;
  lane: string;
  surface: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;
  itemsRead: number;
  itemsWritten: number;
}

export interface QueueStatus {
  active: number;
  waiting: number;
  delayed: number;
  failed: number;
  lag?: number;
}

export interface SyncRunSummary {
  accountId: string;
  surface: string;
  status: string;
  count: number;
}

export interface SyncPostureStatus {
  accountId: string;
  posture: 'healthy' | 'degraded' | 'blocked' | 'checkpoint' | 'expired' | 'automation_warning';
  reason?: string | null;
  surface?: string | null;
  lane?: string | null;
  errorCode?: string | null;
  warningUrl?: string | null;
  nextAllowedAt?: string | null;
  updatedAt?: string | null;
}

export interface BrowserBudgetStatus {
  accountId: string;
  activeContexts: number;
  openPages: number;
  pagesOpened: number;
  browserRecycles: number;
  browserMinutesEstimate: number;
  lastBrowserFatalError?: string | null;
  updatedAt?: string | null;
}

export interface ThreadResolutionStats {
  shellConversations: number;
  resolvingThreads: number;
  resolvedThreads: number;
  messagesCaptured: number;
  quarantinedMessages?: number;
  threadResolveFailures: number;
  lastResolveError?: string | null;
}

export interface MessageRepairResult {
  dryRun: boolean;
  rowsScanned: number;
  rowsAssigned: number;
  duplicatesCollapsed: number;
  quarantined: number;
  ambiguousSkipped: number;
}

export interface JobResult {
  status: 'completed' | 'failed' | 'active' | 'waiting';
  result?: unknown;
  error?: string;
}

export type ActivityTab = 'all' | 'messageSent' | 'connectionSent' | 'profileViewed' | 'sync';
