'use strict';

const accountRepo = require('./db/repositories/AccountRepository');
const { listKnownAccountIds } = require('./session');

function normalizeAccountKey(value) {
  return String(value || '').trim().toLowerCase();
}

function dedupeAccountIds(ids = []) {
  const chosen = new Map();

  for (const candidate of ids) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;

    const key = normalizeAccountKey(raw);
    const previous = chosen.get(key);
    if (!previous) {
      chosen.set(key, raw);
      continue;
    }

    const previousHasUppercase = /[A-Z]/.test(previous);
    const currentHasUppercase = /[A-Z]/.test(raw);
    if (!previousHasUppercase && currentHasUppercase) {
      chosen.set(key, raw);
    }
  }

  return Array.from(chosen.values()).sort((left, right) => left.localeCompare(right));
}

async function resolveCanonicalAccountId(accountId) {
  const raw = String(accountId || '').trim();
  if (!raw) return raw;

  const dbMatch = await accountRepo.findCaseInsensitive(raw).catch(() => null);
  if (dbMatch?.id) return dbMatch.id;

  const knownIds = await listKnownAccountIds().catch(() => []);
  const key = normalizeAccountKey(raw);
  const knownMatch = knownIds.find((id) => normalizeAccountKey(id) === key);
  return knownMatch || raw;
}

module.exports = {
  normalizeAccountKey,
  dedupeAccountIds,
  resolveCanonicalAccountId,
};
