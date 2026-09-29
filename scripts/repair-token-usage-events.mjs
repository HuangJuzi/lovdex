#!/usr/bin/env node
/**
 * 修复 token_usage_events 里被「占位行先到先得」污染的存量行。
 *
 * 背景：Claude Code 在请求在途时会先写出一条全零 usage 快照（同 message.id），
 * 网关真实用量几秒后才到。旧行为 INSERT OR IGNORE 先到先得，占位行永久胜出。
 * 本脚本扫 ~/.claude/projects 下所有 .jsonl（递归），按 message.id 找出库里四列可补齐的行，
 * 用与 insertEvents 相同的「更完整才覆盖」规则 UPDATE（只修存量，不新增行）。
 *
 * 用法：
 *   node scripts/repair-token-usage-events.mjs --dry-run   # 只打印将要改的行数
 *   node scripts/repair-token-usage-events.mjs --apply      # 实际写库
 *
 * 默认目标库读 app.config.json 的 database.path（与后端同源），可用
 * DATABASE_PATH 覆盖。修完重启后端，统计页即反映新口径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// better-sqlite3 装在 backend/node_modules，从仓库相对路径 resolve
const Database = require('../backend/node_modules/better-sqlite3');

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

function resolveDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const cfgPath = path.join(os.homedir(), '.lovdex', 'data', 'app.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return cfg.database.path;
}

// 「更完整」判定与 token-usage.db.ts 的 upsert WHERE 完全一致：
// 仅当 output / cache_read / cache_creation 任一严格大于时才覆盖。
// input 不参与判定——09-24 口径翻转期 inclusive 行的 input 天然偏大，
// 拿它当完整性会把 exclusive 的真实行顶掉。
// 注意两侧字段名不同：transcript 快照是 camelCase，库行是 snake_case，
// 比较前先归一（这里统一用 camelCase 传参，库行读出后映射一次）。
const isMoreComplete = (cur, next) =>
  next.output > cur.output || next.cacheRead > cur.cacheRead || next.cacheCreation > cur.cacheCreation;

const rowToSnapshot = (row) => ({
  input: row.input_tokens,
  output: row.output_tokens,
  cacheRead: row.cache_read_tokens,
  cacheCreation: row.cache_creation_tokens,
});

const dbPath = resolveDbPath();
console.log(`[repair-token-usage] mode=${mode} db=${dbPath}`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 收集 transcript 文件
const root = path.join(os.homedir(), '.claude', 'projects');
const files = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(p);
  }
})(root);
console.log(`[repair-token-usage] scanning ${files.length} transcript files`);

const dbKeys = new Set(
  db.prepare('SELECT dedupe_key FROM token_usage_events WHERE source = ?').all('claude').map((r) => r.dedupe_key),
);
console.log(`[repair-token-usage] ${dbKeys.size} claude rows in db`);

// transcript 同一 message.id 的多行快照里挑「最完整」的那条
const best = new Map(); // dedupe_key -> {input, output, cacheRead, cacheCreation}
const scanStart = Date.now();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const message = entry.message;
    if (!message?.usage || !message?.id) continue;
    const key = `claude:${message.id}`;
    if (!dbKeys.has(key)) continue; // 只修存量
    const usage = message.usage;
    const snapshot = {
      input: num(usage.input_tokens ?? usage.inputTokens),
      output: num(usage.output_tokens ?? usage.outputTokens),
      cacheRead: num(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
      cacheCreation: num(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    };
    const prev = best.get(key);
    if (!prev || isMoreComplete(prev, snapshot)) {
      best.set(key, snapshot);
    }
  }
}
console.log(`[repair-token-usage] matched ${best.size} in-db keys from transcripts (${Math.round((Date.now() - scanStart) / 1000)}s)`);

const getRow = db.prepare(
  'SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM token_usage_events WHERE dedupe_key = ?',
);
const updateStmt = db.prepare(
  'UPDATE token_usage_events SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ? WHERE dedupe_key = ?',
);

let fixCount = 0;
let sumInputDelta = 0;
let sumCacheReadDelta = 0;
const samples = [];

if (mode === 'apply') db.prepare('BEGIN').run();
for (const [key, snap] of best) {
  const row = getRow.get(key);
  if (!row) continue;
  const cur = rowToSnapshot(row);
  if (!isMoreComplete(cur, snap)) continue;
  fixCount += 1;
  sumInputDelta += snap.input - cur.input;
  sumCacheReadDelta += snap.cacheRead - cur.cacheRead;
  if (samples.length < 5) {
    samples.push(`  ${key} input ${cur.input}->${snap.input} out ${cur.output}->${snap.output} cr ${cur.cacheRead}->${snap.cacheRead}`);
  }
  if (mode === 'apply') updateStmt.run(snap.input, snap.output, snap.cacheRead, snap.cacheCreation, key);
}
if (mode === 'apply') db.prepare('COMMIT').run();

console.log(`[repair-token-usage] ${mode === 'apply' ? 'UPDATED' : 'would update'} ${fixCount} rows`);
console.log(`[repair-token-usage] ΣΔinput=${sumInputDelta} ΣΔcacheRead=${sumCacheReadDelta}`);
for (const s of samples) console.log(s);
db.close();
