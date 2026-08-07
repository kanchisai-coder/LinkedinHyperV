'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePositiveInt } = require('./SyncOrchestrator');

test('returns the default when env var is not set', () => {
  assert.equal(parsePositiveInt(undefined, 5), 5);
});

test('returns the parsed value when env var is set', () => {
  assert.equal(parsePositiveInt('10', 5), 10);
});

test('falls back to default for non-numeric input', () => {
  assert.equal(parsePositiveInt('bad', 5), 5);
});
