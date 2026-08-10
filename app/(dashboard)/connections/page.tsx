'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Connection, Account, SyncCursor, SyncPostureStatus } from '@/types/dashboard';
import { getAccounts, getUnifiedConnections, getUnifiedSyncStatus, queueUnifiedSync } from '@/lib/api-client';
import { ConnectionGrid } from '@/components/connections/ConnectionGrid';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { RefreshCcw, UsersRound } from 'lucide-react';

export default function ConnectionsPage() {
  const router = useRouter();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [accounts,    setAccounts]    = useState<Account[]>([]);
  const [cursors,     setCursors]     = useState<SyncCursor[]>([]);
  const [postures,    setPostures]    = useState<SyncPostureStatus[]>([]);
  const [search,      setSearch]      = useState('');
  // F6 — Debounced copy of search to avoid per-keystroke full-array scans
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filter,      setFilter]      = useState<string>('all');
  const [loading,     setLoading]     = useState(true);
  const [syncing,     setSyncing]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // F6 — 150 ms debounce: update debouncedSearch only after the user pauses typing
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const [{ accounts: accs }, { connections: unifiedConnections }, syncStatus] = await Promise.all([
        getAccounts(),
        getUnifiedConnections(500),
        getUnifiedSyncStatus(),
      ]);
      setAccounts(accs);
      setCursors(syncStatus.cursors || []);
      setPostures(syncStatus.postures || []);
      const all = unifiedConnections
        .sort((a, b) => (b.connectedAt ?? 0) - (a.connectedAt ?? 0));

      setConnections(all);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // No polling — connections page is a static view, refresh on mount only
  }, [load]);

  // F6 — useMemo so the filtered list is recomputed only when the debounced
  // search string, filter pill, or underlying connections array changes.
  const filtered = useMemo(
    () =>
      connections
        .filter((c) => filter === 'all' || c.accountId === filter)
        .filter((c) => c.name.toLowerCase().includes(debouncedSearch.toLowerCase())),
    [connections, filter, debouncedSearch]
  );

  const selectedAccountIds = useMemo(
    () => (filter === 'all' ? accounts.map((account) => account.id) : [filter]),
    [accounts, filter]
  );

  const reconnectAccountId = useMemo(() => {
    if (filter !== 'all') return filter;
    return accounts.find((account) => (
      ['expired', 'restricted', 'checkpoint', 'connect_failed'].includes(account.sessionStatus || '')
      || ['login_redirect', 'automation_warning', 'checkpoint'].includes(account.liveReachability || '')
    ))?.id
      || accounts[0]?.id
      || null;
  }, [accounts, filter]);

  const connectionState = useMemo(() => {
    const relevantCursors = cursors.filter(
      (cursor) => cursor.surface === 'connections' && selectedAccountIds.includes(cursor.accountId)
    );
    const relevantPostures = postures.filter((posture) => selectedAccountIds.includes(posture.accountId));
    const blockedPosture = relevantPostures.find((posture) => ['blocked', 'checkpoint', 'expired', 'automation_warning'].includes(posture.posture));
    const blockedConnectionsPosture = relevantPostures.find((posture) => ['blocked', 'checkpoint', 'expired', 'automation_warning'].includes(posture.posture) && (!posture.surface || posture.surface === 'connections'));
    const blockedOtherSurfacePosture = relevantPostures.find((posture) => ['blocked', 'checkpoint', 'expired', 'automation_warning'].includes(posture.posture) && posture.surface && posture.surface !== 'connections');
    const blockedCursor = relevantCursors.find((cursor) => cursor.coverage === 'blocked');
    const partialCursor = relevantCursors.find((cursor) => cursor.coverage === 'partial');
    const staleCursor = relevantCursors.find((cursor) => cursor.coverage === 'stale');
    const emptyCursor = relevantCursors.find((cursor) => cursor.coverage === 'empty' || cursor.coverage === 'empty_or_unavailable');
    const availableCursor = relevantCursors.find((cursor) => cursor.coverage === 'available');

    const diagnosticsFromCursor = (cursor: SyncCursor | undefined) => {
      if (!cursor?.metadata || typeof cursor.metadata !== 'object') return null;
      const metadata = cursor.metadata as Record<string, unknown>;
      if (!metadata.diagnostics || typeof metadata.diagnostics !== 'object') return null;
      return metadata.diagnostics as Record<string, unknown>;
    };

    if (blockedCursor) {
      const diagnostics = diagnosticsFromCursor(blockedCursor);
      const finalUrl = String(diagnostics?.finalUrl || '');
      return {
        coverage: 'blocked',
        reason: finalUrl
          ? `LinkedIn blocked or redirected the connections page at ${finalUrl}. Reconnect the account before syncing connections again.`
          : 'LinkedIn blocked or redirected the connections page. Reconnect the account before syncing connections again.',
        nextRunAt: blockedCursor.nextRunAt || null,
      };
    }

    if (blockedConnectionsPosture) {
      return {
        coverage: 'blocked',
        reason: blockedConnectionsPosture.reason || (
          blockedConnectionsPosture.posture === 'automation_warning'
            ? 'LinkedIn showed an automation or unusual-activity warning while validating this account. Reconnect and verify the account before syncing connections again.'
            : 'LinkedIn redirected the session away from the connections page. Reconnect before syncing connections again.'
        ),
        nextRunAt: blockedConnectionsPosture.nextAllowedAt || null,
      };
    }

    if (blockedOtherSurfacePosture) {
      const surfaceLabel = String(blockedOtherSurfacePosture.surface || 'another LinkedIn surface').replace(/_/g, ' ');
      return {
        coverage: 'blocked',
        reason: blockedOtherSurfacePosture.posture === 'automation_warning'
          ? `LinkedIn raised an account warning while syncing ${surfaceLabel}. Connections stay read-only until the account is reconnected and verified.`
          : `LinkedIn paused browser sync for this account while checking ${surfaceLabel}. Reconnect the account before retrying connections.`,
        nextRunAt: blockedOtherSurfacePosture.nextAllowedAt || null,
      };
    }

    if (blockedPosture) {
      return {
        coverage: 'blocked',
        reason: 'LinkedIn paused browser-backed sync for this account. Reconnect the account before syncing connections again.',
        nextRunAt: blockedPosture.nextAllowedAt || null,
      };
    }

    if (availableCursor) {
      return {
        coverage: 'available',
        reason: connections.length > 0 ? 'Connections are being served from the local mirror.' : 'Connections were synced successfully for the selected account set.',
        nextRunAt: availableCursor.nextRunAt || null,
      };
    }

    if (partialCursor) {
      const diagnostics = diagnosticsFromCursor(partialCursor);
      const finalUrl = String(diagnostics?.finalUrl || '');
      const anchorsSeen = Number(diagnostics?.anchorsSeen || 0);
      const validRows = Number(diagnostics?.validRows || 0);
      return {
        coverage: 'partial',
        reason: finalUrl
          ? `LinkedIn loaded ${finalUrl}, but the worker only confirmed ${validRows} valid rows from ${anchorsSeen} detected profile anchors.`
          : 'The worker reached LinkedIn, but the page did not expose a reliable connections list.',
        nextRunAt: partialCursor.nextRunAt || null,
      };
    }

    if (staleCursor) {
      return {
        coverage: 'stale',
        reason: 'Connections have not refreshed recently. The last attempt failed or was deferred.',
        nextRunAt: staleCursor.nextRunAt || null,
      };
    }

    if (emptyCursor) {
      const diagnostics = diagnosticsFromCursor(emptyCursor);
      const finalUrl = String(diagnostics?.finalUrl || '');
      return {
        coverage: 'empty',
        reason: finalUrl
          ? `LinkedIn loaded ${finalUrl} and reported no visible connections for the selected account set.`
          : 'LinkedIn returned no visible connections for the selected account set.',
        nextRunAt: emptyCursor.nextRunAt || null,
      };
    }

    return {
      coverage: 'not_started',
      reason: 'Connections have not been mirrored yet for the selected account set.',
      nextRunAt: null,
    };
  }, [connections.length, cursors, postures, selectedAccountIds]);

  const syncConnectionsNow = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      if (filter === 'all') {
        await queueUnifiedSync('backfill', { surfaces: ['connections'] });
      } else {
        await queueUnifiedSync('backfill', { accountId: filter, surfaces: ['connections'] });
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to queue connection sync');
    } finally {
      setSyncing(false);
    }
  }, [filter, load]);

  const reconnectAccount = useCallback(() => {
    if (!reconnectAccountId) {
      router.push('/accounts');
      return;
    }
    router.push(`/accounts?connect=${encodeURIComponent(reconnectAccountId)}`);
  }, [reconnectAccountId, router]);

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
        eyebrow="LinkedIn Graph"
        title="Connections"
        description={`${connections.length.toLocaleString()} stored connection${connections.length === 1 ? '' : 's'} across ${accounts.length} account${accounts.length === 1 ? '' : 's'}. This view is DB-first and now tells us whether LinkedIn is available, empty, partial, stale, or blocked before we assume the scraper is healthy.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()} disabled={loading || syncing}>
              <RefreshCcw size={16} />
              Refresh
            </Button>
            <Button
              onClick={() => {
                if (connectionState.coverage === 'blocked') {
                  reconnectAccount();
                  return;
                }
                void syncConnectionsNow();
              }}
              disabled={syncing}
            >
              <UsersRound size={16} />
              {syncing ? 'Syncing connections...' : connectionState.coverage === 'blocked' ? 'Reconnect required' : 'Sync connections'}
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
        <ConnectionGrid
          connections={filtered}
          accounts={accounts}
          total={connections.length}
          coverage={connectionState.coverage}
          reason={connectionState.reason}
          nextRunAt={connectionState.nextRunAt}
          onSyncConnections={syncConnectionsNow}
          onReconnect={reconnectAccount}
          syncing={syncing}
          search={search}
          filter={filter}
          onSearchChange={setSearch}
          onFilterChange={setFilter}
        />
      </div>
    </div>
  );
}
