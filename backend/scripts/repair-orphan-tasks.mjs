#!/usr/bin/env node
/**
 * 悬挂引用盘点与修复脚本（只读优先，写操作需显式 flag）。
 *
 * 背景：tasks.session_id 对 sessions.session_id 是「逻辑外键」，历史上没有 DB
 * 约束，多条删除路径（delete_session cascade、operator-cleanup、项目强制删除）
 * 会只删会话行、留下 task.session_id 悬空 → 任务行还在、跳转会话为空。
 *
 * 运行前建议先对 live DB 打快照（cp ~/.lovdex/data/new-auth.db /tmp/snapshot.db），
 * 然后对快照跑本脚本，避免与运行中的后端抢锁：
 *   node scripts/repair-orphan-tasks.mjs /tmp/snapshot.db
 *   node scripts/repair-orphan-tasks.mjs /tmp/snapshot.db --unlink   # 悬空引用置 NULL
 *   node scripts/repair-orphan-tasks.mjs /tmp/snapshot.db --purge    # 物理删除孤儿任务行
 *
 * 判定「悬空孤儿」：task.session_id 非空且 sessions 表里查不到该 session_id。
 * 两个修复动作互斥；都不给 = 只读盘点。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const [dbPath = process.env.LOVDEX_DB_PATH || path.join(os.homedir(), '.lovdex/data/new-auth.db'), ...flags] = process.argv.slice(2);

if (!fs.existsSync(dbPath)) {
  console.error(`DB 不存在: ${dbPath}`);
  process.exit(1);
}

const unlink = flags.includes('--unlink');
const purge = flags.includes('--purge');
if (unlink && purge) {
  console.error('--unlink 与 --purge 互斥，只能选一个');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: !unlink && !purge });

const orphans = db
  .prepare(
    `SELECT t.task_id, t.title, t.status, t.sub_status, t.session_id, t.source_schedule_id, t.project_path, t.created_at
     FROM tasks t
     WHERE t.session_id IS NOT NULL AND t.session_id <> ''
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = t.session_id)
     ORDER BY t.created_at ASC`,
  )
  .all();

console.log(`悬挂孤儿任务总数: ${orphans.length}`);
if (orphans.length === 0) {
  db.close();
  process.exit(0);
}

const byStatus = {};
const byProject = {};
for (const o of orphans) {
  byStatus[`${o.status}/${o.sub_status ?? '-'}`] = (byStatus[`${o.status}/${o.sub_status ?? '-'}`] ?? 0) + 1;
  byProject[o.project_path] = (byProject[o.project_path] ?? 0) + 1;
}
console.log('按 status/sub_status:', byStatus);
console.log('按 project_path:', byProject);

if (!unlink && !purge) {
  console.log('\n--- 明细（前 30 条）---');
  for (const o of orphans.slice(0, 30)) {
    console.log(`  ${o.task_id}  [${o.status}/${o.sub_status ?? '-'}]  ${o.title}  → ${o.session_id}  (${o.project_path})`);
  }
  console.log('\n只读盘点完成。要修复：--unlink（置 NULL）或 --purge（物理删除）。');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  for (const o of orphans) {
    if (unlink) {
      db.prepare('UPDATE tasks SET session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(o.task_id);
    } else if (purge) {
      db.prepare('DELETE FROM tasks WHERE task_id = ?').run(o.task_id);
    }
  }
});
tx();

const action = unlink ? '置 NULL（session_id）' : '物理删除';
console.log(`\n已对 ${orphans.length} 条孤儿任务执行: ${action}`);
db.close();
