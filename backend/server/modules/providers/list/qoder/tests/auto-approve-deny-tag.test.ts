import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { UNATTENDED_INTERACTION_DENY_REASON } from '@/modules/permissions/auto-approve-policy.js';
import { refreshRemoteProjectsIndex } from '@/modules/remote-agents/remote-projects.index.js';
import { QoderSessionsProvider } from '@/modules/providers/list/qoder/qoder-sessions.provider.js';

const provider = new QoderSessionsProvider();
const SID = 'sess-auto-approve';

/** 造一条 transcript 里的 user 行，里面挂一个 tool_result。 */
function transcriptRow(toolUseId: string, content: unknown, isError: boolean) {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    sessionId: SID,
    timestamp: '2026-09-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
  };
}

test('an unattended interaction denial is tagged as interaction', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T1', UNATTENDED_INTERACTION_DENY_REASON, true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.ok(result, 'expected a normalized tool_result');
  assert.equal(result.isError, true);
  assert.equal(result.autoApproveDeny, 'interaction');
});

test('a blocked dangerous command is tagged as blocked', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T2', '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）', true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'blocked');
});

test('a genuine tool error is left untagged', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T3', 'boom: command failed', true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.isError, true);
  assert.equal(result?.autoApproveDeny, undefined);
});

test('a successful result is left untagged', () => {
  const out = provider.normalizeMessage(transcriptRow('T4', 'file contents', false), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, undefined);
});

// 真实形状：qoder CLI 会把 `control_response.message` 包进 `Error: ` 再落盘。
// 本机 33 条真实 error tool_result 里 32 条带该前缀（宿主发裸串
// `Permission request timed out`，transcript 里是 `Error: Permission request
// timed out`）。不剥前缀的话分类在真实数据上 100% 落空 —— 合成裸串行会恰好
// 绕开这个形状，所以下面两条必须钉住带前缀的形态。
test('a denial wrapped in the CLI Error: prefix is still tagged as interaction', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T6', `Error: ${UNATTENDED_INTERACTION_DENY_REASON}`, true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'interaction');
});

test('a blocked command wrapped in the CLI Error: prefix is still tagged as blocked', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T7', 'Error: 拒绝：不允许在无人值守时推送远端（不可逆的外发操作）', true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'blocked');
});

// content 的 str / list 两种形态：claude 侧已实测两者并存，qoder 本机实测
// 只有字符串形态（817 条 tool_result，数组 0 条）。这里保持与 claude 同一套
// `.text` 解码约定，以免将来 qoder 真的写出数组时两种约定漂开、标签静默丢失。
// 分类必须按 `.text` 解码数组，否则序列化后以 `[{` 开头、前缀匹配不成立。
test('an array-shaped denial is tagged, and the display text is the decoded reason', () => {
  const parts = [{ type: 'text', text: UNATTENDED_INTERACTION_DENY_REASON }];
  const out = provider.normalizeMessage(transcriptRow('T5', parts, true), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'interaction');
  // 自动拒绝的展示文本走 `.text` 解码后的理由，不再是 JSON —— 前端要原文展示
  // 这段理由（spec §5.1b），JSON 形态会把它埋进 `[{"type":"text",...}]`。
  assert.equal(result?.content, UNATTENDED_INTERACTION_DENY_REASON);
});

// ── spec §5.1b：自动拒绝的展示文本也要剥掉 CLI 的 `Error: ` 包装 ──────────
// 自动拒绝是策略决定、不是工具报错，展示层带着 CLI 的错误标记会让用户在
// 「已自动拒绝」标题下读到 `Error: 拒绝：…`，自相矛盾。
test('an auto-denied result drops the CLI Error: wrapper from the display text', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T8', `Error: ${UNATTENDED_INTERACTION_DENY_REASON}`, true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'interaction');
  assert.equal(result?.content, UNATTENDED_INTERACTION_DENY_REASON);
  assert.ok(!result?.content?.includes('Error:'), 'no CLI error marker on a policy denial');
});

// 反向约束：非自动拒绝的错误结果，`Error: ` 是真的错误标记，必须原样保留 ——
// 不能因为剥前缀的逻辑顺手改掉无关结果的展示。
test('a genuine error keeps its Error: prefix in the display text', () => {
  const out = provider.normalizeMessage(transcriptRow('T9', 'Error: boom: command failed', true), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, undefined);
  assert.equal(result?.content, 'Error: boom: command failed');
});

// 非自动拒绝的数组结果：展示语义一字不变（仍是 JSON.stringify）。
test('a non-denied array result keeps the JSON display shape', () => {
  const parts = [{ type: 'text', text: 'Error: boom: command failed' }];
  const out = provider.normalizeMessage(transcriptRow('T10', parts, true), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, undefined);
  assert.equal(result?.content, JSON.stringify(parts));
});

test('a successful string result keeps its content untouched', () => {
  const out = provider.normalizeMessage(transcriptRow('T11', 'Error: not really an error', false), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, undefined);
  assert.equal(result?.content, 'Error: not really an error');
});

// ── fetchHistory pre-attach: the auto-approve tag must survive a refresh ──
// fetchHistory 把 tool_result 预挂到配对的 tool_use 上，而前端优先读预挂的那个
// （useChatMessages.ts: `msg.toolResult || toolResultMap.get(msg.toolId)`）。
// 只在 normalizeMessage 里打标、漏掉这里的 map 构造或预挂，刷新会话后红框就会
// 回来 —— 计划点名的正是这两个点，删任一处本用例都会红。
test('fetchHistory pre-attaches the auto-approve deny tag onto the paired tool_use', async () => {
  // previousDatabasePath 在 try 外读：finally 恢复它需要这个值。
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  // 临时目录也在 try 内才创建，但变量声明在外，好让 finally 能清理它们 ——
  // 否则 initializeDatabase() 一抛错，env 与两个 mkdtemp 目录就泄漏了。
  let databaseDirectory: string | undefined;
  let fakeHome: string | undefined;

  const APP_SESSION_ID = 'app-sess-deny-tag';
  const PROVIDER_SESSION_ID = 'provider-sess-deny-tag';
  const PROJECT_PATH = '/mnt/b/workdir/gitlab/deny-tag-demo';
  const TOOL_USE_STR = 'toolu_deny_str';
  const TOOL_USE_ARR = 'toolu_deny_arr';

  // 真实形状：CLI 落盘时把理由包进 `Error: `（见文件顶部说明）。集成用例必须
  // 用这个形态，否则合成裸串会让「前缀没剥」的回归悄悄溜过去。
  const transcriptRecords = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: TOOL_USE_STR, name: 'AskUserQuestion', input: {} },
          { type: 'tool_use', id: TOOL_USE_ARR, name: 'AskUserQuestion', input: {} },
        ],
      },
      sessionId: PROVIDER_SESSION_ID,
      cwd: PROJECT_PATH,
      timestamp: '2026-09-23T00:00:00.000Z',
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_STR,
            content: `Error: ${UNATTENDED_INTERACTION_DENY_REASON}`,
            is_error: true,
          },
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ARR,
            content: [{ type: 'text', text: `Error: ${UNATTENDED_INTERACTION_DENY_REASON}` }],
            is_error: true,
          },
        ],
      },
      sessionId: PROVIDER_SESSION_ID,
      cwd: PROJECT_PATH,
      timestamp: '2026-09-23T00:00:01.000Z',
    },
  ];

  try {
    databaseDirectory = await mkdtemp(path.join(tmpdir(), 'qoder-deny-tag-db-'));
    fakeHome = await mkdtemp(path.join(tmpdir(), 'qoder-deny-tag-home-'));
    closeConnection();
    process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
    await initializeDatabase();

    // Same shape startExecution creates: provider_session_id recorded mid-run,
    // jsonl_path never backfilled, so fetchHistory derives the path from HOME.
    sessionsDb.createAppSession(APP_SESSION_ID, 'qoder', PROJECT_PATH, false);
    sessionsDb.assignProviderSessionId(APP_SESSION_ID, PROVIDER_SESSION_ID);
    assert.equal(sessionsDb.getSessionById(APP_SESSION_ID)?.jsonl_path, null);

    // Guard the local branch: a leftover remote index would route this session
    // through the RPC client instead of the on-disk transcript.
    refreshRemoteProjectsIndex([]);

    const projectDir = path.join(
      fakeHome,
      '.qoder',
      'projects',
      '-mnt-b-workdir-gitlab-deny-tag-demo',
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${PROVIDER_SESSION_ID}.jsonl`),
      transcriptRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );

    process.env.HOME = fakeHome;
    const result = await provider.fetchHistory(APP_SESSION_ID, {
      providerSessionId: PROVIDER_SESSION_ID,
      projectPath: PROJECT_PATH,
      limit: null,
      offset: 0,
    });

    const preAttached = (toolId: string) => {
      const msg = result.messages.find((m) => m.kind === 'tool_use' && m.toolId === toolId);
      assert.ok(msg, `expected the tool_use ${toolId} to be normalized`);
      assert.ok(msg.toolResult, 'fetchHistory pre-attaches the paired result');
      return msg.toolResult;
    };

    // 字符串形态 + CLI 的 `Error: ` 包装：qoder 拒绝时实际落盘的形态。
    assert.equal(preAttached(TOOL_USE_STR).isError, true);
    assert.equal(preAttached(TOOL_USE_STR).autoApproveDeny, 'interaction');
    // 历史路径同样要剥掉 CLI 包装，否则刷新会话后「已自动拒绝」下面又冒出
    // `Error: …`（spec §5.1b 的连带问题）。
    assert.equal(preAttached(TOOL_USE_STR).content, UNATTENDED_INTERACTION_DENY_REASON);
    // 数组形态：历史路径必须与 normalizeMessage 共用同一套 `.text` 解码，
    // 否则两种解码约定会漂开，标签静默丢失。
    assert.equal(preAttached(TOOL_USE_ARR).autoApproveDeny, 'interaction');
    assert.equal(preAttached(TOOL_USE_ARR).content, UNATTENDED_INTERACTION_DENY_REASON);
  } finally {
    process.env.HOME = previousHome;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (databaseDirectory) await rm(databaseDirectory, { recursive: true, force: true });
    if (fakeHome) await rm(fakeHome, { recursive: true, force: true });
  }
});
