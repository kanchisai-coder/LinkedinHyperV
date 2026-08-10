// FILE: lib/websocket-client.ts
'use client';

import { io, Socket } from 'socket.io-client';

type SocketEventPayload = unknown;
type ListenerCallback = (data: SocketEventPayload) => void;

export class WebSocketClient {
  private socket: Socket | null = null;
  private listeners: Map<string, Set<ListenerCallback>> = new Map();
  private url: string = '';
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000; // 30 seconds
  private _isConnected: boolean = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  private normalizeSocketOrigin(rawUrl: string): string {
    if (typeof window !== 'undefined' && String(rawUrl || '').trim().startsWith('/')) {
      return window.location.origin;
    }
    try {
      const parsed = new URL(rawUrl);
      // Socket.IO expects HTTP(S) origin; WS(S) can cause client-side edge-case failures.
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      return parsed.origin;
    } catch {
      return rawUrl;
    }
  }

  connect(url: string): void {
    if (!url || typeof window === 'undefined') return;
    
    const origin = this.normalizeSocketOrigin(url);
    if (this.socket && this.url === origin && (this.socket.connected || this.socket.active)) {
      return;
    }

    if (this.socket && this.url !== origin) {
      this.disconnect();
    }

    this.url = origin;

    // PERF (Phase 3.1): default to WebSocket-only transport. The HTTP long-poll
    // fallback floods the worker with ~1Hz requests per tab whenever a WS reconnect
    // is in progress; that destroys cache hit rate and pegs the API loop.
    // Set NEXT_PUBLIC_ALLOW_WS_FALLBACK=1 to re-enable polling for restrictive networks.
    const allowPolling =
      typeof process !== 'undefined' &&
      process.env?.NEXT_PUBLIC_ALLOW_WS_FALLBACK === '1';
    const transports = allowPolling ? ['websocket', 'polling'] : ['websocket'];

    try {
      this.socket = io(origin, {
        path: '/socket.io',
        transports,
        withCredentials: true,
        reconnection: true,
        // Exponential-ish backoff: start at 1s, cap at maxReconnectDelay (30s).
        reconnectionDelay: 1000,
        reconnectionDelayMax: this.maxReconnectDelay,
        randomizationFactor: 0.5,
        reconnectionAttempts: Infinity,
      });

      this.socket.on('connect', () => {
        console.log('[WebSocket] Connected');
        this._isConnected = true;
        this.reconnectAttempts = 0;
        this.notifyStatusListeners('connected');
      });

      this.socket.on('disconnect', (reason) => {
        console.log('[WebSocket] Disconnected:', reason);
        this._isConnected = false;
        this.notifyStatusListeners('disconnected');
      });

      this.socket.on('connect_error', (error) => {
        // In dev mode this can happen during worker restarts or transport fallback.
        // Use warn instead of error to avoid noisy Next.js error overlays.
        console.warn('[WebSocket] Connection warning:', error.message);
        this.reconnectAttempts++;
        this.notifyStatusListeners('reconnecting');
      });

      this.socket.on('reconnect', (attemptNumber) => {
        console.log(`[WebSocket] Reconnected after ${attemptNumber} attempts`);
        this._isConnected = true;
        this.reconnectAttempts = 0;
        this.notifyStatusListeners('connected');
      });

      this.socket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`[WebSocket] Reconnection attempt ${attemptNumber}`);
        this.notifyStatusListeners('reconnecting');
      });

      // Listen for all custom events
      this.socket.onAny((event, data) => {
        if (this.listeners.has(event)) {
          this.listeners.get(event)?.forEach((callback) => {
            callback(data);
          });
        }
      });

    } catch (err) {
      console.error('[WebSocket] Connection failed:', err);
    }
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this._isConnected = false;
    }
  }

  on<T = unknown>(event: string, callback: (data: T) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const wrapped = callback as ListenerCallback;
    this.listeners.get(event)!.add(wrapped);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(event);
      if (callbacks) {
        callbacks.delete(wrapped);
        if (callbacks.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  emit(event: string, data: SocketEventPayload): void {
    if (this.socket && this.socket.connected) {
      this.socket.emit(event, data);
    }
  }

  joinAccountRoom(accountId: string): void {
    this.emit('join:account', accountId);
  }

  leaveAccountRoom(accountId: string): void {
    this.emit('leave:account', accountId);
  }

  private notifyStatusListeners(status: 'connected' | 'disconnected' | 'reconnecting'): void {
    if (this.listeners.has('status:changed')) {
      this.listeners.get('status:changed')?.forEach((callback) => {
        callback({ status });
      });
    }
  }
}

export const wsClient = new WebSocketClient();
