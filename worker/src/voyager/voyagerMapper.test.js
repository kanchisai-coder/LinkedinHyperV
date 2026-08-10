'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMessageText, mapEvents } = require('./voyagerMapper');

test('extractMessageText reads the MessageEvent wrapper shape', () => {
  const frame = {
    eventContent: {
      'com.linkedin.voyager.messaging.event.MessageEvent': {
        attributedBody: { text: 'hello from realtime' },
      },
    },
  };
  assert.equal(extractMessageText(frame), 'hello from realtime');
});

test('extractMessageText reads the top-level MessageEvent shape', () => {
  const frame = {
    'com.linkedin.voyager.messaging.event.MessageEvent': {
      attributedBody: { text: 'wrapped at top level' },
    },
  };
  assert.equal(extractMessageText(frame), 'wrapped at top level');
});

test('extractMessageText falls back to body then subject then empty', () => {
  assert.equal(extractMessageText({ eventContent: { body: 'plain body' } }), 'plain body');
  assert.equal(extractMessageText({}), '');
  assert.equal(extractMessageText(null), '');
});

test('mapEvents preserves the full message URN as externalId (durable dedupe)', () => {
  const payload = {
    elements: [
      {
        entityUrn: 'urn:li:fsd_message:2-abcDEF==',
        createdAt: 1700000000000,
        eventContent: {
          'com.linkedin.voyager.messaging.event.MessageEvent': {
            attributedBody: { text: 'hi' },
          },
        },
        from: { miniProfile: { firstName: 'Jane', lastName: 'Doe' } },
      },
    ],
  };
  const { items } = mapEvents(payload, { accountId: 'alice' });
  assert.equal(items.length, 1);
  // Must keep the urn: prefix so the normalizer treats it as a durable id.
  assert.equal(items[0].externalId, 'urn:li:fsd_message:2-abcDEF==');
  assert.equal(items[0].raw.eventUrn, 'urn:li:fsd_message:2-abcDEF==');
});
