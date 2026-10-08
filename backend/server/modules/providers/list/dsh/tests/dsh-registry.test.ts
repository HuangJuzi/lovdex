import assert from 'node:assert/strict';
import test from 'node:test';

import { appConfig } from '@/modules/config/config.js';
import type { LLMProvider } from '@/shared/types.js';

test("LLMProvider union accepts 'dsh'", () => {
  const provider: LLMProvider = 'dsh';
  assert.equal(provider, 'dsh');
});

test('providers.dsh config block exists with expected defaults', () => {
  const cfg = appConfig().get();
  const dsh = (cfg.providers as Record<string, unknown>).dsh as Record<string, unknown>;
  assert.ok(dsh, 'providers.dsh must exist');
  assert.equal(dsh.binPath, 'dsh');
  assert.equal(dsh.toolApprovalTimeoutMs, 60000);
});
