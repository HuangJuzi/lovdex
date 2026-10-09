import assert from 'node:assert/strict';
import test from 'node:test';

import { appConfig } from '@/modules/config/config.js';
import { DshProvider } from '@/modules/providers/list/dsh/dsh.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
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

test('registry resolves the dsh provider with all six facets', () => {
  const provider = providerRegistry.resolveProvider('dsh');
  assert.ok(provider instanceof DshProvider);
  assert.ok(provider.models);
  assert.ok(provider.mcp);
  assert.ok(provider.auth);
  assert.ok(provider.skills);
  assert.ok(provider.sessions);
  assert.ok(provider.sessionSynchronizer);
});
