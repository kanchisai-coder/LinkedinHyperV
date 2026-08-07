// FILE: app/(dashboard)/accounts/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AccountCard } from '@/components/accounts/AccountCard';
import { AddAccountModal } from '@/components/accounts/AddAccountModal';
import { ConnectLinkedInModal } from '@/components/accounts/ConnectLinkedInModal';
import { Plus, Loader2, LogIn, UserCircle } from 'lucide-react';
import type { Account } from '@/types/dashboard';
import { ExportButton } from '@/components/ui/ExportButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export default function AccountsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    const connectAccountId = searchParams.get('connect');
    if (!connectAccountId) return;
    setSelectedAccountId(connectAccountId);
    setIsConnectModalOpen(true);
  }, [searchParams]);

  const fetchAccounts = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/accounts');
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts || []);
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenAddModal = (accountId?: string) => {
    if (accountId) {
      setSelectedAccountId(accountId);
    }
    setIsAddModalOpen(true);
  };

  const handleCloseAddModal = () => {
    setIsAddModalOpen(false);
    setSelectedAccountId(null);
  };

  const handleOpenConnectModal = (accountId?: string) => {
    if (accountId) {
      setSelectedAccountId(accountId);
    }
    setIsConnectModalOpen(true);
  };

  const handleCloseConnectModal = () => {
    setIsConnectModalOpen(false);
    setSelectedAccountId(null);
    if (searchParams.get('connect')) {
      router.replace('/accounts');
    }
  };

  const connectedAccounts = accounts.filter((account) => account.lastSeen || account.sessionStatus === 'connected').length;
  const healthyAccounts = accounts.filter((account) => account.isActive).length;
  const attentionAccounts = accounts.filter((account) => (
    !account.lastSeen
    || ['pending_login', 'connect_failed', 'expired', 'restricted', 'checkpoint'].includes(account.sessionStatus || '')
    || (account.liveReachability && account.liveReachability !== 'reachable')
  )).length;

  return (
    <div className="min-h-full">
      <PageHeader
        eyebrow="LinkedIn Access"
        title="Accounts"
        description="Manage imported LinkedIn sessions, verification, rate posture, and the accounts feeding the mirror."
        actions={
          <>
          <ExportButton 
            type="activity" 
            label="Export"
            size="sm"
          />
          <Button
            onClick={() => handleOpenConnectModal()}
            variant="secondary"
            size="sm"
          >
            <LogIn size={18} />
            Connect LinkedIn
          </Button>
          <Button
            onClick={() => handleOpenAddModal()}
            size="sm"
          >
            <Plus size={18} />
            Add Account
          </Button>
          </>
        }
      />

      <div className="mx-auto max-w-[1440px] space-y-4 px-4 py-5 sm:px-6 lg:px-8">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="app-surface-dark p-4">
          <p className="app-kicker text-white/70">Connected accounts</p>
          <p className="mt-2 text-3xl font-semibold text-white">{connectedAccounts}</p>
          <p className="mt-2 text-sm text-white/70">Imported LinkedIn sessions currently available to the mirror.</p>
        </div>
        <div className="app-surface p-4">
          <p className="app-kicker">Healthy sessions</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--text-primary)]">{healthyAccounts}</p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">Sessions that look ready for sync and actions.</p>
        </div>
        <div className="app-surface p-4">
          <p className="app-kicker">Needs attention</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--text-primary)]">{attentionAccounts}</p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">Accounts still waiting for a usable cookie import.</p>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex min-h-[320px] items-center justify-center">
          <div className="text-center">
            <Loader2 size={32} className="animate-spin mx-auto mb-2" style={{ color: 'var(--accent)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Loading accounts...
            </p>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && accounts.length === 0 && (
        <div className="app-surface">
          <EmptyState
            icon={<UserCircle size={24} />}
            title="No accounts yet"
            description="Add a LinkedIn account and import browser session cookies to begin using the dashboard."
            action={<Button onClick={() => handleOpenConnectModal()}><LogIn size={16} />Connect LinkedIn</Button>}
          />
        </div>
      )}

      {/* Account Grid */}
      {!isLoading && accounts.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onRefresh={fetchAccounts}
              onImport={handleOpenAddModal}
              onConnect={handleOpenConnectModal}
            />
          ))}
        </div>
      )}

      {/* Add Account Modal */}
      <AddAccountModal
        open={isAddModalOpen}
        onClose={handleCloseAddModal}
        onSuccess={fetchAccounts}
        existingAccounts={accounts.map((a) => a.id)}
        initialAccountId={selectedAccountId}
      />
      <ConnectLinkedInModal
        open={isConnectModalOpen}
        onClose={handleCloseConnectModal}
        onSuccess={fetchAccounts}
        existingAccounts={accounts.map((a) => a.id)}
        initialAccountId={selectedAccountId}
      />
      </div>
    </div>
  );
}
