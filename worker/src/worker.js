'use strict';

const { Worker } = require('bullmq');
const { createRedisClient }             = require('./redisClient');
const { getQueueName, getConnectQueueName, getQueue } = require('./queue');
const { dedupeAccountIds } = require('./accountIdentity');
const { listKnownAccountIds } = require('./session');

const { verifySession }         = require('./actions/login');
const { startLinkedInConnectSession } = require('./actions/connectSession');
const { readMessages }          = require('./actions/readMessages');
const { readThread }            = require('./actions/readThread');
const { sendMessage }           = require('./actions/sendMessage');
const { sendMessageNew }        = require('./actions/sendMessageNew');
const { sendConnectionRequest } = require('./actions/connect');
const { searchPeople }          = require('./actions/searchPeople');
const { syncAllAccounts }       = require('./services/messageSyncService');
const { syncAccountUnified, resolveConversationThreads, scheduleAdaptiveSync } = require('./unified/SyncOrchestrator');

// Concurrency 1 per account: LinkedIn triggers bans on parallel browser instances for the same IP/account.
// (Cross-account parallelism is achieved by having one Worker per account queue.)
const CONCURRENCY = 1;
// PERF (Phase 2.2): hard ceiling on a single job's runtime. Without this, a hung
// Playwright call can hold the account lock for the full lockDuration (120s),
// starving every queued action on that account.
const JOB_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.WORKER_JOB_TIMEOUT_MS || '90000', 10)
);
const workerRegistry = new Map();
let accountRefreshTimer = null;

function withJobTimeout(promise, name, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Job ${name} exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function purgeLegacyDefaultQueueJobs() {
  const defaultQueue = getQueue('default');
  let removedSchedulers = 0;
  let removedJobs = 0;

  if (typeof defaultQueue.getJobSchedulers === 'function') {
    const schedulers = await defaultQueue.getJobSchedulers().catch(() => []);
    for (const scheduler of schedulers) {
      if (!['unifiedSync', 'threadResolve', 'messageSync'].includes(scheduler?.name)) continue;
      if (!scheduler?.key) continue;
      await defaultQueue.removeJobScheduler(scheduler.key).catch(() => {});
      removedSchedulers += 1;
    }
  }

  if (typeof defaultQueue.getRepeatableJobs === 'function') {
    const repeatables = await defaultQueue.getRepeatableJobs().catch(() => []);
    for (const job of repeatables) {
      if (!['unifiedSync', 'threadResolve', 'messageSync'].includes(job?.name)) continue;
      if (!job?.key) continue;
      await defaultQueue.removeRepeatableByKey(job.key).catch(() => {});
      removedSchedulers += 1;
    }
  }

  if (typeof defaultQueue.getJobs === 'function') {
    const jobs = await defaultQueue.getJobs(['waiting', 'delayed', 'prioritized']).catch(() => []);
    for (const job of jobs) {
      const accountId = String(job?.data?.accountId || '').trim();
      const shouldRemove =
        job?.name === 'threadResolve' ||
        job?.name === 'messageSync' ||
        (job?.name === 'unifiedSync') ||
        (accountId && accountId !== 'default');
      if (!shouldRemove) continue;
      await job.remove().catch(() => {});
      removedJobs += 1;
    }
  }

  return { removedSchedulers, removedJobs };
}

function createQueueWorker(queueName, label, handlers) {
  const worker = new Worker(
    queueName,
    async (job) => {
      const { name, data } = job;
      console.log(`[Worker:${label}] Processing job ${job.id}: ${name}`);

      const handler = handlers[name];
      if (!handler) {
        throw new Error(`Unknown job type: ${name}`);
      }
      // Per-job hard timeout — must stay below lockDuration so BullMQ doesn't
      // re-deliver before we surface the failure.
      return withJobTimeout(
        Promise.resolve().then(() => handler(data)),
        name,
        JOB_TIMEOUT_MS
      );
    },
    {
      connection:    createRedisClient(),
      concurrency:   CONCURRENCY,
      lockDuration:  120_000,
      lockRenewTime: 60_000,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[Worker:${label}] Job ${job.id} (${job.name}) completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[Worker:${label}] Job ${job.id} (${job?.name}) failed:`,
      err?.message || String(err)
    );
    if (err?.stack) {
      console.error(`[Worker:${label}] Failure stack:\n${err.stack}`);
    }
  });

  worker.on('error', (err) => {
    console.error(`[Worker:${label}] Worker error:`, err);
  });

  return worker;
}

function getSharedHandlers() {
  return {
    verifySession,
    readMessages,
    readThread,
    sendMessage,
    sendMessageNew,
    sendConnectionRequest,
    searchPeople,
    messageSync: (data) => syncAllAccounts(data.proxyUrl),
    unifiedSync: (data) => syncAccountUnified(data.accountId || 'default', data),
    threadResolve: (data) => resolveConversationThreads(data.accountId || 'default', data),
  };
}

function ensureWorker(queueName, label, handlers) {
  if (workerRegistry.has(label)) {
    return workerRegistry.get(label);
  }

  const worker = createQueueWorker(queueName, label, handlers);
  workerRegistry.set(label, worker);
  return worker;
}

async function discoverAccountIds() {
  const configured = (process.env.ACCOUNT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const known = await listKnownAccountIds().catch(() => []);
  return dedupeAccountIds([...configured, ...known]);
}

async function refreshAccountWorkers() {
  if (process.env.DISABLE_QUEUE === '1') return [];

  const handlers = getSharedHandlers();
  const ids = await discoverAccountIds();
  const started = [];

  for (const accountId of ids) {
    if (accountId === 'connect') continue;
    const worker = ensureWorker(getQueueName(accountId), accountId, handlers);
    started.push(worker);
  }

  ensureWorker(getConnectQueueName(), 'connect', { startLinkedInConnectSession });
  return started;
}

async function ensureAccountWorkers(accountIds = []) {
  const handlers = getSharedHandlers();
  const ids = dedupeAccountIds(accountIds).filter(Boolean);
  for (const accountId of ids) {
    if (accountId === 'connect') continue;
    ensureWorker(getQueueName(accountId), accountId, handlers);
  }
  return ids;
}

function startWorker() {
  if (process.env.DISABLE_QUEUE === '1') {
    console.log('[Worker] Queue workers disabled by DISABLE_QUEUE=1');
    return [];
  }

  purgeLegacyDefaultQueueJobs()
    .catch((error) => {
      console.error('[Worker] Failed to purge legacy default queue jobs:', error);
      return { removedSchedulers: 0, removedJobs: 0 };
    })
    .then((cleanupResult) => {
      if ((cleanupResult?.removedSchedulers || 0) > 0 || (cleanupResult?.removedJobs || 0) > 0) {
        console.log(
          `[Worker] Removed ${cleanupResult.removedSchedulers || 0} legacy default scheduler(s) and ` +
          `${cleanupResult.removedJobs || 0} queued job(s).`
        );
      }
      return refreshAccountWorkers();
    })
    .then((workers) => {
      console.log(`[Worker] Started ${workers.length + 1} worker threads with concurrency ${CONCURRENCY} per worker.`);
    })
    .catch((error) => {
      console.error('[Worker] Failed to initialize account workers:', error);
    });

  if (accountRefreshTimer) clearInterval(accountRefreshTimer);
  accountRefreshTimer = setInterval(() => {
    refreshAccountWorkers().catch((error) => {
      console.error('[Worker] Failed to refresh account workers:', error);
    });
    if (process.env.DISABLE_MESSAGE_SYNC !== '1' && process.env.DISABLE_UNIFIED_SYNC !== '1') {
      scheduleAdaptiveSync().catch((error) => {
        console.error('[Worker] Failed to refresh unified sync schedules:', error);
      });
    }
  }, 60_000);
  
  if (process.env.DISABLE_MESSAGE_SYNC === '1' || process.env.DISABLE_UNIFIED_SYNC === '1') {
    console.log('[Worker] Unified sync scheduler disabled by DISABLE_MESSAGE_SYNC=1 or DISABLE_UNIFIED_SYNC=1');
    return Array.from(workerRegistry.values());
  }

  // Schedule adaptive unified sync: fast deltas, slower backfills, one worker per account queue.
  scheduleAdaptiveSync().then((result) => {
    console.log(
      `[Worker] Scheduled unified sync for ${result.scheduledAccounts} account(s): ` +
      `delta every ${result.syncIntervalMinutes}m, backfill every ${result.backfillIntervalMinutes}m`
    );
  }).catch((error) => {
    console.error('[Worker] Failed to schedule unified sync:', error);
    if (process.env.ENABLE_LEGACY_MESSAGE_SYNC === '1') {
      scheduleMessageSync();
    }
  });
  
  return Array.from(workerRegistry.values());
}

/**
 * Schedule recurring message sync job
 * Syncs every 10 minutes to respect rate limits (6 syncs/hour < 30 reads/hour)
 */
async function scheduleMessageSync() {
  const { getQueue } = require('./queue');
  const queue = getQueue();
  
  const syncIntervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES || '10', 10);
  const proxyUrl = process.env.PROXY_URL || null;

  try {
    // Remove any existing message sync jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === 'messageSync') {
        await queue.removeRepeatableByKey(job.key);
        console.log('[Worker] Removed existing messageSync job');
      }
    }

    // Add recurring message sync job
    await queue.add(
      'messageSync',
      { proxyUrl },
      {
        repeat: {
          pattern: `*/${syncIntervalMinutes} * * * *`, // Every N minutes
        },
        jobId: 'messageSync-recurring',
      }
    );

    console.log(`[Worker] Scheduled message sync every ${syncIntervalMinutes} minutes`);

    // Trigger initial sync after 30 seconds (give system time to start)
    setTimeout(async () => {
      try {
        await queue.add('messageSync', { proxyUrl }, { jobId: 'messageSync-initial' });
        console.log('[Worker] Triggered initial message sync');
      } catch (error) {
        console.error('[Worker] Initial message sync skipped:', error.message);
      }
    }, 30000);

  } catch (error) {
    console.error('[Worker] Failed to schedule message sync:', error);
  }
}

module.exports = { startWorker, ensureAccountWorkers };
