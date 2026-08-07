'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, DatabaseZap, LayoutDashboard, Mail, ShieldCheck, UserCircle, Users } from 'lucide-react';
import { getUnifiedAccounts, getUnifiedInbox, getUnifiedNotifications, getUnifiedSyncStatus } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface NavCounts {
  inbox: number;
  connections: number;
  notifications: number;
  blocked: number;
}

const navItems = [
  { href: '/', icon: LayoutDashboard, label: 'Dashboard', countKey: null },
  { href: '/inbox', icon: Mail, label: 'Inbox', countKey: 'inbox' },
  { href: '/connections', icon: Users, label: 'Network', countKey: 'connections' },
  { href: '/notifications', icon: Bell, label: 'Activity', countKey: 'notifications' },
  { href: '/operations', icon: DatabaseZap, label: 'Data', countKey: null },
  { href: '/accounts', icon: UserCircle, label: 'Accounts', countKey: null },
] as const;

function isActivePath(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname.startsWith(href);
}

export function Sidebar() {
  const pathname = usePathname();
  const [counts, setCounts] = useState<NavCounts>({ inbox: 0, connections: 0, notifications: 0, blocked: 0 });
  const [activeAccounts, setActiveAccounts] = useState(0);
  const [healthyAccounts, setHealthyAccounts] = useState(0);

  async function fetchCounts() {
    try {
      const [{ accounts }, { conversations }, { notifications }, syncStatus] = await Promise.all([
        getUnifiedAccounts(),
        getUnifiedInbox({ limit: 1 }),
        getUnifiedNotifications(20),
        getUnifiedSyncStatus(),
      ]);

      const active = accounts.filter((account) => account.hasSession).length;
      setActiveAccounts(active);
      setHealthyAccounts(syncStatus.cursors.filter((cursor) => cursor.coverage === 'available').length);

      setCounts({
        inbox: conversations.length + (syncStatus.threadResolution?.shellConversations || 0),
        connections: syncStatus.cursors.filter((cursor) => cursor.surface === 'connections' && cursor.coverage === 'available').length,
        notifications: notifications.length,
        blocked: syncStatus.cursors.filter((cursor) => cursor.coverage === 'blocked').length,
      });
    } catch {
      // Keep the shell usable even when the backend is warming up.
    }
  }

  useEffect(() => {
    const timeoutId = setTimeout(() => void fetchCounts(), 0);
    const intervalId = setInterval(() => void fetchCounts(), 60_000);
    return () => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, []);

  return (
    <>
      <aside className="hidden w-[288px] shrink-0 border-r border-[var(--border)]/80 bg-white/75 backdrop-blur-xl lg:flex lg:h-screen lg:flex-col">
        <div className="border-b border-[var(--border)]/80 px-6 py-6">
          <Link href="/" prefetch={false} className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent)] text-base font-bold text-white shadow-[0_12px_24px_rgba(10,102,194,0.2)]">
              LI
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-[var(--text-primary)]">LinkedIn Data Console</p>
            </div>
          </Link>
        </div>

        <div className="px-6 pt-5">
          <div className="app-surface-dark rounded-[20px] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-300">LinkedIn mirror</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <p className="text-2xl font-semibold">{activeAccounts}</p>
                <p className="text-xs text-slate-300">session-ready</p>
              </div>
              <div>
                <p className="text-2xl font-semibold">{counts.blocked}</p>
                <p className="text-xs text-slate-300">blocked surfaces</p>
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1.5 px-4 py-5">
          {navItems.map(({ href, icon: Icon, label, countKey }) => {
            const active = isActivePath(pathname, href);
            const count = countKey ? counts[countKey] : 0;
            return (
              <Link
                key={href}
                href={href}
                prefetch={false}
                className={cn(
                  'flex h-11 items-center gap-3 rounded-2xl px-4 text-sm font-semibold transition-colors',
                  active
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_0_0_1px_rgba(10,102,194,0.08)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                )}
              >
                <Icon size={18} />
                <span className="flex-1">{label}</span>
                {count > 0 && (
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px]', active ? 'bg-white/80' : 'bg-[var(--bg-subtle)]')}>
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[var(--border)]/80 p-4">
          <div className="app-surface rounded-[20px] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
              <ShieldCheck size={14} />
              Sync posture
            </div>
            <div className="mt-4 space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)]">Healthy surfaces</span>
                <span className="font-semibold text-[var(--text-primary)]">{healthyAccounts}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)]">Recent notifications</span>
                <span className="font-semibold text-[var(--text-primary)]">{counts.notifications}</span>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center justify-between border-b border-[var(--border)]/80 bg-white/80 px-4 backdrop-blur-xl lg:hidden">
        <Link href="/" prefetch={false} className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--accent)] text-sm font-bold text-white">
            LI
          </div>
          <span className="text-sm font-bold text-[var(--text-primary)]">Data Console</span>
        </Link>
        <div className="rounded-full bg-[var(--bg-subtle)] px-3 py-1 text-xs font-semibold text-[var(--text-muted)]">
          {activeAccounts} active
        </div>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid h-16 grid-cols-6 border-t border-[var(--border)]/80 bg-white/88 backdrop-blur-xl lg:hidden">
        {navItems.map(({ href, icon: Icon, label, countKey }) => {
          const active = isActivePath(pathname, href);
          const count = countKey ? counts[countKey] : 0;
          return (
            <Link
              key={href}
              href={href}
              prefetch={false}
              className={cn(
                'relative flex flex-col items-center justify-center gap-1 text-[10px] font-semibold',
                active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
              )}
            >
              <Icon size={18} />
              <span>{label === 'Dashboard' ? 'Home' : label}</span>
              {count > 0 && <span className="absolute right-4 top-2 h-2 w-2 rounded-full bg-[var(--accent)]" />}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
