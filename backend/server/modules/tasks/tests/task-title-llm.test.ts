import assert from 'node:assert/strict';
import test from 'node:test';

import { TITLE_MODEL, TITLE_SYSTEM_PROMPT } from '@/modules/tasks/services/task-title.js';
import { requestTaskTitle } from '@/modules/tasks/services/task-title-llm.js';

type OneShotArgs = { prompt: string; systemPrompt: string; model?: string };

/** 记录调用参数的 runOneShot 替身；返回值由用例给。 */
function recordingRunner(result: string | null, calls: OneShotArgs[]) {
  return async (args: OneShotArgs) => {
    calls.push(args);
    return result;
  };
}

test('requestTaskTitle returns the sanitized model output', async () => {
  const calls: OneShotArgs[] = [];
  const title = await requestTaskTitle({
    description: '登录页老是超时，帮我看看',
    runOneShot: recordingRunner('```\n修复登录超时。\n```', calls),
  });
  assert.equal(title, '修复登录超时');
});

test('requestTaskTitle calls the one-shot path with the built prompt and DeepSeek Flash', async () => {
  const calls: OneShotArgs[] = [];
  await requestTaskTitle({
    description: '把任务面板的筛选做成表格视图',
    runOneShot: recordingRunner('任务面板表格视图', calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].systemPrompt, TITLE_SYSTEM_PROMPT);
  assert.equal(calls[0].model, TITLE_MODEL);
  assert.match(calls[0].prompt, /把任务面板的筛选做成表格视图/);
});

test('requestTaskTitle returns null when the one-shot path yields nothing', async () => {
  const calls: OneShotArgs[] = [];
  assert.equal(
    await requestTaskTitle({ description: '随便', runOneShot: recordingRunner(null, calls) }),
    null,
  );
});

test('requestTaskTitle returns null when the model answers something unusable', async () => {
  // 「模型答了但答的东西不能用」必须降级，而不是把 `""` 当成标题写进任务。
  assert.equal(
    await requestTaskTitle({ description: '随便', runOneShot: recordingRunner('「」', []) }),
    null,
  );
});

test('requestTaskTitle swallows a throwing one-shot path', async () => {
  const title = await requestTaskTitle({
    description: '随便',
    runOneShot: async () => {
      throw new Error('relay 401');
    },
  });
  assert.equal(title, null);
});

test('requestTaskTitle gives up on a hanging model instead of blocking forever', async () => {
  const title = await requestTaskTitle({
    description: '随便',
    runOneShot: () => new Promise<string | null>(() => {}),
    timeoutMs: 20,
  });
  assert.equal(title, null);
});

test('requestTaskTitle tolerates a missing description', async () => {
  const calls: OneShotArgs[] = [];
  const title = await requestTaskTitle({
    description: undefined as unknown as string,
    runOneShot: recordingRunner('未命名任务', calls),
  });
  assert.equal(title, '未命名任务');
  assert.equal(calls.length, 1);
});
