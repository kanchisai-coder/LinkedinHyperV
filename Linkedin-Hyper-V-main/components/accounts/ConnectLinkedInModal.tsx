'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { getLinkedInConnectStatus, startLinkedInConnect } from '@/lib/api-client';
import type { ConnectSessionStatus } from '@/types/dashboard';
import { ExternalLink, Loader2, LogIn } from 'lucide-react';
import toast from 'react-hot-toast';

interface ConnectLinkedInModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  existingAccounts: string[];
  initialAccountId?: string | null;
}

function toneForStatus(status: ConnectSessionStatus['status']) {
  switch (status) {
    case 'connected':
      return 'success';
    case 'checkpoint_required':
      return 'warning';
    case 'failed':
    case 'expired':
      return 'danger';
    default:
      return 'info';
  }
}

export function ConnectLinkedInModal({
  open,
  onClose,
  onSuccess,
  existingAccounts,
  initialAccountId = null,
}: ConnectLinkedInModalProps) {
  const [accountId, setAccountId] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [session, setSession] = useState<ConnectSessionStatus | null>(null);

  useEffect(() => {
    if (!open) {
      setAccountId('');
      setSession(null);
      setIsStarting(false);
      return;
    }
    if (initialAccountId) {
      setAccountId(initialAccountId);
    }
  }, [initialAccountId, open]);

  useEffect(() => {
    if (!open || !session?.connectId) return;
    if (['connected', 'failed', 'expired'].includes(session.status)) return;

    const interval = setInterval(async () => {
      try {
        const next = await getLinkedInConnectStatus(session.connectId);
        setSession({
          ...next,
          fullscreenBrowserUrl: `/accounts/connect/${encodeURIComponent(next.connectId)}/browser`,
        });
        if (next.status === 'connected') {
          toast.success(`LinkedIn connected for ${next.accountId}`);
          onSuccess();
        }
      } catch (err) {
        console.error('Failed to poll connect status', err);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [open, onSuccess, session?.connectId, session?.status]);

  const handleStart = async () => {
    if (!/^[a-z0-9_-]+$/i.test(accountId.trim())) {
      toast.error('Use letters, numbers, hyphens, or underscores for the account ID');
      return;
    }

    setIsStarting(true);
    try {
      const started = await startLinkedInConnect(accountId.trim());
      setSession({
        connectId: started.connectId,
        accountId: started.accountId,
        status: started.status,
        loginUrl: started.loginUrl,
        browserUrl: started.browserUrl || null,
        fullscreenBrowserUrl: `/accounts/connect/${encodeURIComponent(started.connectId)}/browser`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        message: 'Waiting for LinkedIn sign-in to finish in the worker browser.',
        syncQueued: false,
      });
      toast.success('LinkedIn connect session started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start connect session');
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-6xl">
        <DialogTitle>Connect LinkedIn</DialogTitle>
        <DialogDescription>
          Sign in only on the real LinkedIn page. The worker stores encrypted session cookies only after authenticated state is detected.
        </DialogDescription>

        <div className="mt-5 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-subtle)] p-4">
            <label className="mb-2 block text-sm font-medium text-[var(--text-secondary)]">Account ID</label>
            <input
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="e.g. sales_north_america"
              className="app-input h-11"
              disabled={Boolean(session)}
            />
            {existingAccounts.length > 0 && (
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                Existing accounts: {existingAccounts.join(', ')}
              </p>
            )}

            {session && (
              <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="app-kicker">Connect status</p>
                    <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{session.accountId}</p>
                  </div>
                  <StatusPill tone={toneForStatus(session.status)} dot>{session.status.replace(/_/g, ' ')}</StatusPill>
                </div>
                {session.message && <p className="mt-3 text-sm text-[var(--text-secondary)]">{session.message}</p>}
                <div className="mt-3 space-y-1 text-xs text-[var(--text-muted)]">
                  <p>Login URL: {session.loginUrl}</p>
                  {session.currentUrl && <p>Current: {session.currentUrl}</p>}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {session.browserUrl && (
                    <a
                      href={session.browserUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-medium text-[var(--accent)]"
                    >
                      <ExternalLink size={14} />
                      Open browser in a new tab
                    </a>
                  )}
                  {session.fullscreenBrowserUrl && (
                    <a
                      href={session.fullscreenBrowserUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-medium text-[var(--accent)]"
                    >
                      <ExternalLink size={14} />
                      Open fullscreen
                    </a>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <Button variant="ghost" onClick={onClose}>Close</Button>
              {!session ? (
                <Button onClick={handleStart} disabled={isStarting}>
                  {isStarting ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
                  Start Connect
                </Button>
              ) : session.status === 'connected' ? (
                <Button onClick={onClose}>
                  <ExternalLink size={16} />
                  Connected
                </Button>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="app-kicker">Worker browser</p>
                <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">Real LinkedIn sign-in window</p>
              </div>
              {session && <StatusPill tone={toneForStatus(session.status)} dot>{session.status.replace(/_/g, ' ')}</StatusPill>}
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-white">
              {session?.browserUrl ? (
                <iframe
                  src={session.browserUrl}
                  title="LinkedIn worker browser"
                  className="h-[74vh] min-h-[620px] w-full"
                  referrerPolicy="no-referrer"
                  allow="fullscreen *; clipboard-read *; clipboard-write *"
                  allowFullScreen
                />
              ) : (
                <div className="flex h-[74vh] min-h-[620px] items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
                  Start a connect session to launch the worker-controlled LinkedIn browser here. If interactive connect is unavailable in your environment, use cookie import as the fallback.
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
