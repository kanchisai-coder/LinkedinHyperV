import { StatusPill } from '@/components/ui/StatusPill';

interface SessionStatusProps {
  isActive: boolean;
  hasSession: boolean;
  lastSeen: string | number | null;
  sessionStatus?: string | null;
  liveReachability?: string | null;
}

export function SessionStatus({ isActive, hasSession, lastSeen, sessionStatus, liveReachability }: SessionStatusProps) {
  const status = (() => {
    if (sessionStatus === 'pending_login') return { label: 'Connecting', tone: 'info' as const };
    if (sessionStatus === 'connect_failed') return { label: 'Failed', tone: 'danger' as const };
    if (sessionStatus === 'checkpoint') return { label: 'Checkpoint', tone: 'warning' as const };
    if (sessionStatus === 'restricted' || liveReachability === 'automation_warning') return { label: 'Restricted', tone: 'danger' as const };
    if (sessionStatus === 'expired' || liveReachability === 'login_redirect') return { label: 'Reconnect', tone: 'warning' as const };
    if (isActive && hasSession) return { label: 'Active', tone: 'success' as const };
    if (hasSession) return { label: 'Needs verify', tone: 'warning' as const };
    return { label: 'No session', tone: 'warning' as const };
  })();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone={status.tone} dot>{status.label}</StatusPill>
      {lastSeen && <span className="text-xs text-[var(--text-muted)]">Last seen {formatTimestamp(lastSeen)}</span>}
    </div>
  );
}

function formatTimestamp(timestamp: string | number): string {
  const date = new Date(timestamp);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
