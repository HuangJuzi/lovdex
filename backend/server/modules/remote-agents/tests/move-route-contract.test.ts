import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// index.js boots a server at module load, so the route cannot be imported and
// called. These assertions pin the wiring the route depends on staying put —
// mirrors the approach in modules/uploads/tests/upload-route-wiring.test.ts.
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const indexJsPath = path.resolve(serverDir, '../../../index.js');

test('files/move route is wired with a pre-flight conflict check and remote fallback', async () => {
  const src = await readFile(indexJsPath, 'utf8');

  assert.match(src, /app\.post\('\/api\/projects\/:projectId\/files\/move', authenticateToken/);
  // Planner is shared with the lite, not reimplemented here.
  assert.match(src, /import \{ planMoves \} from '\.\/shared\/file-move-planner\.js'/);
  // Batch pre-flight: conflicts abort with 409 and the names are returned.
  assert.match(src, /Target already contains:/);
  assert.match(src, /conflicts,/);
  // Remote hosts must be capability-gated so an old lite cannot half-move.
  assert.match(src, /capabilities\.includes\('fs\/move'\)/);
  assert.match(src, /status\(501\)/);
  // 100-item bound.
  assert.match(src, /Maximum is 100\./);
});
