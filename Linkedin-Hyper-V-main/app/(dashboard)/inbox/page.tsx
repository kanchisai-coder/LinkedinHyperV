'use client';

import { startTransition, useState, useEffect, useCallback, useRef, useDeferredValue } from 'react';
import type { Conversation, Account } from '@/types/dashboard';
import { getUnifiedInbox, getAccounts, getConversationThread, queueThreadResolution, queueUnifiedSync } from '@/lib/api-client';
import { ConversationList } from '@/components/inbox/ConversationList';
import { MessageThread } from '@/components/inbox/MessageThread';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/ErrorState';
import { wsClient } from '@/lib/websocket-client';
import { ExportButton } from '@/components/ui/ExportButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusPill } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { deriveConversationName } from '@/lib/display-name';
import { AlertTriangle, RefreshCcw, RotateCcw, TimerReset, Zap } from 'lucide-react';
import toast from 'react-hot-toast';

type StatusChangedPayload = { status?: 'connected' | 'disconnected' | 'reconnecting' };

export default function InboxPage() {
  const [accounts,      setAccounts]      = useState<Account[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected,      setSelected]      = useState<Conversation | null>(null);
  const [filter,        setFilter]        = useState<string>('all');
  const [search,        setSearch]        = useState('');
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [isLive,        setIsLive]        = useState(false);
  const [isResolving,   setIsResolving]   = useState(false);
  const [isSyncing,     setIsSyncing]     = useState(false);
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [resolvingIds,  setResolvingIds]  = useState<Set<string>>(new Set());
  const selectedRef = useRef<Conversation | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const handleSelectRef = useRef<((conv: Conversation) => Promise<void>) | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadRefreshInFlightRef = useRef<string | null>(null);
  const deferredSearch = useDeferredValue(search);

  // B2 - Accounts are stable; fetch once on mount (5-min ISR cache in api-client).
  const loadAccounts = useCallback(async () => {
    try {
      const { accounts: accs } = await getAccounts();
      setAccounts(accs);
    } catch {
      // non-fatal - account list stays empty, filter pills just won't show
    }
  }, []);

  // B2 - Inbox is real-time; poll separately on its own interval.
  const loadInbox = useCallback(async () => {
    try {
      const inboxData = await getUnifiedInbox();
      startTransition(() => {
        setConversations(inboxData.conversations);
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load inbox');
    } finally {
      setLoading(false);
    }
  }, []);

  const scheduleInboxRefresh = useCallback((delayMs = 400) => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void loadInbox();
    }, delayMs);
  }, [loadInbox]);

  useEffect(() => {
    void loadAccounts(); // once on mount
  }, [loadAccounts]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const applyThreadResult = useCallback((
    activeConversation: Conversation,
    thread: Awaited<ReturnType<typeof getConversationThread>>,
    options: { preservePending?: boolean } = {},
  ) => {
    const nextMessages = Array.isArray(thread.messages) ? thread.messages : [];
    const participantName = thread.participant?.name || deriveConversationName({
      name: activeConversation.participant.name,
      profileUrl: thread.participant?.profileUrl || activeConversation.participant.profileUrl,
      lastMessageText: activeConversation.lastMessage.text,
      messages: nextMessages,
    });
    const hasThreadMessages = nextMessages.length > 0;
    const nextConversation: Conversation = {
      ...activeConversation,
      participant: {
        ...activeConversation.participant,
        profileUrl: thread.participant?.profileUrl || activeConversation.participant.profileUrl,
        name: participantName,
      },
      messages: nextMessages,
      syncState: hasThreadMessages
        ? 'available'
        : (options.preservePending ? 'resolving' : (thread.stale ? activeConversation.syncState : 'partial')),
      resolutionState: hasThreadMessages
        ? 'available'
        : (options.preservePending ? 'resolving' : (thread.stale ? activeConversation.resolutionState : 'partial')),
      shell: hasThreadMessages ? false : activeConversation.shell,
      shellReason: hasThreadMessages
        ? null
        : (options.preservePending
          ? 'Queued for background resolution. Persisted messages will appear here as soon as the worker finishes.'
          : activeConversation.shellReason),
      messageCount: hasThreadMessages ? nextMessages.length : 0,
      messageCountCanonical: hasThreadMessages ? nextMessages.length : 0,
    };

    setSelected((current) => (
      current && current.conversationId === nextConversation.conversationId
        ? nextConversation
        : current
    ));
    setConversations((current) => current.map((item) => (
      item.conversationId === nextConversation.conversationId
        ? {
            ...item,
            participant: nextConversation.participant,
            messages: nextMessages,
            shell: nextConversation.shell,
            syncState: nextConversation.syncState,
            resolutionState: nextConversation.resolutionState,
            shellReason: nextConversation.shellReason,
            messageCount: nextConversation.messageCount,
            messageCountCanonical: nextConversation.messageCountCanonical,
          }
        : item
    )));

    return { nextConversation, hasThreadMessages };
  }, []);

  const refreshConversationThread = useCallback(async (conversation: Conversation, options: { preservePending?: boolean } = {}) => {
    const isSelectedConversation = selectedRef.current?.conversationId === conversation.conversationId;
    if (isSelectedConversation) {
      setIsThreadLoading(true);
      threadRefreshInFlightRef.current = conversation.conversationId;
    }
    try {
      const thread = await getConversationThread(conversation.accountId, conversation.conversationId);
      return applyThreadResult(conversation, thread, options);
    } finally {
      if (isSelectedConversation && threadRefreshInFlightRef.current === conversation.conversationId) {
        threadRefreshInFlightRef.current = null;
        setIsThreadLoading(false);
      }
    }
  }, [applyThreadResult]);

  const scheduleSelectedThreadRefresh = useCallback((conversation: Conversation, delayMs = 250, options: { preservePending?: boolean } = {}) => {
    if (threadRefreshTimerRef.current) {
      clearTimeout(threadRefreshTimerRef.current);
    }
    threadRefreshTimerRef.current = setTimeout(() => {
      threadRefreshTimerRef.current = null;
      void refreshConversationThread(conversation, options).catch(() => {
        scheduleInboxRefresh(350);
      });
    }, delayMs);
  }, [refreshConversationThread, scheduleInboxRefresh]);

  useEffect(() => {
    void loadInbox();
    
    // Set up WebSocket listeners for real-time updates
    const unsubscribeInboxUpdate = wsClient.on('inbox:updated', () => {
      scheduleInboxRefresh(250);
    });

    const unsubscribeNewMessage = wsClient.on('inbox:new_message', () => {
      scheduleInboxRefresh(250);
    });

    const unsubscribeConversationUpdated = wsClient.on('conversation.updated', (payload?: { conversationId?: string; accountId?: string }) => {
      const selectedConversation = selectedRef.current;
      if (
        selectedConversation &&
        payload?.conversationId &&
        payload.conversationId === selectedConversation.conversationId
      ) {
        scheduleSelectedThreadRefresh(selectedConversation, 200);
        return;
      }
      if (filter !== 'all' && payload?.accountId && payload.accountId !== filter) {
        return;
      }
      scheduleInboxRefresh(300);
    });

    const unsubscribeMessageCreated = wsClient.on('message.created', (payload?: { conversationId?: string; accountId?: string }) => {
      const selectedConversation = selectedRef.current;
      if (
        selectedConversation &&
        payload?.conversationId &&
        payload.conversationId === selectedConversation.conversationId
      ) {
        scheduleSelectedThreadRefresh(selectedConversation, 150);
        return;
      }
      if (filter !== 'all' && payload?.accountId && payload.accountId !== filter) {
        return;
      }
      scheduleInboxRefresh(300);
    });

    const unsubscribeSyncUpdated = wsClient.on('sync:updated', (payload?: { accountId?: string; surface?: string | null }) => {
      if (payload?.surface && payload.surface !== 'inbox') {
        return;
      }
      if (filter !== 'all' && payload?.accountId && payload.accountId !== filter) {
        return;
      }
      scheduleInboxRefresh(650);
    });

    const unsubscribeStatus = wsClient.on('status:changed', (data: StatusChangedPayload) => {
      setIsLive(data.status === 'connected');
    });

    // Set initial status
    setIsLive(wsClient.isConnected);

    return () => {
      unsubscribeInboxUpdate();
      unsubscribeNewMessage();
      unsubscribeConversationUpdated();
      unsubscribeMessageCreated();
      unsubscribeSyncUpdated();
      unsubscribeStatus();
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
      if (threadRefreshTimerRef.current) {
        clearTimeout(threadRefreshTimerRef.current);
      }
    };
  }, [filter, loadInbox, scheduleInboxRefresh, scheduleSelectedThreadRefresh]);

  const filtered =
    (filter === 'all'
      ? conversations
      : conversations.filter((c) => c.accountId === filter))
      .filter((c) => {
        const q = deferredSearch.trim().toLowerCase();
        if (!q) return true;
        return (
          c.participant.name.toLowerCase().includes(q) ||
          c.lastMessage.text.toLowerCase().includes(q) ||
          c.accountId.toLowerCase().includes(q)
        );
      });

  useEffect(() => {
    if (!isLive || accounts.length === 0) return;

    const ids = Array.from(new Set(accounts.map((a) => String(a.id || '').trim()).filter(Boolean)));
    ids.forEach((id) => wsClient.joinAccountRoom(id));

    return () => {
      ids.forEach((id) => wsClient.leaveAccountRoom(id));
    };
  }, [accounts, isLive]);

  useEffect(() => {
    const selectedConversationId = selected?.conversationId;
    if (!selectedConversationId) return;
    const latest = conversations.find((conversation) => conversation.conversationId === selectedConversationId);
    if (!latest) return;

    setSelected((current) => {
      if (!current || current.conversationId !== latest.conversationId) {
        return current;
      }

      const participantName = deriveConversationName({
        name: latest.participant.name,
        profileUrl: latest.participant.profileUrl,
        lastMessageText: latest.lastMessage.text,
        messages: current.messages,
      });
      const participantChanged =
        current.participant.name !== participantName ||
        current.participant.profileUrl !== latest.participant.profileUrl;
      const metadataChanged =
        current.lastMessage.text !== latest.lastMessage.text ||
        current.lastMessage.sentAt !== latest.lastMessage.sentAt ||
        current.lastMessage.sentByMe !== latest.lastMessage.sentByMe ||
        current.messageCount !== latest.messageCount ||
        current.syncState !== latest.syncState ||
        current.shell !== latest.shell ||
        current.shellReason !== latest.shellReason;

      if (!participantChanged && !metadataChanged) {
        return current;
      }

      return {
        ...current,
        participant: {
          ...latest.participant,
          name: participantName,
        },
        accountId: latest.accountId,
        externalId: latest.externalId,
        threadUrl: latest.threadUrl,
        lastMessage: latest.lastMessage,
        unreadCount: latest.unreadCount,
        shell: latest.shell,
        syncState: latest.syncState,
        resolutionState: latest.resolutionState,
        shellReason: latest.shellReason,
        messageCount: latest.messageCount,
        messageCountCanonical: latest.messageCountCanonical,
        lastResolvedAt: latest.lastResolvedAt,
        resolveAttempts: latest.resolveAttempts,
        sourceQuality: latest.sourceQuality,
      };
    });
  }, [conversations, selected?.conversationId]);

  const handleSelect = useCallback(async (conv: Conversation) => {
    setSelected(conv); // immediate optimistic UI update
    const activeConversation = conv;
    try {
      if (conv.shell) {
        setResolvingIds((current) => new Set(current).add(conv.conversationId));
        setSelected({
          ...conv,
          syncState: 'resolving',
          resolutionState: 'resolving',
          shellReason: 'Queued for background resolution. Persisted messages will appear here as soon as the worker finishes.',
        });
        await queueThreadResolution({
          accountId: conv.accountId,
          conversationIds: [conv.conversationId],
          priority: 'visible',
          limit: 1,
          wait: false,
        });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const { hasThreadMessages } = await refreshConversationThread(activeConversation, { preservePending: true });
          if (hasThreadMessages) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
        scheduleInboxRefresh(500);
        return;
      }
      await refreshConversationThread(activeConversation);
    } catch (selectErr) {
      setSelected({
        ...conv,
        syncState: conv.shell ? 'resolving' : 'failed',
        resolutionState: conv.shell ? 'resolving' : 'failed',
        shellReason: conv.shell
          ? 'The worker is still resolving this thread in the background.'
          : (selectErr instanceof Error ? selectErr.message : 'Thread resolution failed'),
      });
    } finally {
      setResolvingIds((current) => {
        const next = new Set(current);
        next.delete(conv.conversationId);
        return next;
      });
    }
  }, [refreshConversationThread, scheduleInboxRefresh]);

  useEffect(() => {
    handleSelectRef.current = handleSelect;
  }, [handleSelect]);

  async function handleResolveVisibleShells() {
    const shellConversations = filtered.filter((conversation) => conversation.shell);
    if (shellConversations.length === 0) return;

    setIsResolving(true);
    try {
      await queueThreadResolution({
        accountId: filter !== 'all' ? filter : undefined,
        conversationIds: shellConversations.slice(0, 25).map((conversation) => conversation.conversationId),
        priority: 'visible',
        limit: 25,
      });
      toast.success(`Queued ${Math.min(shellConversations.length, 25)} visible shell threads for fast resolution`);
      await loadInbox();
    } catch (resolveErr) {
      toast.error(resolveErr instanceof Error ? resolveErr.message : 'Could not queue thread resolution');
    } finally {
      setIsResolving(false);
    }
  }

  async function handleRetryFailed() {
    const failedConversations = filtered.filter((conversation) => conversation.syncState === 'failed');
    if (failedConversations.length === 0) return;

    setIsResolving(true);
    try {
      await queueThreadResolution({
        accountId: filter !== 'all' ? filter : undefined,
        conversationIds: failedConversations.slice(0, 25).map((conversation) => conversation.conversationId),
        priority: 'visible',
        limit: 25,
      });
      toast.success(`Queued ${Math.min(failedConversations.length, 25)} failed threads for retry`);
      await loadInbox();
    } catch (retryErr) {
      toast.error(retryErr instanceof Error ? retryErr.message : 'Could not queue failed thread retry');
    } finally {
      setIsResolving(false);
    }
  }

  async function handleSyncLatest() {
    setIsSyncing(true);
    try {
      await queueUnifiedSync('delta');
      toast.success('Queued latest inbox sync');
      await loadInbox();
    } catch (syncErr) {
      toast.error(syncErr instanceof Error ? syncErr.message : 'Could not queue inbox sync');
    } finally {
      setIsSyncing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3">
        <Spinner size="lg" />
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Fetching messages from all accounts...
        </p>
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={loadInbox} />;
  }

  const shellBacklog = filtered.filter((conversation) => conversation.shell).length;
  const resolvedCount = filtered.filter((conversation) => (conversation.messageCountCanonical || conversation.messageCount || 0) > 0 || conversation.syncState === 'available').length;
  const failingCount = filtered.filter((conversation) => conversation.syncState === 'failed').length;
  const resolvingCount = filtered.filter((conversation) => conversation.syncState === 'resolving' || resolvingIds.has(conversation.conversationId)).length;
  const visibleMessageCount = filtered.reduce((sum, conversation) => sum + (conversation.messageCountCanonical || conversation.messageCount || conversation.messages.length || 0), 0);
  const lastResolveError = filtered.find((conversation) => conversation.syncState === 'failed' && conversation.shellReason)?.shellReason;

  return (
    <div className="flex h-[calc(100vh-3.5rem-4rem)] min-h-[640px] flex-col lg:h-screen lg:min-h-0">
      <PageHeader
        title="Inbox"
        description="Unified conversations across every configured LinkedIn account."
        actions={
          <>
            <StatusPill tone={isLive ? 'success' : 'neutral'} dot>{isLive ? 'Live' : 'Offline'}</StatusPill>
            <Button variant="secondary" onClick={() => void loadInbox()} disabled={loading || isResolving || isSyncing}>
              <RefreshCcw size={16} />
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => void handleSyncLatest()} disabled={isSyncing || isResolving}>
              <TimerReset size={16} />
              Sync latest
            </Button>
            <Button onClick={() => void handleResolveVisibleShells()} disabled={isResolving || shellBacklog === 0}>
              <Zap size={16} />
              Resolve visible shells
            </Button>
            <Button variant="secondary" onClick={() => void handleRetryFailed()} disabled={isResolving || failingCount === 0}>
              <RotateCcw size={16} />
              Retry failed
            </Button>
          <ExportButton 
            type="messages" 
            accountId={filter !== 'all' ? filter : undefined}
            label="Export"
            size="sm"
          />
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-hidden border-t border-[var(--border)] lg:border-t-0">
        <div className="flex h-full min-h-0 flex-col">
        <div className="grid shrink-0 gap-3 border-b border-[var(--border)] bg-[var(--bg-panel)] px-4 py-3 sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Shell backlog</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{shellBacklog}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">visible threads still missing a concrete LinkedIn thread</p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Resolved</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{resolvedCount}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">visible conversations with real thread data</p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Resolving</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{resolvingCount}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">threads currently in a repair pass</p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Messages captured</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{visibleMessageCount}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">persisted across the visible inbox</p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Resolve failures</p>
            <p className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{failingCount}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">threads that need a fresh pass or a new session</p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
            <div className="flex items-center gap-2 text-[var(--warning)]">
              <AlertTriangle size={14} />
              <p className="text-[10px] uppercase tracking-[0.12em]">Last error</p>
            </div>
            <p className="mt-2 line-clamp-2 text-xs text-[var(--text-muted)]">{lastResolveError || 'No active thread-resolution error'}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[390px_minmax(0,1fr)]">
          <div className={cn('min-h-0 overflow-hidden border-r border-[var(--border)] lg:block', selected && 'hidden lg:block')}>
            <ConversationList
              conversations={filtered}
              accounts={accounts}
              selected={selected}
              filter={filter}
              search={search}
              onSearchChange={setSearch}
              onFilterChange={setFilter}
              onSelect={handleSelect}
              resolvingIds={resolvingIds}
            />
          </div>
          <div className={cn('min-h-0 overflow-hidden lg:block', !selected && 'hidden lg:block')}>
            <MessageThread
              conversation={selected}
              loading={isThreadLoading}
              onBack={() => setSelected(null)}
              onMessageSent={(updatedConv) => {
                setConversations((prev) =>
                  prev.map((c) =>
                    c.conversationId === updatedConv.conversationId ? updatedConv : c
                  )
                );
                setSelected(updatedConv);
              }}
            />
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
