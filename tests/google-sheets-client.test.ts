import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpreadsheetId } from '../lib/services/google-sheets-client';

test('extractSpreadsheetId: full edit URL with gid', () => {
  const r = extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1HbyHhJw9y-AiAZpPYanPy2F9FmGpsh__Op_CSq0Sfow/edit?gid=1599529532#gid=1599529532');
  assert.deepEqual(r, { spreadsheetId: '1HbyHhJw9y-AiAZpPYanPy2F9FmGpsh__Op_CSq0Sfow', gid: 1599529532 });
});

test('extractSpreadsheetId: URL without gid', () => {
  const r = extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1HbyHhJw9y-AiAZpPYanPy2F9FmGpsh__Op_CSq0Sfow/edit');
  assert.deepEqual(r, { spreadsheetId: '1HbyHhJw9y-AiAZpPYanPy2F9FmGpsh__Op_CSq0Sfow', gid: null });
});

test('extractSpreadsheetId: bare id', () => {
  const r = extractSpreadsheetId('1HbyHhJw9y-AiAZpPYanPy2F9FmGpsh__Op_CSq0Sfow');
  assert.deepEqual(r, { spreadsheetId: '1HbyHhJw9y-AiAZpPYanPy2F9FmGpsh__Op_CSq0Sfow', gid: null });
});

test('extractSpreadsheetId: whitespace + trailing junk tolerated', () => {
  const r = extractSpreadsheetId('  https://docs.google.com/spreadsheets/d/ABCdef123456789012345/edit#gid=0  ');
  assert.deepEqual(r, { spreadsheetId: 'ABCdef123456789012345', gid: 0 });
});

test('extractSpreadsheetId: non-sheet input returns null', () => {
  assert.equal(extractSpreadsheetId('https://example.com/not-a-sheet'), null);
  assert.equal(extractSpreadsheetId('hello world'), null);
  assert.equal(extractSpreadsheetId(''), null);
});
