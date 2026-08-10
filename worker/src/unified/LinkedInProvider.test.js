'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeLinkedInProfileUrl,
  normalizeConnectionCandidate,
  buildBlockedPageError,
  buildAutomationWarningError,
} = require('./connectionScraper');

test('canonicalizeLinkedInProfileUrl keeps canonical /in/ URLs', () => {
  assert.equal(
    canonicalizeLinkedInProfileUrl('https://www.linkedin.com/in/jane-doe-123/?trk=abc#about'),
    'https://www.linkedin.com/in/jane-doe-123'
  );
});

test('canonicalizeLinkedInProfileUrl rejects non-profile LinkedIn URLs', () => {
  assert.equal(
    canonicalizeLinkedInProfileUrl('https://www.linkedin.com/company/openai/?trk=feed'),
    null
  );
  assert.equal(
    canonicalizeLinkedInProfileUrl('https://www.linkedin.com/feed/'),
    null
  );
});

test('normalizeConnectionCandidate accepts strong profile candidates', () => {
  const result = normalizeConnectionCandidate('Friendy', {
    profileUrl: 'https://www.linkedin.com/in/jane-doe-123/?trk=abc',
    name: 'Jane Doe',
    headline: 'Software Engineer',
    rowText: 'Jane Doe Software Engineer',
    source: 'card',
    rowIndex: 2,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.item.profileUrl, 'https://www.linkedin.com/in/jane-doe-123');
  assert.equal(result.item.name, 'Jane Doe');
  assert.equal(result.item.headline, 'Software Engineer');
});

test('normalizeConnectionCandidate rejects candidates without canonical profile URLs', () => {
  const result = normalizeConnectionCandidate('Friendy', {
    profileUrl: 'https://www.linkedin.com/company/openai/',
    name: 'OpenAI',
    rowText: 'OpenAI',
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'missing_profile_url');
});

test('normalizeConnectionCandidate rejects self profile rows', () => {
  const result = normalizeConnectionCandidate('Friendy', {
    profileUrl: 'https://www.linkedin.com/in/friendy/',
    name: 'Friendy',
    rowText: 'Friendy Founder',
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'self_profile');
});

test('buildBlockedPageError classifies checkpoint and authwall diagnostics', () => {
  const checkpoint = buildBlockedPageError('Friendy', {
    finalUrl: 'https://www.linkedin.com/checkpoint/challenge/',
    textSample: 'Security verification required',
  });
  const authwall = buildBlockedPageError('Friendy', {
    finalUrl: 'https://www.linkedin.com/authwall?trk=foo',
    textSample: 'Sign in to view more',
  });

  assert.equal(checkpoint.code, 'CHECKPOINT_INCOMPLETE');
  assert.equal(authwall.code, 'AUTHWALL_REDIRECT');
});

test('buildAutomationWarningError preserves warning diagnostics', () => {
  const error = buildAutomationWarningError('Friendy', {
    finalUrl: 'https://www.linkedin.com/checkpoint/challengesV2/',
    textSample: 'We noticed unusual activity that appears automated.',
  });

  assert.equal(error.code, 'AUTOMATION_WARNING');
  assert.equal(error.warningUrl, 'https://www.linkedin.com/checkpoint/challengesV2/');
});
