'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  DatabaseZap,
  Cpu,
  Layers3,
  RefreshCcw,
  ShieldAlert,
  TimerReset,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import type { BrowserBudgetStatus, MessageRepairResult, QueueStatus, SyncCursor, SyncPostureStatus, SyncRun, ThreadResolutionStats, UnifiedAccount } from '@/types/dashboard';
import { getUnifiedAccounts, getUnifiedSyncStatus, queueUnifiedSync, repairMessages } from '@/lib/api-client';

function formatTime(value?: string | number | null) {
  if (!value) return 'Never';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function coverageTone(coverage: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (coverage === 'available') return 'success';
  if (coverage === 'partial' || coverage === 'stale' || coverage === 'planned') return 'warning';
  if (coverage === 'blocked') return 'danger';
  return 'neutral';
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'success') return 'success';
  if (status.includes('failure')) return 'warning';
  if (status === 'blocked' || status === 'failed') return 'danger';
  return 'neutral';
}

const SURFACE_ORDER = [
  'inbox',
  'notifications',
  'connections',
  'invitations',
  'posts',
  'comments',
  'reactions',
  'search',
  'account_health',
];

export default function OperationsPage() {
  const [cursors, setCursors] = useState<SyncCursor[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [accounts, setAccounts] = useState<UnifiedAccount[]>([]);
  const [threadResolution, setThreadResolution] = useState<ThreadResolutionStats | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [postures, setPostures] = useState<SyncPostureStatus[]>([]);
  const [browser, setBrowser] = useState<BrowserBudgetStatus[]>([]);
  const [blockedAccounts, setBlockedAccounts] = useState(0);
  const [browserMinutesEstimate, setBrowserMinutesEstimate] = useState(0);
  const [browserRecycles, setBrowserRecycles] = useState(0);
  const [lastBrowserFatalError, setLastBrowserFatalError] = useState<string | null>(null);
  const [threadsAttempted, setThreadsAttempted] = useState(0);
  const [threadsRefreshed, setThreadsRefreshed] = useState(0);
  const [threadFailures, setThreadFailures] = useState(0);
  const [lastAuthFailure, setLastAuthFailure] = useState<string | null>(null);
  const [safetyPosture, setSafetyPosture] = useState<string | null>(null);
  const [lastSafetyWarning, setLastSafetyWarning] = useState<string | null>(null);
  const [lastWarningUrl, setLastWarningUrl] = useState<string | null>(null);
  const [repairResult, setRepairResult] = useState<MessageRepairResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadData() {
    setError(null);
    try {
      const [statusData, accountsData] = await Promise.all([
        getUnifiedSyncStatus(),
        getUnifiedAccounts(),
      ]);
      setCursors(statusData.cursors || []);
      setRuns(statusData.runs || []);
      setThreadResolution(statusData.threadResolution || null);
      setQueueStatus(statusData.queue || null);
      setPostures(statusData.postures || []);
      setBrowser(statusData.browser || []);
      setBlockedAccounts(statusData.blockedAccounts || 0);
      setBrowserMinutesEstimate(statusData.browserMinutesEstimate || 0);
      setBrowserRecycles(statusData.browserRecycles || 0);
      setLastBrowserFatalError(statusData.lastBrowserFatalError || null);
      setThreadsAttempted(statusData.threadsAttempted || 0);
      setThreadsRefreshed(statusData.threadsRefreshed || 0);
      setThreadFailures(statusData.threadFailures || 0);
      setLastAuthFailure(statusData.lastAuthFailure || null);
      setSafetyPosture(statusData.safetyPosture || null);
      setLastSafetyWarning(statusData.lastSafetyWarning || null);
      setLastWarningUrl(statusData.lastWarningUrl || null);
      setAccounts(accountsData.accounts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load operations data');
    } finally {
      setIsLoading(false);
    }
  }

  async function startSync(lane: 'delta' | 'backfill') {
    setIsSyncing(true);
    setError(null);
    try {
      await queueUnifiedSync(lane);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue sync');
    } finally {
      setIsSyncing(false);
    }
  }

  async function runRepair(dryRun: boolean) {
    setIsRepairing(true);
    setError(null);
    try {
      const result = await repairMessages({ dryRun });
      setRepairResult(result);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run message repair');
    } finally {
      setIsRepairing(false);
    }
  }

  useEffect(() => {
    void loadData();
    const timer = setInterval(() => void loadData(), 30_000);
    return () => clearInterval(timer);
  }, []);

  const summary = useMemo(() => {
    const available = cursors.filter((cursor) => cursor.coverage === 'available').length;
    const blocked = cursors.filter((cursor) => cursor.coverage === 'blocked').length;
    const planned = cursors.filter((cursor) => cursor.coverage === 'planned').length;
    const stale = cursors.filter((cursor) => cursor.coverage === 'stale').length;
    return { available, blocked, planned, stale };
  }, [cursors]);

  const coverageRows = useMemo(() => {
    const grouped = new Map<string, SyncCursor[]>();
    for (const cursor of cursors) {
      const existing = grouped.get(cursor.accountId) || [];
      existing.push(cursor);
      grouped.set(cursor.accountId, existing);
    }
    return Array.from(grouped.entries()).map(([accountId, rows]) => ({
      accountId,
      rows: [...rows].sort((left, right) => {
        const leftIndex = SURFACE_ORDER.indexOf(left.surface);
        const rightIndex = SURFACE_ORDER.indexOf(right.surface);
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      }),
    }));
  }, [cursors]);

  const postureByAccount = useMemo(
    () => new Map(postures.map((posture) => [posture.accountId, posture])),
    [postures]
  );

  const browserByAccount = useMemo(
    () => new Map(browser.map((entry) => [entry.accountId, entry])),
    [browser]
  );

  return (
    <div className="min-h-full">
      <PageHeader
        eyebrow="LinkedIn Operations"
        title="Data coverage and sync control"
        description="Track what each account can see, how fresh the mirror is, and where the worker is backing off to save browser time."
        actions={
          <>
            <Button variant="secondary" onClick={() => void loadData()} disabled={isLoading || isSyncing}>
              <RefreshCcw size={16} />
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => void startSync('delta')} disabled={isSyncing}>
              <TimerReset size={16} />
              Sync now
            </Button>
            <Button onClick={() => void startSync('backfill')} disabled={isSyncing}>
              <DatabaseZap size={16} />
              Backfill history
            </Button>
            <Button variant="secondary" onClick={() => void runRepair(true)} disabled={isRepairing || isSyncing}>
              <Wrench size={16} />
              Repair dry run
            </Button>
            <Button variant="secondary" onClick={() => void runRepair(false)} disabled={isRepairing || isSyncing}>
              <Wrench size={16} />
              Apply repair
            </Button>
          </>
        }
      />

      <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
        {error && (
          <div className="rounded-2xl border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}

        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="app-surface-dark overflow-hidden rounded-[28px] p-6 sm:p-7">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-300">Adaptive sync posture</p>
                <h2 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Designed to stay cheap and honest.</h2>
                <p className="mt-3 text-sm leading-6 text-slate-300">
                  Fast deltas stay focused on inbox and notifications, backfills stay slower, and every LinkedIn surface reports whether it is available, partial, planned, stale, or blocked.
                </p>
              </div>
              <div className="rounded-[24px] border border-white/10 bg-white/6 px-5 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-300">Current fleet</p>
                <p className="mt-2 text-3xl font-semibold text-white">{accounts.filter((account) => account.hasSession).length}</p>
                <p className="text-sm text-slate-300">session-ready account{accounts.filter((account) => account.hasSession).length === 1 ? '' : 's'}</p>
              </div>
            </div>
          </div>

          <div className="app-stat-grid">
            <Metric icon={CheckCircle2} label="Available surfaces" value={summary.available} tone="success" />
            <Metric icon={Clock3} label="Planned surfaces" value={summary.planned} tone="warning" />
            <Metric icon={AlertTriangle} label="Blocked surfaces" value={summary.blocked} tone="danger" />
            <Metric icon={Layers3} label="Stale surfaces" value={summary.stale} tone="info" />
          </div>
        </div>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h2 className="app-section-title">Inbox thread resolution</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Shell backlog, repair progress, and captured-message visibility for LinkedIn messaging.</p>
          </div>
          <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-7">
            <Metric icon={AlertTriangle} label="Shell backlog" value={threadResolution?.shellConversations || 0} tone="warning" />
            <Metric icon={Clock3} label="Resolving" value={threadResolution?.resolvingThreads || 0} tone="info" />
            <Metric icon={CheckCircle2} label="Resolved" value={threadResolution?.resolvedThreads || 0} tone="success" />
            <Metric icon={DatabaseZap} label="Messages" value={threadResolution?.messagesCaptured || 0} tone="info" />
            <Metric icon={ShieldAlert} label="Failures" value={threadFailures || threadResolution?.threadResolveFailures || 0} tone="danger" />
            <Metric icon={Cpu} label="Quarantined" value={threadResolution?.quarantinedMessages || 0} tone="warning" />
            <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-subtle)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Last error</p>
              <p className="mt-2 line-clamp-4 text-sm text-[var(--text-primary)]">
                {threadResolution?.lastResolveError || 'No thread-resolution errors recorded'}
              </p>
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                {threadsRefreshed} refreshed / {threadsAttempted} attempted in recent inbox syncs
              </p>
            </div>
          </div>
        </Card>

        <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <Card className="overflow-hidden p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h2 className="app-section-title">Queue pressure</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Worker backlog and retry pressure across the active sync queue.</p>
            </div>
            <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
              <Metric icon={Cpu} label="Active jobs" value={queueStatus?.active || 0} tone="info" />
              <Metric icon={Layers3} label="Queue lag" value={queueStatus?.lag || 0} tone="warning" />
              <Metric icon={Clock3} label="Browser minutes" value={browserMinutesEstimate} tone="info" />
              <Metric icon={ShieldAlert} label="Blocked accounts" value={blockedAccounts} tone="danger" />
            </div>
            {(safetyPosture === 'automation_warning' || lastSafetyWarning) && (
              <div className="border-t border-[var(--border)] px-5 py-4 text-sm text-[var(--warning)]">
                <span className="font-semibold">Automation warning:</span> {lastSafetyWarning || 'LinkedIn signaled unusual activity.'}
                {lastWarningUrl ? ` Last warning URL: ${lastWarningUrl}` : ''}
              </div>
            )}
            {lastAuthFailure && (
              <div className="border-t border-[var(--border)] px-5 py-4 text-sm text-[var(--text-muted)]">
                Last auth failure: <span className="text-[var(--text-primary)]">{lastAuthFailure}</span>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h2 className="app-section-title">Repair pipeline</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Dry-run and apply metrics for canonical message cleanup.</p>
            </div>
            <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-5">
              <Metric icon={DatabaseZap} label="Rows scanned" value={repairResult?.rowsScanned || 0} tone="info" />
              <Metric icon={CheckCircle2} label="Keys assigned" value={repairResult?.rowsAssigned || 0} tone="success" />
              <Metric icon={Layers3} label="Collapsed" value={repairResult?.duplicatesCollapsed || 0} tone="success" />
              <Metric icon={ShieldAlert} label="Quarantined" value={repairResult?.quarantined || 0} tone="warning" />
              <Metric icon={AlertTriangle} label="Ambiguous" value={repairResult?.ambiguousSkipped || 0} tone="danger" />
            </div>
            {lastBrowserFatalError && (
              <div className="border-t border-[var(--border)] px-5 py-4 text-sm text-[var(--text-muted)]">
                Last browser fatal error: <span className="text-[var(--text-primary)]">{lastBrowserFatalError}</span>. Recycles so far: {browserRecycles}.
              </div>
            )}
          </Card>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
          <Card className="overflow-hidden p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h2 className="app-section-title">Account health</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Session state, coverage posture, and next-run visibility per LinkedIn account.</p>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {accounts.length === 0 && !isLoading ? (
                <EmptyState title="No linked accounts" description="Import a LinkedIn session to begin unified data sync." compact />
              ) : accounts.map((account) => {
                const accountCursors = cursors.filter((cursor) => cursor.accountId === account.id);
                const posture = postureByAccount.get(account.id);
                const browserBudget = browserByAccount.get(account.id);
                const available = accountCursors.filter((cursor) => cursor.coverage === 'available').length;
                const blocked = accountCursors.filter((cursor) => cursor.coverage === 'blocked').length;
                const nextRun = accountCursors.find((cursor) => cursor.nextRunAt)?.nextRunAt || null;
                return (
                  <div key={account.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_auto_auto_auto] md:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{account.displayName || account.id}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        {account.hasSession ? `Session saved ${formatTime(account.sessionSavedAt)}` : 'No imported LinkedIn session'}
                      </p>
                    </div>
                    <StatusPill tone={
                      !account.hasSession
                        ? 'danger'
                        : posture?.posture === 'healthy'
                          ? 'success'
                          : posture?.posture === 'degraded'
                            ? 'warning'
                            : 'danger'
                    } dot>
                      {!account.hasSession ? 'Missing session' : (posture?.posture || 'healthy')}
                    </StatusPill>
                    <span className="text-xs text-[var(--text-muted)]">{available} available</span>
                    <span className="text-xs text-[var(--text-muted)]">Next {formatTime(posture?.nextAllowedAt || nextRun)}</span>
                    <div className="md:col-span-4 flex flex-wrap gap-2">
                      {blocked > 0 && (
                        <StatusPill tone="warning">
                          {blocked} surface{blocked === 1 ? '' : 's'} currently blocked
                        </StatusPill>
                      )}
                      {browserBudget && (
                        <StatusPill tone="neutral">
                          {browserBudget.browserMinutesEstimate} browser min
                        </StatusPill>
                      )}
                      {posture?.reason && (
                        <StatusPill tone="neutral">
                          {posture.reason}
                        </StatusPill>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="overflow-hidden p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h2 className="app-section-title">Recent sync runs</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Worker runs, lane choice, and read/write volume.</p>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {runs.length === 0 ? (
                <EmptyState title="No sync runs yet" description="Run a delta sync to create cursor and run records." compact />
              ) : runs.slice(0, 10).map((run) => (
                <div key={run.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_auto_auto] md:items-center">
                  <div>
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{run.surface} via {run.lane}</p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{run.accountId} started {formatTime(run.startedAt)}</p>
                  </div>
                  <StatusPill tone={statusTone(run.status)}>{run.status}</StatusPill>
                  <div className="text-right text-xs text-[var(--text-muted)]">
                    <div>{run.itemsRead} read / {run.itemsWritten} written</div>
                    <div>{run.durationMs ? `${Math.round(run.durationMs / 1000)}s` : 'Running'}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h2 className="app-section-title">Coverage matrix</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Every LinkedIn surface per account, with freshness and failure counts exposed instead of hidden.</p>
          </div>
          {coverageRows.length === 0 ? (
            <EmptyState title="No sync records yet" description="Queue a sync to populate per-surface coverage and lag." compact />
          ) : (
            <div className="space-y-5 p-5">
              {coverageRows.map((account) => (
                <div key={account.accountId} className="app-surface overflow-hidden rounded-[22px]">
                  <div className="border-b border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--text-primary)]">{account.accountId}</p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">{account.rows.length} tracked surfaces</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill tone="success">{account.rows.filter((row) => row.coverage === 'available').length} available</StatusPill>
                        <StatusPill tone="warning">{account.rows.filter((row) => row.coverage === 'planned' || row.coverage === 'stale').length} planned/stale</StatusPill>
                        <StatusPill tone="danger">{account.rows.filter((row) => row.coverage === 'blocked').length} blocked</StatusPill>
                      </div>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="app-table min-w-[880px]">
                      <thead>
                        <tr>
                          <th>Surface</th>
                          <th>Coverage</th>
                          <th>Last success</th>
                          <th>Last failure</th>
                          <th>Next run</th>
                          <th>Failures</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {account.rows.map((row) => (
                          <tr key={row.id}>
                            <td className="font-medium text-[var(--text-primary)]">{row.surface.replace(/_/g, ' ')}</td>
                            <td><StatusPill tone={coverageTone(row.coverage)}>{row.coverage}</StatusPill></td>
                            <td>{formatTime(row.lastSuccessAt)}</td>
                            <td>{formatTime(row.lastFailureAt)}</td>
                            <td>{formatTime(row.nextRunAt)}</td>
                            <td>{row.failureCount}</td>
                            <td className="max-w-[280px] text-xs text-[var(--text-muted)]">
                              {typeof row.metadata?.shellConversations === 'number' && row.metadata.shellConversations > 0
                                ? `${row.metadata.shellConversations} shell thread${row.metadata.shellConversations === 1 ? '' : 's'} pending resolution`
                                : typeof row.metadata?.errorMessage === 'string'
                                  ? row.metadata.errorMessage
                                  : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h2 className="app-section-title">Resource strategy</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">The operating defaults the worker follows to keep LinkedIn capture reliable and cheap.</p>
          </div>
          <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-4">
            <Policy icon={TimerReset} title="Delta-first reads" body="Recent inbox and notification surfaces refresh first; large history waits for backfill lanes." />
            <Policy icon={DatabaseZap} title="Low-cost backfills" body="History jobs stay slower and narrower so browser minutes do not explode with every account." />
            <Policy icon={ShieldAlert} title="Backoff on risk" body="Checkpoint, authwall, selector, and network failures should pause or widen retry intervals instead of thrashing." />
            <Policy icon={Layers3} title="Honest coverage" body="Planned or blocked surfaces are labeled that way, rather than silently showing empty dashboards." />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger' | 'info';
}) {
  const classes = {
    success: 'bg-[var(--success-soft)] text-[var(--success)]',
    warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
    info: 'bg-[var(--info-soft)] text-[var(--info)]',
  };

  return (
    <Card className="p-4">
      <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${classes[tone]}`}>
        <Icon size={18} />
      </div>
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-[var(--text-primary)]">{value}</p>
    </Card>
  );
}

function Policy({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-subtle)] p-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-[var(--accent)] shadow-[0_8px_20px_rgba(15,23,42,0.06)]">
        <Icon size={18} />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{body}</p>
    </div>
  );
}
