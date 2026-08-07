'use strict';

// The pacing engine (SLOW_FULL_SYNC §3). Decides which single (account, surface)
// harvest task — if any — may run on this tick. Every layer must pass; the
// default is "do nothing", which is exactly the slow drip we want.

const { getRedis } = require('../redisClient');
const harvestState = require('./harvestState');
const antiBan = require('../antiBan');
const { listKnownAccountIds } = require('../session');

const GLOBAL_OPS_PER_HOUR = parseInt(process.env.HARVEST_GLOBAL_OPS_PER_HOUR || '20', 10);
const ACCOUNT_OPS_PER_HOUR = parseInt(process.env.HARVEST_ACCOUNT_OPS_PER_HOUR || '6', 10);
const MIN_GAP_MS = parseInt(process.env.HARVEST_MIN_GAP_MS || '90000', 10);   // 90s
const MEAN_GAP_MS = parseInt(process.env.HARVEST_MEAN_GAP_MS || '480000', 10); // ~8m
const MAX_GAP_MS = parseInt(process.env.HARVEST_MAX_GAP_MS || '2400000', 10);  // 40m

// Token bucket via Redis fixed-window counters (good enough; not strict GCRA).
async function tokenAvailable(bucketKey, perHour) {
  const redis = getRedis();
  const windowKey = `${bucketKey}:${new Date().toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
  const used = await redis.eval(
    `local c = redis.call('INCR', KEYS[1])
     if c == 1 then redis.call('EXPIRE', KEYS[1], 3700) end
     return c`,
    1, windowKey
  ).catch(() => 0);
  if (Number(used) > perHour) {
    // roll back the increment we just consumed
    await redis.decr(windowKey).catch(() => null);
    return false;
  }
  return true;
}

function jitterGapMs() {
  // log-normal-ish: bias toward the mean, clamp to [MIN, MAX]
  const u = Math.random();
  const span = MAX_GAP_MS - MIN_GAP_MS;
  const biased = MIN_GAP_MS + span * Math.pow(u, 2.2); // skew toward shorter, long tail
  return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, Math.round((biased + MEAN_GAP_MS) / 2)));
}

/**
 * Choose the next eligible (accountId, surface) to harvest, or null.
 * Pure selection — does NOT consume tokens; the caller consumes on dispatch.
 */
async function pickNextTask() {
  let accountIds = [];
  try { accountIds = await listKnownAccountIds(); } catch { accountIds = []; }
  accountIds = accountIds.filter((a) => a && a !== 'connect');
  if (accountIds.length === 0) return null;

  const candidates = [];
  for (const accountId of accountIds) {
    // Account-level gates first (cheap rejects).
    if (!antiBan.isWithinBusinessHours(accountId)) continue;

    const states = await harvestState.getAll(accountId);
    for (const st of states) {
      if (st.phase === 'caught_up' && !st.nextEligibleAt) {
        // caught_up with no scheduled delta → low-priority re-check occasionally
      }
      if (!harvestState.isEligibleNow(st)) continue;

      // antiBan gate (account cooldown / surface breaker / business hours).
      const surfaceForGate = st.surface === 'messages' ? 'thread'
        : st.surface === 'conversations' ? 'inbox'
        : st.surface;
      const gate = await antiBan.gateAction({ accountId, surface: surfaceForGate }).catch(() => ({ allowed: false }));
      if (!gate.allowed) continue;

      const ageBonus = st.lastSuccessAt ? Math.min(50, (Date.now() - new Date(st.lastSuccessAt).getTime()) / 3600000) : 50;
      const weight = (harvestState.PRIORITY[st.surface] || 1) + ageBonus;
      candidates.push({ accountId, surface: st.surface, weight, state: st });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0];
}

/**
 * Consume global + per-account tokens for a chosen task. Returns true if the
 * task may proceed; false if a bucket is exhausted.
 */
async function consumeTokens(accountId) {
  if (!(await tokenAvailable('harvest:bucket:global', GLOBAL_OPS_PER_HOUR))) return false;
  if (!(await tokenAvailable(`harvest:bucket:acct:${accountId}`, ACCOUNT_OPS_PER_HOUR))) return false;
  return true;
}

function nextGapIso() {
  return new Date(Date.now() + jitterGapMs()).toISOString();
}

module.exports = { pickNextTask, consumeTokens, nextGapIso, jitterGapMs };
