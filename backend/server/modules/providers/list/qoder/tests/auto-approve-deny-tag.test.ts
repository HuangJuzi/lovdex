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

// 真实 transcript 里 content 有 str / list 两种形态（本机实测 78744 : 2005）。
// 分类必须按 `.text` 约定解码数组，否则序列化后以 `[{` 开头、前缀匹配不成立，
// 标签会静默丢失。展示用的 content 保持 JSON 形态不变。
test('an array-shaped denial is tagged, and the displayed content is unchanged', () => {
  const parts = [{ type: 'text', text: UNATTENDED_INTERACTION_DENY_REASON }];
  const out = provider.normalizeMessage(transcriptRow('T5', parts, true), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'interaction');
  assert.equal(result?.content, JSON.stringify(parts), 'display value stays JSON');
});

// ── fetchHistory pre-attach: the auto-approve tag must survive a refresh ──
// fetchHistory 把 tool_result 预挂到配对的 tool_use 上，而前端优先读预挂的那个
// （useChatMessages.ts: `msg.toolResult || toolResultMap.get(msg.toolId)`）。
// 只在 normalizeMessage 里打标、漏掉这里的 map 构造或预挂，刷新会话后红框就会
// 回来 —— 计划点名的正是这两个点，删任一处本用例都会红。
test('fetchHistory pre-attaches the auto-approve deny tag onto the paired tool_use', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'qoder-deny-tag-db-'));
  const fakeHome = await mkdtemp(path.join(tmpdir(), 'qoder-deny-tag-home-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  const APP_SESSION_ID = 'app-sess-deny-tag';
  const PROVIDER_SESSION_ID = 'provider-sess-deny-tag';
  const PROJECT_PATH = '/mnt/b/workdir/gitlab/deny-tag-demo';
  const TOOL_USE_STR = 'toolu_deny_str';
  const TOOL_USE_ARR = 'toolu_deny_arr';

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
            content: UNATTENDED_INTERACTION_DENY_REASON,
            is_error: true,
          },
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ARR,
            content: [{ type: 'text', text: UNATTENDED_INTERACTION_DENY_REASON }],
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

    // 字符串形态：SDK 拒绝时实际写出的形态。
    assert.equal(preAttached(TOOL_USE_STR).isError, true);
    assert.equal(preAttached(TOOL_USE_STR).autoApproveDeny, 'interaction');
    // 数组形态：历史路径必须与 normalizeMessage 共用同一套 `.text` 解码，
    // 否则两种解码约定会漂开，标签静默丢失。
    assert.equal(preAttached(TOOL_USE_ARR).autoApproveDeny, 'interaction');
  } finally {
    process.env.HOME = previousHome;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});
