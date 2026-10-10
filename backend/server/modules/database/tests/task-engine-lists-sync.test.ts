import assert from 'node:assert/strict';
import test from 'node:test';

import { EXECUTOR_PROVIDERS } from '@/modules/database/schema.js';
import { TASK_ENGINES } from '@/modules/database/repositories/tasks.db.js';
import type { TaskEngine } from '@/shared/types.js';

/**
 * The task executor engine id is declared in three places that must agree:
 *
 *   - `TaskEngine`        (shared/types.ts)          — the compile-time union
 *   - `TASK_ENGINES`      (repositories/tasks.db.ts) — the runtime allow-list the
 *                                                      service validates against
 *   - `EXECUTOR_PROVIDERS`(database/schema.ts)       — the tasks table's CHECK
 *
 * Nothing else links them. TypeScript catches an INVALID entry in TASK_ENGINES
 * (it is typed `readonly TaskEngine[]`) but silently tolerates a MISSING one,
 * and EXECUTOR_PROVIDERS is a plain `as const` string array with no type link at
 * all. Dropping an engine from either list would either silently reject a valid
 * provider at runtime or make the CHECK refuse the INSERT — exactly the class of
 * bug this file exists to catch. Mirrors the double-sided set assertion the
 * operator-prompt tool roster uses.
 */

// A total Record forces the union and this literal to be edited together: a new
// TaskEngine member makes this fail to compile until it is listed here.
const ALL_TASK_ENGINES: Record<TaskEngine, true> = {
  claude: true,
  codex: true,
  opencode: true,
  qoder: true,
  dsh: true,
};

test('every TaskEngine member is present in both runtime engine lists', () => {
  const unionMembers = Object.keys(ALL_TASK_ENGINES) as TaskEngine[];
  assert.deepEqual(
    [...TASK_ENGINES].sort(),
    [...unionMembers].sort(),
    'TASK_ENGINES (service validation) must list exactly the TaskEngine union members',
  );
  assert.deepEqual(
    [...EXECUTOR_PROVIDERS].sort(),
    [...unionMembers].sort(),
    'EXECUTOR_PROVIDERS (the tasks executor CHECK) must list exactly the TaskEngine union members',
  );
});

test('the executor CHECK in the schema SQL is built from EXECUTOR_PROVIDERS', async () => {
  const { TASKS_TABLE_SCHEMA_SQL } = await import('@/modules/database/schema.js');
  for (const engine of EXECUTOR_PROVIDERS) {
    assert.ok(
      TASKS_TABLE_SCHEMA_SQL.includes(`'${engine}'`),
      `the tasks schema SQL must accept the "${engine}" executor`,
    );
  }
});
