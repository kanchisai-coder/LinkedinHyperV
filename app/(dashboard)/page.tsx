// FILE: app/(dashboard)/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MessageSquareText, RefreshCcw, ShieldCheck } from 'lucide-react';
import type { ActivityEntry, SyncCursor, SyncRun, UnifiedAccount } from '@/types/dashboard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill } from '@/components/ui/StatusPill';
import { getAccountActivity, getUnifiedAccounts, getUnifiedInbox, getUnifiedSyncStatus, queueUnifiedSync } from '@/lib/api-client';

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<UnifiedAccount[]>([]);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [cursors, setCursors] = useState<SyncCursor[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [stats, setStats] = useState({
    conversations: 0,
    activeAccounts: 0,
    healthySurfaces: 0,
    blockedSurfaces: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    void fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      const [{ accounts: accountsList }, { conversations }, syncStatus] = await Promise.all([
        getUnifiedAccounts(),
        getUnifiedInbox(),
        getUnifiedSyncStatus(),
      ]);
      setAccounts(accountsList);
      setCursors(syncStatus.cursors || []);
      setRuns(syncStatus.runs || []);

      setStats({
        conversations: conversations.length,
        activeAccounts: accountsList.filter((account) => account.hasSession).length,
        healthySurfaces: syncStatus.cursors.filter((cursor) => cursor.coverage === 'available').length,
        blockedSurfaces: syncStatus.cursors.filter((cursor) => cursor.coverage === 'blocked').length,
      });

      const activitiesPromises = accountsList.map((account: UnifiedAccount) =>
        getAccountActivity(account.id, 0, 4)
      );

      const activitiesResults = await Promise.allSettled(activitiesPromises);
      const allActivities: ActivityEntry[] = [];

      activitiesResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.entries) {
          allActivities.push(...result.value.entries);
        }
      });

      allActivities.sort((a, b) => b.timestamp - a.timestamp);
      setActivities(allActivities.slice(0, 8));
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  async function handleSync() {
    setIsSyncing(true);
    try {
      await queueUnifiedSync('delta');
      await fetchDashboardData();
    } finally {
      setIsSyncing(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <div className="text-center">
          <Loader2 size={32} className="animate-spin mx-auto mb-2" style={{ color: 'var(--accent)' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading dashboard...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <PageHeader
        eyebrow="LinkedIn Intelligence"
        title="Control center"
        description="One operating view for session health, LinkedIn coverage, recent sync behavior, and the conversations worth opening next."
        actions={
          <button className="app-button app-button-secondary h-10 px-4 text-sm" onClick={() => void fetchDashboardData()} disabled={isSyncing}>
            <RefreshCcw size={16} />
            Refresh
          </button>
        }
      />
      <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
        <div className="app-surface-dark app-gradient-border overflow-hidden rounded-[28px] p-6 sm:p-7">
          <div className="grid gap-6 lg:grid-cols-[1.3fr_0.9fr]">
            <div className="space-y-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-300">LinkedIn mirror status</p>
                <h2 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Capture more, poll less.</h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                  The console is tuned for LinkedIn-only data: adaptive deltas for active accounts, slower backfills for history, and clear visibility into what is available, stale, planned, or blocked.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <button className="app-button app-button-primary h-11 px-5 text-sm" onClick={() => void handleSync()} disabled={isSyncing}>
                  <MessageSquareText size={16} />
                  {isSyncing ? 'Syncing now' : 'Run delta sync'}
                </button>
                <div className="rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm text-slate-200">
                  {runs[0]?.surface ? `Last run: ${runs[0].surface} via ${runs[0].lane}` : 'No sync runs recorded yet'}
                </div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricCard icon={MessageSquareText} label="Conversations" value={stats.conversations} tone="info" />
              <MetricCard icon={ShieldCheck} label="Session-ready accounts" value={stats.activeAccounts} tone="success" />
              <MetricCard icon={CheckCircle2} label="Healthy surfaces" value={stats.healthySurfaces} tone="success" />
              <MetricCard icon={AlertTriangle} label="Blocked surfaces" value={stats.blockedSurfaces} tone="warning" />
            </div>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <Card className="p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h3 className="app-section-title">Account readiness</h3>
              <p className="mt-1 text-sm text-[var(--text-muted)]">LinkedIn sessions, sync posture, and backoff visibility.</p>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {accounts.length === 0 ? (
                <EmptyState title="No connected LinkedIn accounts" description="Import at least one session to start building a unified mirror." compact />
              ) : accounts.map((account) => {
                const accountCursors = cursors.filter((cursor) => cursor.accountId === account.id);
                const available = accountCursors.filter((cursor) => cursor.coverage === 'available').length;
                const blocked = accountCursors.filter((cursor) => cursor.coverage === 'blocked').length;
                return (
                  <div key={account.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_auto_auto_auto] md:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{account.displayName || account.id}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        {account.hasSession ? 'Session imported' : 'Missing session'}{account.sessionSavedAt ? `, saved ${new Date(account.sessionSavedAt).toLocaleString()}` : ''}
                      </p>
                    </div>
                    <StatusPill tone={account.hasSession ? 'success' : 'danger'} dot>
                      {account.hasSession ? 'Ready' : 'Needs session'}
                    </StatusPill>
                    <span className="text-xs text-[var(--text-muted)]">{available} available</span>
                    <span className="text-xs text-[var(--text-muted)]">{blocked} blocked</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h3 className="app-section-title">Recent sync activity</h3>
              <p className="mt-1 text-sm text-[var(--text-muted)]">The latest worker runs and their write volume.</p>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {runs.length === 0 ? (
                <EmptyState title="No sync runs yet" description="Run a delta sync to start tracking freshness and coverage." compact />
              ) : runs.slice(0, 6).map((run) => (
                <div key={run.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div>
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{run.surface}</p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{run.accountId} via {run.lane}</p>
                  </div>
                  <div className="text-right">
                    <StatusPill tone={run.status === 'success' ? 'success' : run.status.includes('failure') ? 'warning' : 'neutral'}>
                      {run.status}
                    </StatusPill>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{run.itemsRead} read, {run.itemsWritten} written</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h3 className="app-section-title">LinkedIn activity stream</h3>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Recent message, connection, profile, and sync events across accounts.</p>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {activities.length === 0 ? (
              <EmptyState title="No recent activity" description="Once accounts are connected, this stream will show the freshest LinkedIn events worth reviewing." compact />
            ) : activities.map((activity, index) => (
              <div key={`${activity.accountId}-${activity.timestamp}-${index}`} className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{activity.targetName || activity.accountId}</p>
                  <p className="mt-1 text-sm text-[var(--text-muted)]">{activity.message || activity.type}</p>
                </div>
                <div className="shrink-0 text-right">
                  <StatusPill tone="info">{activity.accountId}</StatusPill>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">{new Date(activity.timestamp).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof MessageSquareText;
  label: string;
  value: number;
  tone: 'success' | 'info' | 'warning';
}) {
  const bg = tone === 'success' ? 'bg-emerald-400/15' : tone === 'warning' ? 'bg-amber-400/15' : 'bg-sky-400/15';
  return (
    <div className="rounded-[22px] border border-white/12 bg-white/8 p-4">
      <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${bg} text-white`}>
        <Icon size={18} />
      </div>
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-300">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-white">{value}</p>
    </div>
  );
}
