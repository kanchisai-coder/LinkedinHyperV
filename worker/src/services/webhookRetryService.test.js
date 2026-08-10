'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextBackoffMinutes, MAX_ATTEMPTS } = require('./webhookRetryService');

test('uses 5-minute backoff on first retry', () => {
  assert.equal(nextBackoffMinutes(1), 5);
});

test('uses 360-minute backoff at max attempts', () => {
  assert.equal(nextBackoffMinutes(MAX_ATTEMPTS), 360);
});

test('caps at the final backoff bucket beyond max attempts', () => {
  assert.equal(nextBackoffMinutes(MAX_ATTEMPTS + 10), 360);
});
