import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFile, MAX_PREVIEW_BYTES, MAX_PREVIEW_LINES } from './filePreviewTypes';

test('classifies markdown extensions', () => {
  assert.deepEqual(classifyFile('docs/foo.md'), { kind: 'markdown', language: 'markdown' });
  assert.deepEqual(classifyFile('README.markdown'), { kind: 'markdown', language: 'markdown' });
});

test('classifies code extensions with mapped Prism language', () => {
  assert.deepEqual(classifyFile('a.py'), { kind: 'code', language: 'python' });
  assert.deepEqual(classifyFile('b.ts'), { kind: 'code', language: 'typescript' });
  assert.deepEqual(classifyFile('c.json'), { kind: 'code', language: 'json' });
  assert.deepEqual(classifyFile('d.yml'), { kind: 'code', language: 'yaml' });
});

test('classifies plain-text extensions', () => {
  assert.deepEqual(classifyFile('notes.txt'), { kind: 'text', language: 'text' });
  assert.deepEqual(classifyFile('server.log'), { kind: 'text', language: 'text' });
  // dot-prefixed files
  assert.deepEqual(classifyFile('.env'), { kind: 'text', language: 'text' });
});

test('classifies image extensions', () => {
  assert.equal(classifyFile('pic.png').kind, 'image');
  assert.equal(classifyFile('icon.svg').kind, 'image');
});

test('classifies unknown / extensionless as unsupported', () => {
  assert.equal(classifyFile('data.bin').kind, 'unsupported');
  assert.equal(classifyFile('Makefile').kind, 'unsupported');
});

test('strips a trailing :line[:col] suffix before reading the extension', () => {
  assert.equal(classifyFile('src/foo.ts:130').kind, 'code');
  assert.equal(classifyFile('src/foo.ts:130:5').kind, 'code');
});

test('exposes large-file guard constants', () => {
  assert.ok(MAX_PREVIEW_BYTES > 0);
  assert.ok(MAX_PREVIEW_LINES > 0);
});
