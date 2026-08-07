'use strict';

const { Queue, QueueEvents } = require('bullmq');
const { createRedisClient }  = require('./redisClient');

let _queues            = new Map();
let _queueClients      = new Map();
let _queueEvents       = new Map();
let _queueEventsClients = new Map();
const CONNECT_QUEUE_ACCOUNT_ID = 'connect';

function configuredWorkerIds() {
  return new Set(
    (process.env.ACCOUNT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function resolveQueueAccountId(accountId = 'default') {
  const normalized = String(accountId).trim() || 'default';
  if (normalized === 'default') return 'default';
  if (normalized === CONNECT_QUEUE_ACCOUNT_ID) return CONNECT_QUEUE_ACCOUNT_ID;
  return normalized;
}

function getQueueName(accountId = 'default') {
  const normalized = resolveQueueAccountId(accountId);
  // BullMQ disallows ":" in queue names.
  const safeAccountId = normalized.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `linkedin-jobs-${safeAccountId}`;
}

function getQueue(accountId = 'default') {
  const queueAccountId = resolveQueueAccountId(accountId);
  if (_queues.has(queueAccountId)) return _queues.get(queueAccountId);
  // Store client alongside singleton so its connection is never orphaned.
  const client = createRedisClient();
  const q = new Queue(getQueueName(queueAccountId), { connection: client });
  q.on('error', (err) => {
    console.error(`[Queue:${queueAccountId}]`, err.message);
  });
  _queues.set(queueAccountId, q);
  _queueClients.set(queueAccountId, client);
  return q;
}

function getConnectQueueName() {
  return getQueueName(CONNECT_QUEUE_ACCOUNT_ID);
}

function getConnectQueue() {
  return getQueue(CONNECT_QUEUE_ACCOUNT_ID);
}

function getQueueEvents(accountId = 'default') {
  const queueAccountId = resolveQueueAccountId(accountId);
  if (_queueEvents.has(queueAccountId)) return _queueEvents.get(queueAccountId);
  const client = createRedisClient();
  const qe = new QueueEvents(getQueueName(queueAccountId), { connection: client });
  qe.on('error', (err) => {
    console.error(`[QueueEvents:${queueAccountId}]`, err.message);
  });
  _queueEvents.set(queueAccountId, qe);
  _queueEventsClients.set(queueAccountId, client);
  return qe;
}

module.exports = {
  getQueue,
  getConnectQueue,
  getQueueEvents,
  getQueueName,
  getConnectQueueName,
  resolveQueueAccountId,
};
