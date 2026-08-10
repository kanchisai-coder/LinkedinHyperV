'use client';

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Conversation, Account } from '@/types/dashboard';
import { Avatar } from '@/components/ui/Avatar';
import { UnreadBadge } from '@/components/ui/UnreadBadge';
import { AccountBadge } from '@/components/ui/AccountBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterBar } from '@/components/ui/FilterBar';
import { StatusPill } from '@/components/ui/StatusPill';
import { formatRelativeTime } from '@/lib/time-utils';
import { deriveConversationName } from '@/lib/display-name';
import { Inbox, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ConversationListProps {
  conversations: Conversation[];
  accounts: Account[];
  selected: Conversation | null;
  filter: string;
  search: string;
  onSearchChange: (q: string) => void;
  onFilterChange: (f: string) => void;
  onSelect: (conv: Conversation) => void;
  resolvingIds?: Set<string>;
}

export const ConversationList = memo(function ConversationList({
  conversations,
  accounts,
  selected,
  filter,
  search,
  onSearchChange,
  onFilterChange,
  onSelect,
  resolvingIds,
}: ConversationListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const totalUnread = conversations.reduce((sum, conversation) => sum + (conversation.unreadCount ?? 0), 0);
  const shouldVirtualize = conversations.length > 200;
  const rowHeight = 132;
  const overscan = 6;
  const filterOptions = [
    { value: 'all', label: 'All', count: conversations.length },
    ...accounts.map((account) => ({
      value: account.id,
      label: account.displayName || account.id,
      count: conversations.filter((conversation) => conversation.accountId === account.id).length,
    })),
  ];

  useEffect(() => {
    if (!shouldVirtualize || !scrollRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }

    const element = scrollRef.current;
    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect?.height || element.clientHeight;
      if (nextHeight) {
        setViewportHeight(nextHeight);
      }
    });
    // observe() fires the callback once with the initial size, so the first
    // measurement is delivered there rather than set synchronously here.
    observer.observe(element);
    return () => observer.disconnect();
  }, [shouldVirtualize]);

  const virtualWindow = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        startIndex: 0,
        endIndex: conversations.length,
        items: conversations,
        offsetY: 0,
        totalHeight: 0,
      };
    }

    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const endIndex = Math.min(
      conversations.length,
      startIndex + visibleCount + (overscan * 2),
    );
    return {
      startIndex,
      endIndex,
      items: conversations.slice(startIndex, endIndex),
      offsetY: startIndex * rowHeight,
      totalHeight: conversations.length * rowHeight,
    };
  }, [conversations, overscan, rowHeight, scrollTop, shouldVirtualize, viewportHeight]);

  function renderConversation(conversation: Conversation, style?: CSSProperties) {
    const isSelected = conversation.conversationId === selected?.conversationId;
    const timeString = formatRelativeTime(conversation.lastMessage.sentAt);
    const hasUnread = conversation.unreadCount > 0;
    const isResolving = conversation.resolutionState === 'resolving' || conversation.syncState === 'resolving' || resolvingIds?.has(conversation.conversationId);
    const participantName = deriveConversationName({
      name: conversation.participant.name,
      profileUrl: conversation.participant.profileUrl,
      lastMessageText: conversation.lastMessage.text,
      messages: conversation.messages,
    });

    return (
      <button
        key={conversation.conversationId}
        onClick={() => onSelect(conversation)}
        style={style}
        className={cn(
          'mb-2 flex w-full items-start gap-3 rounded-2xl border p-3.5 text-left shadow-sm transition-all',
          shouldVirtualize && 'h-[124px] overflow-hidden',
          isSelected
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-[0_10px_30px_rgba(14,165,233,0.12)]'
            : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]'
        )}
      >
        <div className="relative shrink-0">
          <Avatar name={participantName} size="md" />
          {hasUnread && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-[var(--accent)]" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={cn('truncate text-sm text-[var(--text-primary)]', hasUnread ? 'font-bold' : 'font-semibold')}>
              {participantName}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{timeString}</span>
          </div>

          <div className="mt-1 flex items-center gap-2">
            <p className={cn('min-w-0 flex-1 truncate text-xs', hasUnread ? 'font-semibold text-[var(--text-secondary)]' : 'text-[var(--text-muted)]')}>
              {conversation.lastMessage.sentByMe ? 'You: ' : ''}
              {conversation.lastMessage.text}
            </p>
            {typeof (conversation.messageCountCanonical ?? conversation.messageCount) === 'number' && (conversation.messageCountCanonical ?? conversation.messageCount)! > 0 && (
              <span className="shrink-0 text-[11px] text-[var(--text-faint)]">{conversation.messageCountCanonical ?? conversation.messageCount} msg</span>
            )}
          </div>

          <div className="mt-2">
            <div className="flex items-center justify-between gap-2">
              <AccountBadge name={conversation.accountId} />
              {hasUnread ? <UnreadBadge count={conversation.unreadCount} color="blue" /> : <span className="text-[11px] text-[var(--text-faint)]">Read</span>}
            </div>
            {isResolving && (
              <div className="mt-2">
                <StatusPill tone="neutral">Resolving</StatusPill>
              </div>
            )}
            {!isResolving && conversation.shell && (
              <div className="mt-2">
                <StatusPill tone="warning">Thread shell only</StatusPill>
              </div>
            )}
            {!isResolving && (conversation.resolutionState === 'failed' || conversation.syncState === 'failed') && (
              <div className="mt-2">
                <StatusPill tone="danger">Resolve failed</StatusPill>
              </div>
            )}
          </div>
        </div>
      </button>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-panel)]">
      <div className="border-b border-[var(--border)] bg-[var(--bg-panel)]/95 p-4 backdrop-blur">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="app-kicker">LinkedIn Inbox</p>
            <h2 className="mt-1 text-base font-semibold text-[var(--text-primary)]">Conversations</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {conversations.length} conversation{conversations.length === 1 ? '' : 's'} mirrored across connected accounts
            </p>
          </div>
          <div className="grid min-w-[116px] grid-cols-2 gap-2">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Unread</p>
              <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{totalUnread}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Live</p>
              <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{accounts.length}</p>
            </div>
          </div>
        </div>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search people, previews, or account IDs"
            className="app-input h-10 pl-9 pr-3 text-sm"
          />
        </div>
        {accounts.length > 0 && <FilterBar options={filterOptions} value={filter} onChange={onFilterChange} className="mt-3" />}
      </div>

      <div
        ref={scrollRef}
        onScroll={shouldVirtualize ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
        className="min-h-0 flex-1 overflow-y-auto p-2.5"
      >
        {conversations.length === 0 ? (
          <EmptyState compact icon={<Inbox size={22} />} title="No messages found" description="Try a different search or account filter." />
        ) : shouldVirtualize ? (
          <div style={{ height: virtualWindow.totalHeight, position: 'relative' }}>
            <div
              style={{
                transform: `translateY(${virtualWindow.offsetY}px)`,
              }}
            >
              {virtualWindow.items.map((conversation) => renderConversation(conversation))}
            </div>
          </div>
        ) : (
          conversations.map((conversation) => renderConversation(conversation))
        )}
      </div>
    </div>
  );
});
