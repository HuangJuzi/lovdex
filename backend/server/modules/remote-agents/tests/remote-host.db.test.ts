import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createRemoteHostsDb, type RemoteHostsRepository } from '../remote-host.db.js';

// Minimal projects table so findHostForProjectPath's join works in-memory.
const PROJECTS_DDL =
  'CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY NOT NULL, project_path TEXT NOT NULL UNIQUE, remote_host_id INTEGER)';

let db: Database.Database;
let repo: RemoteHostsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(PROJECTS_DDL);
  repo = createRemoteHostsDb(db);
});

test('insert + get by id round-trips status offline → online', () => {
  const id = repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
  assert.equal(id, 'h1');
  const row = repo.getById('h1');
  assert.equal(row?.status, 'offline');
  repo.updateStatus('h1', 'online');
  assert.equal(repo.getById('h1')?.status, 'online');
});

test('findHostForProjectPath returns null when no remote project matches', () => {
  db.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('local-1', '/srv/local');
  const row = repo.findHostForProjectPath('/srv/local');
  assert.equal(row, null);

  repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
  db.prepare('INSERT INTO projects (project_id, project_path, remote_host_id) VALUES (?, ?, ?)').run(
    'p2',
    '/srv/app',
    'h1',
  );
  const row2 = repo.findHostForProjectPath('/srv/app');
  assert.equal(row2?.host_id, 'h1');
});

test('list returns hosts, updateStatus stores last_error, token hash round-trips, remove deletes', () => {
  repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
  repo.create({ host_id: 'h2', name: 'dev2', host: '10.0.0.6', ssh_user: 'root', port: 2222 });

  assert.equal(repo.list().length, 2);
  assert.equal(repo.getById('h2')?.port, 2222);

  repo.updateStatus('h1', 'error', 'ssh timeout');
  const errored = repo.getById('h1');
  assert.equal(errored?.status, 'error');
  assert.equal(errored?.last_error, 'ssh timeout');

  repo.setTokenHash('h1', 'hash-abc');
  assert.equal(repo.getByTokenHash('hash-abc')?.host_id, 'h1');
  assert.equal(repo.getByTokenHash('nope'), null);

  repo.touchSeen('h1');
  assert.notEqual(repo.getById('h1')?.last_seen_at, null);

  repo.remove('h1');
  assert.equal(repo.getById('h1'), null);
});
