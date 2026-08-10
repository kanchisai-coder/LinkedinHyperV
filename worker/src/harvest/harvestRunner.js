'use strict';

// The drip loop. Every tick (~60s) asks the scheduler for at most ONE eligible
// task, consumes its tokens, runs one page, and schedules the next jittered gap.
// Gated by ENABLE_BACKFILL=1. This is what makes the full-sync "slow".

const scheduler = require('./harvestScheduler');
const orchestrator = require('./backfillOrchestrator');
const harvestState = require('./harvestState');

const TICK_MS = parseInt(process.env.HARVEST_TICK_MS || '60000', 10);
let timer = null;
let running = false;

function enabled() {
  return String(process.env.ENABLE_BACKFILL || '').trim() === '1';
}

async function tick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const task = await scheduler.pickNextTask();
    if (!task) return;

    if (!(await scheduler.consumeTokens(task.accountId))) return; // bucket exhausted

    const res = await orchestrator.runOnce(task);
    // Set the next jittered eligibility gap for this surface regardless of outcome
    // (block path already set a longer nextEligibleAt).
    if (res.ok) {
      await harvestState.patch(task.accountId, task.surface, {
        nextEligibleAt: scheduler.nextGapIso(),
      });
      console.log(`[harvest] ${task.accountId}/${task.surface} -> ${res.phase} (fetched=${res.fetched ?? '?'}/${res.total ?? '?'})`);
    } else {
      console.warn(`[harvest] ${task.accountId}/${task.surface} failed: ${res.error}${res.blocked ? ' (BLOCKED, 48h cooldown)' : ''}`);
    }
  } catch (err) {
    console.error('[harvest] tick error:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (!enabled()) {
    console.log('[harvest] ENABLE_BACKFILL not set — slow full-sync disabled');
    return { stop: () => {} };
  }
  console.log(`[harvest] slow full-sync ENABLED (tick ${TICK_MS}ms)`);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  return { stop: () => { if (timer) clearInterval(timer); } };
}

module.exports = { start, tick, enabled };
