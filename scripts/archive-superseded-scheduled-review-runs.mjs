#!/usr/bin/env node
/**
 * 归档「已被同一模板更新一轮取代」的定时任务 needs_review 存量。
 *
 * 背景：定时任务每半小时一轮，旧一轮的自动判定写出 needs_review（待你决策）后，
 * 任务被压回 in_progress。删除守卫（in_progress + 非 failed）和 24h 清理任务
 * （跳过 in_progress）都不会碰它，于是同一诉求的 10 条提醒永久挂在收件箱。
 * 运行时的新一轮判定已会在 writeSummary 里自动归档旧 run（services/tasks.service.ts
 * 的 archiveSupersededScheduledRuns），本脚本只处理存量。
 *
 * 判定：source_schedule_id 非空 + status=in_progress + sub_status=needs_review，
 * 且同一模板存在 created_at 更晚、verdict_at 非空的运行 —— 说明这轮结果已被更新
 * 一轮取代。归档时清 sub_status 并隐藏关联会话，与用户点「忽略」的归档语义一致。
 *
 * 用法：
 *   node scripts/archive-superseded-scheduled-review-runs.mjs --dry-run
 *   node scripts/archive-superseded-scheduled-review-runs.mjs --apply
 *
 * 默认目标库读 app.config.json 的 database.path（与后端同源），可用
 * DATABASE_PATH 覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../backend/node_modules/better-sqlite3');

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

function resolveDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const cfgPath = path.join(os.homedir(), '.lovdex', 'data', 'app.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return cfg.database.path;
}

const dbPath = resolveDbPath();
console.log(`[archive-superseded-scheduled-runs] mode=${mode} db=${dbPath}`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const rows = db
  .prepare(
    `SELECT t.task_id, t.title, t.session_id, t.source_schedule_id, t.created_at
       FROM tasks t
      WHERE t.source_schedule_id IS NOT NULL
        AND t.status = 'in_progress'
        AND t.sub_status = 'needs_review'
      ORDER BY t.source_schedule_id, t.created_at`,
  )
  .all();

const hasNewerSettledRun = db.prepare(
  `SELECT 1 FROM tasks
    WHERE source_schedule_id = ?
      AND task_id != ?
      AND created_at > ?
      AND verdict_at IS NOT NULL
    LIMIT 1`,
);

const stale = rows.filter((row) => Boolean(hasNewerSettledRun.get(row.source_schedule_id, row.task_id, row.created_at)));

console.log(`[archive-superseded-scheduled-runs] candidates=${rows.length} superseded=${stale.length}`);
for (const row of stale) {
  console.log(`  - ${row.task_id}  ${row.created_at}  ${row.title}`);
}

if (mode !== 'apply') {
  console.log('[archive-superseded-scheduled-runs] dry-run — pass --apply to write');
  process.exit(0);
}

const archiveTask = db.prepare(
  `UPDATE tasks
      SET status = 'archived', sub_status = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ?`,
);
const archiveSession = db.prepare('UPDATE sessions SET isArchived = 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?');

const run = db.transaction((items) => {
  for (const row of items) {
    archiveTask.run(row.task_id);
    if (row.session_id) archiveSession.run(row.session_id);
  }
});
run(stale);

console.log(`[archive-superseded-scheduled-runs] archived ${stale.length} task(s)`);
