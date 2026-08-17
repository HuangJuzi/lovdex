import assert from 'node:assert/strict';
import test from 'node:test';

import { builtInCommands, executeModelsCommand } from '../commands.js';
import { providerModelsService } from '../../modules/providers/services/provider-models.service.js';

test('models command resolves opencode as its own provider with an OpenCode label', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [{ value: 'opencode/deepseek-v4-flash-free', label: 'opencode/deepseek-v4-flash-free' }],
      DEFAULT: 'opencode/deepseek-v4-flash-free',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => ({ model: 'opencode/deepseek-v4-flash-free' });

  try {
    const result = await executeModelsCommand([], {
      provider: 'opencode',
      model: 'opencode/deepseek-v4-flash-free',
    });

    assert.equal(result.data.current.provider, 'opencode');
    assert.equal(result.data.current.providerLabel, 'OpenCode');
    assert.deepEqual(Object.keys(result.data.available), ['opencode']);
    assert.ok(result.data.availableModels.includes('opencode/deepseek-v4-flash-free'));
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});

test('models command returns available models only for the active provider', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;
  let getCurrentActiveModelCalls = 0;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [{ value: 'gpt-5.4', label: 'gpt-5.4' }],
      DEFAULT: 'gpt-5.4',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => {
    getCurrentActiveModelCalls += 1;
    return {
      model: 'gpt-5.3-codex',
    };
  };

  try {
    const result = await executeModelsCommand([], {
      provider: 'codex',
      model: 'gpt-5.4',
    });

    assert.equal(result.type, 'builtin');
    assert.equal(result.action, 'models');
    assert.equal(result.data.current.provider, 'codex');
    assert.equal(result.data.current.model, 'gpt-5.4');
    assert.deepEqual(Object.keys(result.data.available), ['codex']);
    assert.deepEqual(result.data.available.codex, result.data.availableModels);
    assert.ok(result.data.availableModels.includes('gpt-5.4'));
    assert.equal(result.data.available.claude, undefined);
    assert.equal(result.data.available.cursor, undefined);
    assert.equal(getCurrentActiveModelCalls, 0);
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});

test('models command falls back to claude for unsupported providers', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [{ value: 'default', label: 'Default (recommended)' }],
      DEFAULT: 'default',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => ({
    model: 'default',
  });

  try {
    const result = await executeModelsCommand([], {
      provider: 'unknown-provider',
    });

    assert.equal(result.data.current.provider, 'claude');
    assert.deepEqual(Object.keys(result.data.available), ['claude']);
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});

test('models command shows the requested model when no session is active', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;
  let getCurrentActiveModelCalls = 0;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [
        { value: 'default', label: 'Default (recommended)' },
        { value: 'sonnet', label: 'Sonnet' },
      ],
      DEFAULT: 'default',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => {
    getCurrentActiveModelCalls += 1;
    return { model: 'default' };
  };

  try {
    const result = await executeModelsCommand([], {
      provider: 'claude',
      model: 'sonnet',
      // no sessionId — simulates a brand-new chat before the first response
    });

    assert.equal(
      result.data.current.model,
      'sonnet',
      'no-session /model should reflect the frontend-selected model, not the hardcoded default',
    );
    assert.equal(getCurrentActiveModelCalls, 0);
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});

test('models command prefers a pending session model change over the transcript', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;
  const originalGetChangedActiveModel = providerModelsService.getChangedActiveModel;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [
        { value: 'default', label: 'Default (recommended)' },
        { value: 'opus', label: 'GLM-5.2' },
      ],
      DEFAULT: 'default',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  // Transcript still shows the model that last ran; the pending change is what
  // the next response will use, and the modal should reflect that immediately.
  providerModelsService.getCurrentActiveModel = async () => ({ model: 'default' });
  providerModelsService.getChangedActiveModel = async () => ({
    provider: 'claude',
    sessionId: 'sess-1',
    supported: true,
    changed: true,
    model: 'opus',
  });

  try {
    const result = await executeModelsCommand([], {
      provider: 'claude',
      model: 'default',
      sessionId: 'sess-1',
    });

    assert.equal(
      result.data.current.model,
      'opus',
      'a pending model change should win over the transcript model for display',
    );
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
    providerModelsService.getChangedActiveModel = originalGetChangedActiveModel;
  }
});

test('built-in commands include /resume as a ui-overlay command', () => {
  const resume = builtInCommands.find((cmd) => cmd.name === '/resume');
  assert.ok(resume, '/resume should be a built-in command');
  assert.equal(resume.namespace, 'builtin');
  assert.equal(resume.metadata?.type, 'builtin');
  assert.equal(resume.metadata?.handler, 'ui-overlay');
  assert.equal(resume.metadata?.overlay, 'resume');
  assert.equal(resume.metadata?.forwardToProvider, undefined);
});

test('branch/fork/rewind are registered as ui-overlay commands', () => {
  for (const name of ['/branch', '/fork', '/rewind']) {
    const cmd = builtInCommands.find((c) => c.name === name);
    assert.ok(cmd, `${name} not registered`);
    assert.equal(cmd.metadata.handler, 'ui-overlay');
    assert.ok(cmd.metadata.overlay, `${name} missing overlay`);
  }
});
