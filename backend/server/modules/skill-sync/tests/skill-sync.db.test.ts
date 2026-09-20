import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSkillSyncAuditDb, type SkillSyncAuditRepository } from '../skill-sync.db.js';

let db: Database.Database;
let repo: SkillSyncAuditRepository;

beforeEach(() => {
  db = new Database(':memory:');
  repo = createSkillSyncAuditDb(db);
});

function row(overrides: Partial<Parameters<SkillSyncAuditRepository['record']>[0]> = {}) {
  return {
    actor: 'user' as const,
    from_node: 'local',
    to_node: 'remote:h1',
    scope: 'user' as const,
    skill_name: 'demo',
    action: 'create',
    status: 'ok' as const,
    ...overrides,
  };
}

test('createSkillSyncAuditDb is idempotent (safe to run on every boot)', () => {
  assert.doesNotThrow(() => createSkillSyncAuditDb(db));
});

test('record + list round-trips a successful sync', () => {
  repo.record(row({ content_hash: 'a'.repeat(64), backup_path: '/srv/.claude/skills/.skill-sync-backup/demo.x' }));

  const rows = repo.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'user');
  assert.equal(rows[0].from_node, 'local');
  assert.equal(rows[0].to_node, 'remote:h1');
  assert.equal(rows[0].skill_name, 'demo');
  assert.equal(rows[0].action, 'create');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].content_hash, 'a'.repeat(64));
  assert.ok(rows[0].created_at);
});

test('record keeps the failure reason', () => {
  repo.record(row({ status: 'failed', error: 'target changed: demo on this host no longer matches the previewed hash' }));
  assert.match(repo.list()[0].error ?? '', /target changed/);
});

test('record rejects an unknown actor or status', () => {
  assert.throws(() => repo.record(row({ actor: 'robot' as never })));
  assert.throws(() => repo.record(row({ status: 'maybe' as never })));
});

test('list returns newest first and honours the limit', () => {
  repo.record(row({ skill_name: 'first', created_at: '2026-01-01T00:00:00.000Z' }));
  repo.record(row({ skill_name: 'second', created_at: '2026-02-01T00:00:00.000Z' }));
  repo.record(row({ skill_name: 'third', created_at: '2026-03-01T00:00:00.000Z' }));

  assert.deepEqual(repo.list().map((r) => r.skill_name), ['third', 'second', 'first']);
  assert.deepEqual(repo.list(2).map((r) => r.skill_name), ['third', 'second']);
});
