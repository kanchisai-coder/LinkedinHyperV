'use client';

import { useRef, useEffect, useState } from 'react';
import type { Conversation, Message } from '@/types/dashboard';
import { Avatar } from '@/components/ui/Avatar';
import { AccountBadge } from '@/components/ui/AccountBadge';
import { StatusPill } from '@/components/ui/StatusPill';
import { MessageThreadSkeleton } from '@/components/ui/SkeletonLoader';
import { ReplyInput } from '@/components/inbox/ReplyInput';
import { sendMessage } from '@/lib/api-client';
import { deriveConversationName } from '@/lib/display-name';
import { formatRelativeTime } from '@/lib/time-utils';
import { ArrowLeft, CheckCheck, LoaderCircle, MessageSquare } from 'lucide-react';
import toast from 'react-hot-toast';

interface MessageThreadProps {
  conversation: Conversation | null;
  loading?: boolean;
  onMessageSent: (updated: Conversation) => void;
  onBack?: () => void;
}

export function MessageThread({ conversation, loading = false, onMessageSent, onBack }: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const previousConversationRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  const autoScrollResetRef = useRef<string | null>(null);

  // Re-enable auto-scroll when the open conversation changes. Adjusting state
  // during render (rather than in an effect) is the React-recommended pattern
  // and avoids an extra render pass before the scroll effect runs.
  const currentConversationId = conversation?.conversationId || null;
  if (autoScrollResetRef.current !== currentConversationId) {
    autoScrollResetRef.current = currentConversationId;
    setAutoScroll(true);
  }

  useEffect(() => {
    const conversationId = conversation?.conversationId || null;
    const messageCount = conversation?.messages.length || 0;
    const conversationChanged = previousConversationRef.current !== conversationId;
    const receivedNewMessages = messageCount > previousMessageCountRef.current;

    if ((conversationChanged || receivedNewMessages) && autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: conversationChanged ? 'auto' : 'smooth' });
    }
    previousConversationRef.current = conversationId;
    previousMessageCountRef.current = messageCount;
  }, [conversation?.conversationId, conversation?.messages.length, autoScroll]);

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    setAutoScroll(isNearBottom);
  };

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[var(--bg-panel)]">
        <div className="animate-fade-in px-6 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <MessageSquare size={28} />
          </div>
          <p className="mb-2 text-lg font-semibold text-[var(--text-primary)]">
            Select a conversation
          </p>
          <p className="text-sm text-[var(--text-muted)]">
            Choose from the left panel to start messaging
          </p>
        </div>
      </div>
    );
  }

  const activeConversation: Conversation = conversation;
  const { participant, accountId, messages } = activeConversation;
  const participantName = deriveConversationName({
    name: participant.name,
    profileUrl: participant.profileUrl,
    lastMessageText: activeConversation.lastMessage?.text || '',
    messages,
  });
  const resolutionState = conversation.resolutionState || conversation.syncState;
  const isUnresolved = conversation.shell || resolutionState === 'resolving' || resolutionState === 'failed' || resolutionState === 'shell_only' || resolutionState === 'partial';
  const isResolving = resolutionState === 'resolving';
  const isFailed = resolutionState === 'failed';
  const shouldShowLoadingState = (loading || isUnresolved) && messages.length === 0;

  async function handleSend(text: string) {
    const optimistic: Message = {
      id: `opt-${Date.now()}`,
      text,
      sentAt: Date.now(),
      sentByMe: true,
      senderName: accountId,
      deliveryState: 'accepted',
    };

    const updatedConversation: Conversation = {
      ...activeConversation,
      messages: [...activeConversation.messages, optimistic],
      lastMessage: { text, sentAt: Date.now(), sentByMe: true },
    };

    onMessageSent(updatedConversation);

    try {
      const result = await sendMessage(accountId, activeConversation.conversationId, text);
      const deliveryState = result.deliveryState || 'accepted';

      onMessageSent({
        ...updatedConversation,
        messages: updatedConversation.messages.map((message) => (
          message.id === optimistic.id
            ? {
                ...message,
                id: result.id || message.id,
                deliveryState,
                sentAt: result.createdAt
                  ? (Number.isFinite(new Date(result.createdAt).getTime())
                    ? new Date(result.createdAt).getTime()
                    : message.sentAt)
                  : message.sentAt,
              }
            : message
        )),
      });

      if (deliveryState === 'accepted_unverified') {
        toast('Message sent on LinkedIn, waiting for sync confirmation.', {
          icon: '!',
        });
      }
    } catch (error) {
      const withoutOptimistic = updatedConversation.messages.filter((m) => m.id !== optimistic.id);
      const fallbackLast = withoutOptimistic[withoutOptimistic.length - 1];

      onMessageSent({
        ...updatedConversation,
        messages: withoutOptimistic,
        lastMessage: fallbackLast
          ? {
            text: fallbackLast.text,
              sentAt: fallbackLast.sentAt ?? Date.now(),
              sentByMe: fallbackLast.sentByMe,
            }
          : activeConversation.lastMessage,
      });

      toast.error(error instanceof Error ? error.message : 'Failed to send message');
    }
  }

  const groupedMessages = groupConsecutiveMessages(messages);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-panel)]">
      <div
        className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-panel)] px-4 py-3 sm:px-5"
      >
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] lg:hidden" aria-label="Back to conversations">
              <ArrowLeft size={18} />
            </button>
          )}
          <Avatar name={participantName} size="md" />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[var(--text-primary)]">
              {participantName}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-xs text-[var(--text-muted)]">
                {(conversation.messageCountCanonical || conversation.messageCount || messages.length)} {((conversation.messageCountCanonical || conversation.messageCount || messages.length) === 1) ? 'message' : 'messages'}
              </p>
              <span className="hidden h-1 w-1 rounded-full bg-[var(--text-faint)] sm:inline-block" />
              <p className="hidden text-xs text-[var(--text-faint)] sm:block">Unified LinkedIn thread</p>
              {isResolving && <StatusPill tone="neutral">Resolving</StatusPill>}
              {!isResolving && conversation.shell && <StatusPill tone="warning">Shell</StatusPill>}
              {isFailed && <StatusPill tone="danger">Retry needed</StatusPill>}
            </div>
          </div>
        </div>
        <AccountBadge name={accountId} />
      </div>

      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--bg-base)] px-4 py-5 sm:px-6"
      >
        {shouldShowLoadingState && (
          <div className="mb-4 rounded-3xl border border-[var(--border)] bg-[var(--bg-panel)] p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-3 text-[var(--text-secondary)]">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <LoaderCircle size={18} className="animate-spin" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  {isFailed ? 'Reloading thread messages' : 'Loading LinkedIn messages'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {isFailed
                    ? 'The last pass did not finish cleanly. We are waiting for a fresh thread read.'
                    : 'This thread is being resolved in the background and will appear here automatically.'}
                </p>
              </div>
            </div>
            <MessageThreadSkeleton />
          </div>
        )}
        {!shouldShowLoadingState && (loading || isUnresolved) && (
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2 text-xs text-[var(--text-muted)]">
            <LoaderCircle size={14} className="animate-spin text-[var(--accent)]" />
            <span>{isFailed ? 'Refreshing thread messages...' : 'Loading newer messages...'}</span>
          </div>
        )}
        {groupedMessages.map((group, groupIndex) => (
          <MessageGroup
            key={groupIndex}
            messages={group.messages}
            isSentByMe={group.isSentByMe}
            senderName={group.senderName}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="absolute bottom-24 right-5 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white shadow-md transition-colors hover:bg-[var(--accent-hover)]"
        >
          Jump to latest
        </button>
      )}

      <ReplyInput
        onSend={handleSend}
        disabled={isUnresolved}
        disabledReason={isFailed ? 'Retry thread resolution before sending a message.' : 'Resolve this LinkedIn thread before sending a message.'}
      />
    </div>
  );
}

function groupConsecutiveMessages(
  messages: Message[]
): Array<{ messages: Message[]; isSentByMe: boolean; senderName: string }> {
  const groups: Array<{ messages: Message[]; isSentByMe: boolean; senderName: string }> = [];

  messages.forEach((message) => {
    const lastGroup = groups[groups.length - 1];
    if (
      lastGroup &&
      lastGroup.isSentByMe === message.sentByMe &&
      lastGroup.senderName === message.senderName
    ) {
      lastGroup.messages.push(message);
    } else {
      groups.push({
        messages: [message],
        isSentByMe: message.sentByMe,
        senderName: message.senderName,
      });
    }
  });

  return groups;
}

function MessageGroup({
  messages,
  isSentByMe,
  senderName,
}: {
  messages: Message[];
  isSentByMe: boolean;
  senderName: string;
}) {
  return (
    <div className={`mb-6 flex gap-3 ${isSentByMe ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className="flex-shrink-0">
        <Avatar name={senderName} size="sm" />
      </div>

      <div className={`flex max-w-[84%] flex-col gap-1.5 sm:max-w-[72%] ${isSentByMe ? 'items-end' : 'items-start'}`}>
        <span className="mb-1 px-2 text-xs font-medium text-[var(--text-muted)]">
          {senderName}
        </span>

        {messages.map((message, index) => (
          <MessageBubble
            key={message.id}
            message={message}
            isSentByMe={isSentByMe}
            isLast={index === messages.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isSentByMe,
  isLast,
}: {
  message: Message;
  isSentByMe: boolean;
  isLast: boolean;
}) {
  const { text, sentAt } = message;
  const timeLabel = sentAt ? formatRelativeTime(sentAt) : 'Time unknown';

  return (
    <div className="w-full animate-fade-in">
      <div
        className={`inline-block border px-4 py-3 text-sm leading-relaxed shadow-sm transition-all ${
          isSentByMe ? 'rounded-2xl rounded-br-sm border-transparent' : 'rounded-2xl rounded-bl-sm border-[var(--border)]'
        }`}
        style={{
          background: isSentByMe ? 'var(--accent)' : 'var(--bg-panel)',
          color: isSentByMe ? '#ffffff' : 'var(--text-primary)',
          maxWidth: '100%',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
        }}
      >
        {text}
      </div>

      {isLast && (
        <div className={`flex items-center gap-1 mt-1 px-2 ${isSentByMe ? 'justify-end' : 'justify-start'}`}>
          <span className="text-xs text-[var(--text-muted)]">
            {timeLabel}
          </span>
          {isSentByMe && <CheckCheck size={14} className="text-[var(--accent)]" />}
        </div>
      )}
    </div>
  );
}
