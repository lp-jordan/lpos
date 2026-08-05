import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTranscript } from '../lib/passprep/generate-fields';

test('sampleTranscript: short transcript is returned whole', () => {
  const short = 'A short lesson transcript that easily fits the budget.';
  assert.equal(sampleTranscript(short), short);
});

test('sampleTranscript: long transcript keeps head AND tail with a marker', () => {
  const head = 'HEAD '.repeat(1200); // ~6000 chars
  const tail = ' TAILEND';
  const long = head + 'x'.repeat(5000) + tail;
  const out = sampleTranscript(long);
  assert.ok(out.startsWith('HEAD'), 'keeps the beginning');
  assert.ok(out.includes('middle of transcript trimmed'), 'inserts the trim marker');
  assert.ok(out.trimEnd().endsWith('TAILEND'), 'keeps the end');
  assert.ok(out.length < long.length, 'is shorter than the original');
});

test('sampleTranscript: handles empty / whitespace', () => {
  assert.equal(sampleTranscript(''), '');
  assert.equal(sampleTranscript('   '), '');
});
