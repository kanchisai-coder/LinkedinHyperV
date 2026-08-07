'use strict';

// Realtime event-stream connector — Phase 2 of the master plan.
//
// LinkedIn's web app holds a long-lived connection to /realtime/connect and
// receives message/typing/read events the instant they happen. We reproduce
// that from INSIDE the authenticated browser page via a streaming fetch, so the
// connection shares the exact cookies/proxy/TLS-fingerprint of the real client.
// Frames are forwarded to Node through an exposed binding and emitted as events.
//
// Usage:
//   const rc = new RealtimeConnector(accountId);
//   rc.on('event', (frame) => ...);   // raw decoded frame
//   rc.on('message', (msg) => ...);   // convenience: message events only
//   await rc.start();
//   ...
//   await rc.stop();

const { EventEmitter } = require('events');
const { getAuthedContext } = require('./session');

const REALTIME_URL = 'https://www.linkedin.com/realtime/connect?rc=1';
const REALTIME_TOPICS = [
  // Message + conversation events (the important ones).
  'urn:li-realtime:messagingTopic',
  'urn:li-realtime:conversationsTopic',
  'urn:li-realtime:messageSeenReceiptsTopic',
  'urn:li-realtime:typingIndicatorsTopic',
  'urn:li-realtime:invitationsTopic',
];

class RealtimeConnector extends EventEmitter {
  constructor(accountId, options = {}) {
    super();
    this.accountId = accountId;
    this.options = options;
    this._page = null;
    this._ctx = null;
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._maxReconnectDelayMs = options.maxReconnectDelayMs || 30000;
  }

  async start() {
    this._stopped = false;
    this._ctx = await getAuthedContext(this.accountId, this.options);
    if (!this._ctx.hasSession) {
      throw new Error(`No LinkedIn session for ${this.accountId}; cannot open realtime stream`);
    }
    await this._connect();
  }

  async _connect() {
    if (this._stopped) return;
    const { context } = this._ctx;
    this._page = await context.newPage();

    // Bridge: in-page JS calls window.__rtFrame(text) for each frame; we parse
    // it in Node. exposeFunction survives navigations on this page.
    await this._page.exposeFunction('__rtFrame', (chunk) => this._onChunk(chunk));
    await this._page.exposeFunction('__rtClosed', (reason) => this._onClosed(reason));

    // Navigate to LinkedIn first so fetch() runs with first-party cookies.
    await this._page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    }).catch(() => {});

    // Open the streaming fetch INSIDE the page. We read the body as a stream and
    // forward each newline-delimited frame back to Node.
    await this._page.evaluate(async ({ url, topics }) => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': 'text/event-stream',
            'x-li-realtime-session': '1',
            'x-li-recipe-accept': 'application/vnd.linkedin.deduped+x-protobuf',
            'x-li-query-accept': topics.join(','),
          },
        });
        if (!res.ok || !res.body) {
          window.__rtClosed(`status ${res.status}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) { window.__rtClosed('eof'); break; }
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) window.__rtFrame(line);
          }
        }
      } catch (e) {
        window.__rtClosed('error: ' + (e && e.message ? e.message : String(e)));
      }
    }, { url: REALTIME_URL, topics: REALTIME_TOPICS });

    this._reconnectAttempts = 0;
    this.emit('connected', { accountId: this.accountId });
  }

  _onChunk(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // heartbeat or partial; ignore
    }
    this.emit('event', frame);
    this._routeFrame(frame);
  }

  _routeFrame(frame) {
    // LinkedIn wraps events in com.linkedin.realtimefrontend.DecoratedEvent.
    const decorated = frame?.['com.linkedin.realtimefrontend.DecoratedEvent'] || frame;
    const payload = decorated?.payload || decorated;
    const topic = String(decorated?.topic || '');

    if (topic.includes('messaging') || payload?.event || payload?.eventUrn) {
      this.emit('message', this._normalizeMessageFrame(payload, topic));
    } else if (topic.includes('typingIndicators')) {
      this.emit('typing', payload);
    } else if (topic.includes('SeenReceipts')) {
      this.emit('read', payload);
    } else if (topic.includes('invitations')) {
      this.emit('invitation', payload);
    }
  }

  _normalizeMessageFrame(payload, topic) {
    // Best-effort shallow normalization for the spike; the real Normalizer in
    // Phase 3 maps to the canonical schema + dedupeKey.
    const ev = payload?.event || payload;
    return {
      accountId: this.accountId,
      topic,
      raw: payload,
      eventUrn: ev?.entityUrn || ev?.eventUrn || null,
      receivedAt: new Date().toISOString(),
    };
  }

  async _onClosed(reason) {
    this.emit('disconnected', { accountId: this.accountId, reason });
    await this._teardownPage();
    if (this._stopped) return;

    // Jittered exponential backoff reconnect.
    this._reconnectAttempts += 1;
    const base = Math.min(this._maxReconnectDelayMs, 1000 * 2 ** this._reconnectAttempts);
    const delay = Math.floor(base * (0.5 + Math.random() * 0.5));
    this.emit('reconnecting', { accountId: this.accountId, attempt: this._reconnectAttempts, delayMs: delay });
    setTimeout(() => this._connect().catch((e) => this.emit('error', e)), delay).unref?.();
  }

  async _teardownPage() {
    if (this._page) {
      await this._page.close().catch(() => {});
      this._page = null;
    }
  }

  async stop() {
    this._stopped = true;
    await this._teardownPage();
    this.emit('stopped', { accountId: this.accountId });
  }
}

module.exports = { RealtimeConnector, REALTIME_URL, REALTIME_TOPICS };
