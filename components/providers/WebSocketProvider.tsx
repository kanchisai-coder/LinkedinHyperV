// FILE: components/providers/WebSocketProvider.tsx
'use client';

import { useEffect } from 'react';
import { wsClient } from '@/lib/websocket-client';
import { useAuth } from '@/components/providers/AuthProvider';
import toast from 'react-hot-toast';

type StatusChangedPayload = {
  status?: 'connected' | 'disconnected' | 'reconnecting';
};

type InboxNewMessagePayload = {
  senderName?: string;
  message?: {
    senderName?: string;
  };
};

function isLocalOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveWebSocketUrl(explicitUrl?: string): string {
  if (typeof window === 'undefined') {
    return explicitUrl || '';
  }

  const currentOrigin = window.location.origin;
  const configured = String(explicitUrl || '').trim();
  if (!configured) return currentOrigin;

  try {
    const parsed = new URL(configured, currentOrigin);
    const explicitOrigin = parsed.origin;

    // In production, never let a stale localhost build-time value override
    // the real public origin that the browser is already using.
    if (!isLocalOrigin(currentOrigin) && isLocalOrigin(explicitOrigin)) {
      return currentOrigin;
    }

    return explicitOrigin;
  } catch {
    return currentOrigin;
  }
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    // Avoid opening sockets for unauthenticated pages (login/register).
    if (isLoading || !isAuthenticated) {
      wsClient.disconnect();
      return;
    }

    const url = resolveWebSocketUrl(process.env.NEXT_PUBLIC_WS_URL);

    console.log('[WebSocket] Connecting to:', url);

    // Connect to WebSocket
    wsClient.connect(url);

    // Set up connection status listener
    const unsubscribeStatus = wsClient.on('status:changed', (data: StatusChangedPayload) => {
      if (data.status === 'connected') {
        toast.success('Connected to real-time updates', { duration: 2000 });
      } else if (data.status === 'disconnected') {
        toast.error('Disconnected from real-time updates', { duration: 2000 });
      }
    });

    // Set up global event handlers
    const unsubscribeAccountStatus = wsClient.on('account:status', (data) => {
      console.log('[WebSocket] Account status changed:', data);
      // Trigger global refresh if needed
    });

    const unsubscribeNewMessage = wsClient.on('inbox:new_message', (data: InboxNewMessagePayload) => {
      console.log('[WebSocket] New message received:', data);

      const senderName = data.message?.senderName || data.senderName || 'Someone';
      if (senderName !== '__self__' && !senderName.includes('account')) {
        toast.success(`New message from ${senderName}`, {
          icon: 'MSG',
          duration: 4000,
        });
      }
    });

    const unsubscribeInboxUpdate = wsClient.on('inbox:updated', (data) => {
      console.log('[WebSocket] Inbox updated:', data);
      // Pages will handle their own inbox updates
    });

    const unsubscribeRateLimit = wsClient.on('rate_limit:updated', (data) => {
      console.log('[WebSocket] Rate limit updated:', data);
    });

    const unsubscribeConnected = wsClient.on('connected', (data) => {
      console.log('[WebSocket] Connection confirmed:', data);
    });

    // Cleanup on unmount
    return () => {
      unsubscribeStatus();
      unsubscribeAccountStatus();
      unsubscribeNewMessage();
      unsubscribeInboxUpdate();
      unsubscribeRateLimit();
      unsubscribeConnected();
      wsClient.disconnect();
    };
  }, [isAuthenticated, isLoading]);

  return <>{children}</>;
}
