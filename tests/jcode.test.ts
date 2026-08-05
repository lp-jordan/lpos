import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJCode, hasJCode, normalizeJCode } from '../lib/passprep/jcode';

test('parseJCode: real export filenames', () => {
  assert.equal(parseJCode('1A.mp4'), '1A');   // verified prod shape
  assert.equal(parseJCode('2A.mp4'), '2A');
  assert.equal(parseJCode('12B.mov'), '12B');
  assert.equal(parseJCode('3C.mxf'), '3C');
});

test('parseJCode: case + whitespace normalization', () => {
  assert.equal(parseJCode('1a.mp4'), '1A');
  assert.equal(parseJCode('  2a  '), '2A');
  assert.equal(parseJCode('\t4b\n'), '4B');
});

test('parseJCode: code embedded in a longer name (first token wins)', () => {
  assert.equal(parseJCode('Day 1 - 3B final.mov'), '3B');
  assert.equal(parseJCode('Session_5D_master.mp4'), '5D');
  assert.equal(parseJCode('shoot 7a raw.mp4'), '7A');
});

test('parseJCode: names with no J-Code return null', () => {
  assert.equal(parseJCode('intro.mp4'), null);
  assert.equal(parseJCode('keynote-final.mov'), null);
  assert.equal(parseJCode(''), null);
  assert.equal(parseJCode(null), null);
  assert.equal(parseJCode(undefined), null);
});

test('parseJCode: does not match codec/resolution tokens', () => {
  // "h264" has no 1-2 digit run immediately followed by a single letter token.
  assert.equal(parseJCode('render_h264.mp4'), null);
  // "1080p"/"720p" are rejected by the 1-2 digit bound (would otherwise be a code).
  assert.equal(parseJCode('1080p_master.mp4'), null);
  assert.equal(parseJCode('interview_720p.mov'), null);
});

test('hasJCode mirrors parseJCode presence', () => {
  assert.equal(hasJCode('1A.mp4'), true);
  assert.equal(hasJCode('intro.mp4'), false);
});

test('normalizeJCode: only bare codes normalize, else null', () => {
  assert.equal(normalizeJCode('1a'), '1A');
  assert.equal(normalizeJCode(' 12B '), '12B');
  assert.equal(normalizeJCode('1A.mp4'), null); // not a bare code
  assert.equal(normalizeJCode('Day 1'), null);
  assert.equal(normalizeJCode(''), null);
  assert.equal(normalizeJCode(null), null);
});
