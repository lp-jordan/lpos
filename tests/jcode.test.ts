import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJCode, hasJCode, normalizeJCode } from '../lib/passprep/jcode';

test('parseJCode: real letter-major export filenames (dominant convention)', () => {
  // Verified against Bryan Brown asset names + pass-map J-CODE column.
  assert.equal(parseJCode('A1.mp4'), 'A1');
  assert.equal(parseJCode('A2.mp4'), 'A2');
  assert.equal(parseJCode('B1.mp4'), 'B1');
  assert.equal(parseJCode('C1.mp4'), 'C1');
  assert.equal(parseJCode('M8.mp4'), 'M8');
  assert.equal(parseJCode('Z1.mp4'), 'Z1');
});

test('parseJCode: letter-major codes with editor/suffix tails', () => {
  assert.equal(parseJCode('A2_KH.mp4'), 'A2'); // _KH = editor initials
  assert.equal(parseJCode('B1_KH.mp4'), 'B1');
  assert.equal(parseJCode('M1_1.mp4'), 'M1');  // trailing _1 ignored (first token wins)
});

test('parseJCode: legacy digit-major filenames still parse', () => {
  assert.equal(parseJCode('1A.mp4'), '1A');
  assert.equal(parseJCode('12B.mov'), '12B');
});

test('parseJCode: case + whitespace normalization', () => {
  assert.equal(parseJCode('a1.mp4'), 'A1');
  assert.equal(parseJCode('  e1  '), 'E1');
  assert.equal(parseJCode('\th2\n'), 'H2');
});

test('parseJCode: code embedded in a longer name (first token wins)', () => {
  assert.equal(parseJCode('Pass 3 - H2 final.mov'), 'H2');
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

test('parseJCode: known limitation — version tails collide with V-codes', () => {
  // "v1" (version 1) is indistinguishable from the real code V1 (Pass 5 "Care"
  // uses V-codes). We accept this: parseJCode only runs on a tile's *linked*
  // asset, and the sheet is authoritative — a promo asset won't be linked to a
  // V1 lesson tile, so the collision doesn't cause a wrong match in practice.
  assert.equal(parseJCode('BooPromo_v1.mp4'), 'V1');
});

test('parseJCode: extension is stripped before matching (no ".mp4" -> "P4")', () => {
  assert.equal(parseJCode('render.mp4'), null);   // "p4" from the ext must not match
  assert.equal(parseJCode('keynote.mov'), null);
});

test('parseJCode: does not match codec/resolution tokens', () => {
  assert.equal(parseJCode('render_h264.mp4'), null);      // h264: >2 digits after letter
  assert.equal(parseJCode('1080p_master.mp4'), null);     // 1080p: >2 digits
  assert.equal(parseJCode('interview_720p.mov'), null);   // 720p: >2 digits
});

test('hasJCode mirrors parseJCode presence', () => {
  assert.equal(hasJCode('A1.mp4'), true);
  assert.equal(hasJCode('intro.mp4'), false);
});

test('normalizeJCode: only bare codes normalize, else null', () => {
  assert.equal(normalizeJCode('a1'), 'A1');
  assert.equal(normalizeJCode(' E1 '), 'E1');
  assert.equal(normalizeJCode('12b'), '12B');
  assert.equal(normalizeJCode('A1.mp4'), null); // not a bare code
  assert.equal(normalizeJCode('Pass 1'), null);
  assert.equal(normalizeJCode(''), null);
  assert.equal(normalizeJCode(null), null);
});
