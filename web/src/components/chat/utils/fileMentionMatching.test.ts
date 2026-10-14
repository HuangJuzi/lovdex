import test from 'node:test';
import assert from 'node:assert/strict';

import { matchFiles, FILE_MENTION_LIMIT } from './fileMentionMatching';

const files = [
  { name: 'index.ts', path: 'src/index.ts' },
  { name: 'useChat.ts', path: 'src/hooks/useChat.ts' },
  { name: 'chatFormatting.ts', path: 'src/utils/chatFormatting.ts' },
  { name: 'README.md', path: 'docs/README.md' },
  { name: 'chat.ts', path: 'docs/chat.ts' },
];

test('name 前缀匹配排在 name 包含和 path 包含之前', () => {
  const result = matchFiles(files, 'chat');
  // tier0（name 前缀）：chatFormatting.ts、chat.ts；tier1（name 包含）：useChat.ts。
  // useChat.ts 虽然 path 也包含，但按最高档 name 前缀/包含计，必须排在两个前缀匹配之后。
  assert.deepEqual(
    result.map((file) => file.path),
    ['src/utils/chatFormatting.ts', 'docs/chat.ts', 'src/hooks/useChat.ts'],
  );
});

test('同档位内保持原有树序，不重排', () => {
  const result = matchFiles(
    [
      { name: 'b.ts', path: 'b.ts' },
      { name: 'a.ts', path: 'a.ts' },
    ],
    '.ts',
  );
  assert.deepEqual(result.map((file) => file.name), ['b.ts', 'a.ts']);
});

test('匹配大小写不敏感', () => {
  const result = matchFiles(files, 'CHAT');
  // index.ts 和 README.md 的 name/path 都不含 chat
  assert.equal(result.length, 3);
});

test('空查询匹配全部文件（@ 刚敲下时）', () => {
  const result = matchFiles(files, '');
  assert.equal(result.length, files.length);
});

test('超过上限时截断到 FILE_MENTION_LIMIT', () => {
  const many = Array.from({ length: FILE_MENTION_LIMIT + 30 }, (_, i) => ({
    name: `file${i}.ts`,
    path: `src/file${i}.ts`,
  }));
  const result = matchFiles(many, 'file');
  assert.equal(result.length, FILE_MENTION_LIMIT);
});

test('上限不再是旧的 10 条', () => {
  assert.ok(FILE_MENTION_LIMIT > 10, '截断上限必须大于旧的 10，否则修复无意义');
});
