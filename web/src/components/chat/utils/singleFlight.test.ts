import test from 'node:test';
import assert from 'node:assert/strict';

import { createSingleFlight } from './singleFlight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// 新会话首条消息要在建 session 的异步窗口内防止第二次提交：并发的第二次
// 调用必须直接落空（而不是排队，否则同一个内容会发两遍）。
test('a concurrent second call is ignored, not queued', async () => {
  const gate = createSingleFlight();
  const first = deferred<string>();
  let calls = 0;

  const a = gate(async () => {
    calls++;
    return first.promise;
  });
  const b = await gate(async () => {
    calls++;
    return 'second';
  });

  assert.equal(b, null, 'duplicate call resolves to null immediately');
  assert.equal(calls, 1, 'task body runs once');

  first.resolve('first');
  assert.equal(await a, 'first');
});

test('the gate re-opens after a successful run', async () => {
  const gate = createSingleFlight();
  let calls = 0;

  const run = () => gate(async () => {
    calls++;
    return calls;
  });

  assert.equal(await run(), 1);
  assert.equal(await run(), 2);
});

test('a rejected run releases the gate so retry works', async () => {
  const gate = createSingleFlight();
  let calls = 0;

  await assert.rejects(
    gate(async () => {
      calls++;
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(await gate(async () => {
    calls++;
    return 'ok';
  }), 'ok');
  assert.equal(calls, 2);
});
