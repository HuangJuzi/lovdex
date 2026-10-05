#!/usr/bin/env node
/**
 * 失控会话僵尸任务清点与收尾脚本（只读优先，写操作需显式 flag）。
 *
 * 背景（2026-09-30 事故）：两个无人值守只读任务各跑了 ~2500 条消息、~4MB
 * transcript，最终 402 余额不足。它们的任务行停在 `status=in_progress` +
 * `sub_status=failed`，且此前 SDK 的 result.is_error 未被当作致命错误，跑挂
 * 后仍按 exitCode 0 结算 → 触发完成度判定 → 判定会话又整段读入超长 transcript，
 * 二次放大。
 *
 * 代码侧修复（见 run-guard / claude-sdk 的会话熔断与致命错误立即终止）已让
 * 新跑失败不再被判「完成」、也不再整段重读 transcript。本脚本只处理**存量**：
 * 把 `in_progress + failed` 且会话已不在跑、transcript 超阈值的僵尸任务找出来，
 * 并（加 --settle 时）把它们归档收尾，避免看板一直显示「进行中」。
 *
 * 为什么用「归档」而不是别的终态：engine 永不写 archived（纯用户动作），但这里
 * 是人工一次性数据修复，绕过服务层守卫直接落库，与 repair-orphan-tasks.mjs 的
 * --purge 同类。归档会同时隐藏其关联会话，符合「清理」语义。
 *
 * 运行前先对 live DB 打快照，再对快照跑本脚本（避免与运行中的后端抢锁）：
 *   cp ~/.lovdex/data/new-auth.db /tmp/snapshot.db
 *   node scripts/settle-zombie-tasks.mjs /tmp/snapshot.db              # 只读盘点
 *   node scripts/settle-zombie-tasks.mjs /tmp/snapshot.db --settle      # 归档收尾
 *   node scripts/settle-zombie-tasks.mjs /tmp/snapshot.db --task 7ba0771c --settle
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

const settle = flags.includes('--settle');
const taskFlag = flags.indexOf('--task');
const onlyTaskIds = taskFlag !== -1
  ? flags.slice(taskFlag + 1).filter((f) => !f.startsWith('--'))
  : [];
// transcript 阈值：超过此字节数才视为「失控」候选，避免误伤正常短会话。
const TRANSCRIPT_BYTES_THRESHOLD = 1 * 1024 * 1024;

const db = new Database(dbPath, { readonly: !settle });

const rows = db
  .prepare(
    `SELECT t.task_id, t.title, t.status, t.sub_status, t.session_id, t.source_schedule_id,
            t.project_path, t.created_at, t.updated_at,
            s.jsonl_path, s.provider_session_id, s.is_operator, s.is_verdict
     FROM tasks t
     LEFT JOIN sessions s ON s.session_id = t.session_id
     WHERE t.status = 'in_progress' AND t.sub_status = 'failed'
     ORDER BY t.updated_at ASC`,
  )
  .all();

const zombies = [];
for (const r of rows) {
  if (onlyTaskIds.length > 0 && !onlyTaskIds.some((id) => r.task_id.startsWith(id))) continue;
  const bytes = r.jsonl_path && fs.existsSync(r.jsonl_path) ? fs.statSync(r.jsonl_path).size : 0;
  if (bytes < TRANSCRIPT_BYTES_THRESHOLD) continue;
  zombies.push({ ...r, transcriptBytes: bytes });
}

console.log(`in_progress+failed 且 transcript 超 ${(TRANSCRIPT_BYTES_THRESHOLD / 1024 / 1024).toFixed(0)}MB 的僵尸任务: ${zombies.length}`);
if (zombies.length === 0) {
  db.close();
  process.exit(0);
}

for (const z of zombies) {
  console.log(`- ${z.task_id}  「${z.title}」  session=${z.session_id ?? '-'}  transcript=${(z.transcriptBytes / 1024 / 1024).toFixed(1)}MB  updated=${z.updated_at}`);
}

if (!settle) {
  console.log('\n只读盘点。加 --settle 归档收尾（把 status 置 archived + 隐藏关联会话）。');
  db.close();
  process.exit(0);
}

const settleTask = db.transaction((taskId, sessionId) => {
  db.prepare(`UPDATE tasks SET status = 'archived', sub_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`).run(taskId);
  if (sessionId) {
    db.prepare(`UPDATE sessions SET isArchived = 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?`).run(sessionId);
  }
});

for (const z of zombies) {
  settleTask(z.task_id, z.session_id);
  console.log(`已归档 ${z.task_id}（会话 ${z.session_id ?? '-'} 一并隐藏）`);
}

db.close();
console.log('完成。');
