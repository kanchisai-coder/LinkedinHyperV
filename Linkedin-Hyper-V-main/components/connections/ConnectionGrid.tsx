'use client';

import type { Connection, Account } from '@/types/dashboard';
import { Avatar } from '@/components/ui/Avatar';
import { AccountBadge } from '@/components/ui/AccountBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterBar } from '@/components/ui/FilterBar';
import { Button } from '@/components/ui/Button';
import { timeAgo } from '@/lib/utils';
import { ExternalLink, RefreshCcw, Search, ShieldAlert, Users } from 'lucide-react';

interface ConnectionGridProps {
  connections: Connection[];
  accounts: Account[];
  total: number;
  coverage: string;
  reason: string;
  nextRunAt?: string | null;
  syncing?: boolean;
  onSyncConnections?: () => void;
  onReconnect?: () => void;
  search: string;
  filter: string;
  onSearchChange: (q: string) => void;
  onFilterChange: (f: string) => void;
}

export function ConnectionGrid({
  connections,
  accounts,
  total,
  coverage,
  reason,
  nextRunAt,
  syncing = false,
  onSyncConnections,
  onReconnect,
  search,
  filter,
  onSearchChange,
  onFilterChange,
}: ConnectionGridProps) {
  const filterOptions = [
    { value: 'all', label: 'All accounts', count: total },
    ...accounts.map((account) => ({
      value: account.id,
      label: account.displayName || account.id,
      count: connections.filter((connection) => connection.accountId === account.id).length,
    })),
  ];

  const coverageLabel = coverage === 'empty_or_unavailable'
    ? 'empty'
    : coverage.replace(/_/g, ' ');

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="app-surface p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-sm">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                placeholder="Search names and headlines"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                className="app-input h-10 pl-9 pr-3 text-sm"
              />
            </div>
            <FilterBar options={filterOptions} value={filter} onChange={onFilterChange} className="lg:justify-end" />
          </div>
        </div>

        <div className="app-surface p-4">
          <p className="app-kicker">Coverage</p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Profiles</p>
              <p className="mt-2 text-lg font-semibold text-[var(--text-primary)]">{connections.length}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Visible in the filtered working set</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-faint)]">Sync state</p>
              <p className="mt-2 text-lg font-semibold capitalize text-[var(--text-primary)]">{coverageLabel}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {nextRunAt ? `Next attempt ${timeAgo(nextRunAt)}` : 'No next attempt scheduled yet'}
              </p>
            </div>
          </div>
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-sm ${
            coverage === 'blocked'
              ? 'border-[var(--danger)]/40 bg-[var(--danger-soft)] text-[var(--danger)]'
              : coverage === 'partial' || coverage === 'stale'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                : 'border-[var(--border)] bg-[var(--bg-subtle)] text-[var(--text-muted)]'
          }`}>
            <div className="flex items-start gap-2">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <p>{reason}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-surface overflow-hidden">
        {connections.length === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title={
              coverage === 'blocked'
                ? 'Connections sync is blocked'
                : coverage === 'partial'
                  ? 'Connections need another pass'
                  : coverage === 'empty' || coverage === 'empty_or_unavailable'
                    ? 'LinkedIn returned no visible connections'
                    : 'No mirrored connections yet'
            }
            description={reason}
            action={onSyncConnections ? (
              <Button
                variant="secondary"
                onClick={coverage === 'blocked' ? onReconnect : onSyncConnections}
                disabled={syncing || (coverage === 'blocked' && !onReconnect)}
              >
                <RefreshCcw size={16} />
                {syncing ? 'Syncing...' : coverage === 'blocked' ? 'Reconnect required' : 'Sync connections'}
              </Button>
            ) : undefined}
          />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="app-table min-w-[860px]">
                <thead>
                  <tr>
                    {['Person', 'LinkedIn detail', 'Source account', 'Connected', 'Profile'].map((header) => (
                      <th key={header}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {connections.map((connection, index) => (
                    <tr key={`${connection.accountId}-${connection.profileUrl}-${index}`}>
                      <td>
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar name={connection.name} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{connection.name}</p>
                            <p className="truncate text-xs text-[var(--text-faint)]">{connection.profileUrl || 'LinkedIn profile record'}</p>
                          </div>
                        </div>
                      </td>
                      <td>
                        {connection.headline ? (
                          <p className="line-clamp-2 text-sm text-[var(--text-secondary)]">{connection.headline}</p>
                        ) : (
                          <span className="text-sm text-[var(--text-faint)]">Headline unavailable</span>
                        )}
                      </td>
                      <td>
                        <AccountBadge name={connection.accountId} />
                      </td>
                      <td className="text-sm text-[var(--text-muted)]">
                        {connection.connectedAt ? timeAgo(connection.connectedAt) : 'Unknown'}
                      </td>
                      <td>
                        {connection.profileUrl ? (
                          <a href={connection.profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)]">
                            <ExternalLink size={14} />
                            Open in LinkedIn
                          </a>
                        ) : (
                          <span className="text-sm text-[var(--text-faint)]">Unavailable</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 p-3 md:hidden">
              {connections.map((connection, index) => (
                <div key={`${connection.accountId}-${connection.profileUrl}-${index}`} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 shadow-sm">
                  <div className="flex items-start gap-3">
                    <Avatar name={connection.name} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{connection.name}</p>
                          {connection.headline && <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">{connection.headline}</p>}
                        </div>
                        {connection.profileUrl && (
                          <a href={connection.profileUrl} target="_blank" rel="noopener noreferrer" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] text-[var(--accent)]">
                            <ExternalLink size={16} />
                          </a>
                        )}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <AccountBadge name={connection.accountId} />
                        <span className="rounded-full bg-[var(--bg-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                          {connection.connectedAt ? timeAgo(connection.connectedAt) : 'Unknown date'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
