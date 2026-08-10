'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { UnifiedAccount, UnifiedNotification } from '@/types/dashboard';
import { getUnifiedAccounts, getUnifiedNotifications } from '@/lib/api-client';
import { AccountBadge } from '@/components/ui/AccountBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterBar } from '@/components/ui/FilterBar';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusPill } from '@/components/ui/StatusPill';
import { Bell, ExternalLink } from 'lucide-react';
import { timeAgo } from '@/lib/utils';

const SURFACE_LABELS: Record<string, string> = {
  inbox: 'Inbox',
  message: 'Message',
  connection: 'Connection',
  invitation: 'Invitation',
  notification: 'Notification',
  post: 'Post',
  profile: 'Profile',
  sync: 'Sync',
};

export default function NotificationsPage() {
  const [entries, setEntries] = useState<UnifiedNotification[]>([]);
  const [accounts, setAccounts] = useState<UnifiedAccount[]>([]);
  const [tab, setTab] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ accounts: accs }, { notifications }] = await Promise.all([
        getUnifiedAccounts(),
        getUnifiedNotifications(250),
      ]);
      setAccounts(accs);
      setEntries(
        [...notifications].sort(
          (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
        )
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const typeOptions = useMemo(() => {
    const counts = entries.reduce<Record<string, number>>((map, entry) => {
      const key = entry.type || 'notification';
      map[key] = (map[key] || 0) + 1;
      return map;
    }, {});

    return [
      { value: 'all', label: 'All', count: entries.length },
      ...Object.entries(counts).map(([value, count]) => ({
        value,
        label: SURFACE_LABELS[value] || value,
        count,
      })),
    ];
  }, [entries]);

  const filtered = tab === 'all' ? entries : entries.filter((entry) => entry.type === tab);

  if (loading) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <div className="min-h-full">
      <PageHeader
        eyebrow="LinkedIn Events"
        title="Activity"
        description={`${entries.length.toLocaleString()} stored LinkedIn notification${entries.length === 1 ? '' : 's'} with source account provenance and freshness signals.`}
        actions={<StatusPill tone="info" dot>Unified feed</StatusPill>}
      />

      <div className="mx-auto max-w-[1440px] space-y-4 px-4 py-5 sm:px-6 lg:px-8">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="app-surface p-4">
            <FilterBar options={typeOptions} value={tab} onChange={setTab} />
          </div>
          <div className="app-surface p-4">
            <p className="app-kicker">Accounts in play</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {accounts.length > 0 ? (
                accounts.map((account) => (
                  <AccountBadge key={account.id} name={account.displayName || account.id} />
                ))
              ) : (
                <span className="text-sm text-[var(--text-muted)]">No connected accounts yet</span>
              )}
            </div>
          </div>
        </div>

        <div className="app-surface overflow-hidden">
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Bell size={22} />}
              title="No LinkedIn events yet"
              description="When inbox, invitations, and alerts are mirrored, they will appear here with honest coverage state."
            />
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {filtered.map((entry) => (
                <div key={entry.id} className="grid gap-3 px-4 py-4 transition-colors hover:bg-[var(--bg-hover)] sm:grid-cols-[1fr_auto] sm:px-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone="info">{SURFACE_LABELS[entry.type] || entry.type}</StatusPill>
                      <AccountBadge name={entry.accountId} />
                    </div>
                    <h3 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">{entry.title}</h3>
                    {entry.text && <p className="mt-1 text-sm text-[var(--text-secondary)]">{entry.text}</p>}
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
                      <span>{timeAgo(new Date(entry.occurredAt).getTime())}</span>
                      <span className="h-1 w-1 rounded-full bg-[var(--text-faint)]" />
                      <span>Captured from LinkedIn session data</span>
                    </div>
                    {entry.url && (
                      <a href={entry.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)]">
                        <ExternalLink size={14} />
                        Open source item
                      </a>
                    )}
                  </div>
                  <div className="sm:pt-1">
                    <StatusPill tone="success">Recorded</StatusPill>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
