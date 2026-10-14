import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// index.js boots a server at module load, so the route cannot be imported and
// exercised here. These assertions pin only the STRUCTURE the route depends on
// (that it is registered, and that it shares the planner with the lite rather
// than reimplementing move semantics). Behaviour — pre-flight, conflicts,
// dedup, no-ops — is covered by the planner and lite fs.move unit tests.
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const indexJsPath = path.resolve(serverDir, '../../../index.js');

test('files/move route is registered and reuses the shared planner', async () => {
  const src = await readFile(indexJsPath, 'utf8');

  assert.match(src, /app\.post\(\s*'\/api\/projects\/:projectId\/files\/move',\s*authenticateToken/);
  // The planner is shared with the remote lite — not reimplemented per side.
  assert.match(src, /import \{[^}]*\bplanMoves\b[^}]*\} from '\.\/shared\/file-move-planner\.js'/);
  // Remote hosts are capability-gated so an old lite cannot half-move a batch.
  assert.match(src, /includes\('fs\/move'\)/);
});
