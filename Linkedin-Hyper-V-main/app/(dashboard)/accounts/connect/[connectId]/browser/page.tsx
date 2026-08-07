'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusPill } from '@/components/ui/StatusPill';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/ErrorState';
import { getLinkedInConnectStatus } from '@/lib/api-client';
import type { ConnectSessionStatus } from '@/types/dashboard';

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

function browserFrameUrl(session: ConnectSessionStatus | null) {
  return session?.browserUrl || null;
}

export default function ConnectBrowserPage() {
  const params = useParams<{ connectId: string }>();
  const connectId = String(params?.connectId || '');
  const [session, setSession] = useState<ConnectSessionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    if (!connectId) return;
    setError(null);
    try {
      const next = await getLinkedInConnectStatus(connectId);
      setSession({
        ...next,
        fullscreenBrowserUrl: `/accounts/connect/${encodeURIComponent(next.connectId)}/browser`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load connect session');
    } finally {
      setLoading(false);
    }
  }, [connectId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!session || ['connected', 'failed', 'expired'].includes(session.status)) return undefined;

    const timer = setInterval(() => {
      void loadSession();
    }, 2500);

    return () => clearInterval(timer);
  }, [loadSession, session]);

  const frameUrl = useMemo(() => browserFrameUrl(session), [session]);

  if (loading) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void loadSession()} />;
  }

  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <PageHeader
        eyebrow="LinkedIn Connect"
        title={session ? `Worker browser for ${session.accountId}` : 'Worker browser'}
        description="Use the worker-controlled LinkedIn window for interactive sign-in and recovery. This is the same noVNC session, just with more breathing room."
        actions={
          <>
            <StatusPill tone={session ? toneForStatus(session.status) : 'neutral'} dot>
              {session ? session.status.replace(/_/g, ' ') : 'unknown'}
            </StatusPill>
            <Button variant="secondary" onClick={() => void loadSession()}>
              <RefreshCcw size={16} />
              Refresh
            </Button>
            <Link href="/accounts" className="app-button app-button-secondary h-10 px-4 text-sm">
              <ArrowLeft size={16} />
              Back to accounts
            </Link>
            {session?.browserUrl && (
              <a href={session.browserUrl} target="_blank" rel="noreferrer" className="app-button app-button-primary h-10 px-4 text-sm">
                <ExternalLink size={16} />
                Raw noVNC tab
              </a>
            )}
          </>
        }
      />

      <div className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6 lg:px-8">
        <div className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">{session?.message || 'Waiting for session state'}</p>
              <div className="mt-2 space-y-1 text-xs text-[var(--text-muted)]">
                <p>Login URL: {session?.loginUrl || 'Unavailable'}</p>
                {session?.currentUrl && <p>Current URL: {session.currentUrl}</p>}
              </div>
            </div>
            <StatusPill tone={session ? toneForStatus(session.status) : 'neutral'} dot>
              {session ? session.status.replace(/_/g, ' ') : 'unknown'}
            </StatusPill>
          </div>
        </div>

        <div className="overflow-hidden rounded-3xl border border-[var(--border)] bg-white shadow-sm">
          {frameUrl ? (
            <iframe
              src={frameUrl}
              title="LinkedIn worker browser fullscreen"
              className="h-[calc(100vh-15rem)] min-h-[720px] w-full"
              referrerPolicy="no-referrer"
              allow="fullscreen *; clipboard-read *; clipboard-write *"
              allowFullScreen
            />
          ) : (
            <div className="flex h-[calc(100vh-15rem)] min-h-[720px] items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
              This connect session does not have an active worker browser anymore. Start a new connect session from Accounts to continue.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
