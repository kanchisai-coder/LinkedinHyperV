'use client';

import { useState } from 'react';
import { SessionStatus } from './SessionStatus';
import { RateLimitBar } from '../dashboard/RateLimitBar';
import { Button } from '@/components/ui/Button';
import { Loader2, LogIn, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Account } from '@/types/dashboard';

interface RateLimits {
  messagesSent?: { current: number; limit: number; resetsAt?: number };
  connectRequests?: { current: number; limit: number; resetsAt?: number };
  searchQueries?: { current: number; limit: number; resetsAt?: number };
}

interface AccountCardProps {
  account: Account;
  onRefresh: () => void;
  onImport: (accountId: string) => void;
  onConnect: (accountId: string) => void;
}

export function AccountCard({ account, onRefresh, onImport, onConnect }: AccountCardProps) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [isRemovingSession, setIsRemovingSession] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [rateLimits, setRateLimits] = useState<RateLimits | null>(null);
  const [limitsLoading, setLimitsLoading] = useState(false);
  const stateLabel = (() => {
    if (account.sessionStatus === 'pending_login') return 'Connecting';
    if (account.sessionStatus === 'connect_failed') return 'Needs retry';
    if (account.sessionStatus === 'checkpoint') return 'Checkpoint';
    if (account.sessionStatus === 'restricted' || account.liveReachability === 'automation_warning') return 'Restricted';
    if (account.sessionStatus === 'expired' || account.liveReachability === 'login_redirect') return 'Reconnect';
    if (account.liveReachability === 'unknown' && account.lastSeen) return 'Needs verify';
    if (account.isActive) return 'Connected';
    return 'Idle';
  })();

  const loadRateLimits = async () => {
    setLimitsLoading(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}/limits`);
      if (res.ok) setRateLimits(await res.json());
    } catch {
      toast.error('Failed to load rate limits');
    } finally {
      setLimitsLoading(false);
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}/verify`, { method: 'POST' });
      if (res.ok) {
        toast.success(`Session verified for ${account.id}`);
        onRefresh();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Verification failed');
      }
    } catch {
      toast.error('Network error during verification');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleRemoveSession = async () => {
    if (!confirm(`Remove the saved LinkedIn session for ${account.id}? Mirrored data will stay available.`)) return;

    setIsRemovingSession(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}/session`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(`Session removed for ${account.id}`);
        onRefresh();
      } else {
        toast.error('Failed to remove session');
      }
    } catch {
      toast.error('Network error while removing session');
    } finally {
      setIsRemovingSession(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!confirm(`Delete account ${account.id}? This removes the saved session and all mirrored LinkedIn data for this account.`)) return;

    setIsDeletingAccount(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(`Account deleted for ${account.id}`);
        onRefresh();
      } else {
        toast.error('Failed to delete account');
      }
    } catch {
      toast.error('Network error while deleting account');
    } finally {
      setIsDeletingAccount(false);
    }
  };

  return (
    <div className="app-surface flex flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="app-kicker">LinkedIn Session</p>
          <h3 className="truncate text-base font-semibold text-[var(--text-primary)]">{account.displayName || account.id}</h3>
          <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{account.id}</p>
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-sm font-bold text-white">
          {(account.displayName || account.id).substring(0, 2).toUpperCase()}
        </div>
      </div>

      <div className="mt-4">
        <SessionStatus
          isActive={account.isActive}
          hasSession={!!account.lastSeen}
          lastSeen={account.lastSeen}
          sessionStatus={account.sessionStatus}
          liveReachability={account.liveReachability}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-faint)]">State</p>
          <p className="mt-2 text-sm font-semibold text-[var(--text-primary)]">{stateLabel}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Last seen</p>
          <p className="mt-2 text-sm font-semibold text-[var(--text-primary)]">
            {account.liveReachability === 'reachable' ? 'Reachable' : account.lastSeen ? 'Stored only' : 'No session'}
          </p>
        </div>
      </div>

      <div className="mt-5 flex-1 rounded-2xl border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
        {!rateLimits && !limitsLoading && (
          <button onClick={loadRateLimits} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-strong)] px-3 py-6 text-sm font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)]">
            <ShieldCheck size={16} />
            Load rate limits
          </button>
        )}

        {limitsLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--text-muted)]">
            <Loader2 size={16} className="animate-spin" />
            Loading limits
          </div>
        )}

        {rateLimits && (
          <div className="space-y-4">
            {rateLimits.messagesSent && <RateLimitBar label="Messages" current={rateLimits.messagesSent.current} limit={rateLimits.messagesSent.limit} resetsAt={rateLimits.messagesSent.resetsAt} />}
            {rateLimits.connectRequests && <RateLimitBar label="Connection requests" current={rateLimits.connectRequests.current} limit={rateLimits.connectRequests.limit} resetsAt={rateLimits.connectRequests.resetsAt} />}
            {rateLimits.searchQueries && <RateLimitBar label="Search queries" current={rateLimits.searchQueries.current} limit={rateLimits.searchQueries.limit} resetsAt={rateLimits.searchQueries.resetsAt} />}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--border)] pt-4">
        <Button onClick={() => onConnect(account.id)} variant="secondary" size="sm">
          <LogIn size={14} />
          Connect
        </Button>
        <Button onClick={() => onImport(account.id)} variant="primary" size="sm">
          <Upload size={14} />
          Cookies
        </Button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button onClick={handleVerify} disabled={isVerifying} variant="ghost" size="sm" aria-label="Verify session">
          {isVerifying ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Verify
        </Button>
        <Button onClick={handleRemoveSession} disabled={isRemovingSession} variant="ghost" size="sm" aria-label="Remove session">
          {isRemovingSession ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
          Remove session
        </Button>
      </div>

      <Button
        onClick={handleDeleteAccount}
        disabled={isDeletingAccount}
        variant="danger"
        size="sm"
        className="mt-2 w-full"
        aria-label="Delete account"
      >
        {isDeletingAccount ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
        Delete account
      </Button>
    </div>
  );
}
