# 转为任务弹窗补充字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展「转为任务」弹窗，新增 **优先级 / 标签 / 截止时间 / 备注** 四个可编辑字段，并在创建任务时**静默带上会话当前模型**（弹窗不显示该字段）。

**Architecture:** 前端纯函数 `buildSessionToTaskPayload` 扩展默认值（P2 / other / 空 / 空 / 会话模型），`ConvertToTaskDialog` 新增 4 个表单控件并透传 create body。后端 `POST /api/tasks` 已支持全部字段，**零改动**。

**Tech Stack:** React + TypeScript + Vite；测试 `npx tsx --test`（node:test）。

**Spec:** `docs/superpowers/specs/2026-08-13-convert-to-task-dialog-fields-design.md`

**仓库：** 仅前端 `lovdex-cli`（当前 `main`，工作区干净，无未提交改动）。

> ⚠️ 测试命令必须显式带 `TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json` —— 本环境全局导出了 `TSX_TSCONFIG_PATH=server/tsconfig.json`，会误解析 backend 的 tsconfig 导致 `npx tsx` 在 cli 里崩溃。

---

## 文件结构

**前端（lovdex-cli/）**
- 修改 `src/components/chat/view/subcomponents/convertToTaskPayload.ts` — 扩展 `SessionToTaskPayload` 类型 + 默认值 + 模型解析助手。
- 修改 `src/components/chat/view/subcomponents/convertToTaskPayload.test.ts` — 新增字段测试。
- 修改 `src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx` — 新增 4 个控件 + create body 透传。

---

## Task 1: 扩展 `buildSessionToTaskPayload` 类型与默认值（TDD）

**Files:**
- Modify: `lovdex-cli/src/components/chat/view/subcomponents/convertToTaskPayload.ts`
- Modify: `lovdex-cli/src/components/chat/view/subcomponents/convertToTaskPayload.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `convertToTaskPayload.test.ts` 末尾追加两个用例：

```ts
test('meta fields default to P2 / other / empty / empty', () => {
  const p = buildSessionToTaskPayload({ session: makeSession(), isRunning: false });
  assert.equal(p.priority, 'P2');
  assert.equal(p.label, 'other');
  assert.equal(p.deadline, '');
  assert.equal(p.remark, '');
});

test('executorModel resolves provider fallback (localStorage absent in node:test)', () => {
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'claude' }), isRunning: false }).executorModel, 'default');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'codex' }), isRunning: false }).executorModel, 'gpt-5.4');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({ provider: 'sophcode' }), isRunning: false }).executorModel, 'opencode/deepseek-v4-flash-free');
  assert.equal(buildSessionToTaskPayload({ session: makeSession({}), isRunning: false }).executorModel, '');
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
```
Expected: 两个新用例 FAIL（`buildSessionToTaskPayload` 返回的 payload 里 `priority`/`executorModel` 是 `undefined`）。

- [ ] **Step 3: 实现** — 把 `convertToTaskPayload.ts` 整体替换为：

```ts
import type { ProjectSession, TaskEngine, TaskStatus, TaskPriority, TaskLabel, LLMProvider } from '../../../../types/app';
import { resolveSessionTitle } from '../../../../utils/sessionTitle';

export type SessionToTaskPayload = {
  title: string;
  description: string;
  executorProvider: TaskEngine;
  executorModel: string;
  status: TaskStatus;
  priority: TaskPriority;
  label: TaskLabel;
  deadline: string;
  remark: string;
};

/** 各 provider 的兜底模型（与 useChatProviderState 的私有副本同值，保持模块自包含）。 */
const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
  sophcode: 'opencode/deepseek-v4-flash-free',
};

function isTaskEngine(value: unknown): value is TaskEngine {
  return value === 'claude' || value === 'codex' || value === 'sophcode';
}

function resolveProviderModelDefault(provider: LLMProvider | undefined | null): string {
  if (!provider) return '';
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(`${provider}-model`);
  return stored || FALLBACK_DEFAULT_MODEL[provider] || '';
}

/**
 * Compute the conversion dialog's default payload from a session.
 * Pure so it can be unit-tested without a React renderer.
 * Status defaults from the running rule (running → in_progress, else todo);
 * the dialog lets the user override it. Meta fields default to the same values
 * TaskDetail uses; executorModel is carried silently (not shown in the dialog).
 */
export function buildSessionToTaskPayload(input: {
  session: ProjectSession | null;
  isRunning: boolean;
}): SessionToTaskPayload {
  const session = input.session;
  const title = resolveSessionTitle(session) ?? '';
  const description = typeof session?.summary === 'string' ? session.summary : '';
  const executorProvider = isTaskEngine(session?.provider) ? session.provider : 'claude';
  const executorModel = resolveProviderModelDefault(session?.provider);
  const status: TaskStatus = input.isRunning ? 'in_progress' : 'todo';
  return {
    title,
    description,
    executorProvider,
    executorModel,
    status,
    priority: 'P2',
    label: 'other',
    deadline: '',
    remark: '',
  };
}
```

- [ ] **Step 4: 运行确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
```
Expected: 全部 PASS（原 4 个 + 新 2 个）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/chat/view/subcomponents/convertToTaskPayload.ts src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
git commit -m "feat(tasks): extend session→task payload with priority/label/deadline/remark/model"
```

---

## Task 2: `ConvertToTaskDialog` 新增 4 个控件 + 静默模型透传

**Files:**
- Modify: `lovdex-cli/src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx`

（无 React 渲染测试基建——纯函数已在 Task 1 覆盖；用 typecheck + lint + 手验兜底。）

- [ ] **Step 1: 实现** — 把 `ConvertToTaskDialog.tsx` 整体替换为：

```tsx
import { useEffect, useRef, useState } from 'react';

import { Button, Dialog, DialogContent, Input } from '../../../../shared/view/ui';
import { STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER, LABEL_META, LABEL_ORDER } from '../../../tasks/taskStatus';
import { api } from '../../../../utils/api';
import type { ProjectSession, TaskEngine, TaskStatus, TaskPriority, TaskLabel } from '../../../../types/app';
import { buildSessionToTaskPayload } from './convertToTaskPayload';

type ConvertToTaskDialogProps = {
  session: ProjectSession | null;
  projectPath: string;
  isRunning: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ConvertToTaskDialog({
  session,
  projectPath,
  isRunning,
  open,
  onOpenChange,
}: ConvertToTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [executorProvider, setExecutorProvider] = useState<TaskEngine>('claude');
  const [executorModel, setExecutorModel] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [label, setLabel] = useState<TaskLabel>('other');
  const [deadline, setDeadline] = useState('');
  const [remark, setRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed form state only when the dialog transitions to open (fresh conversion
  // or a different session). Mid-open changes to `isRunning` / `session`
  // (e.g. the session completes while the user is typing) must not clobber the
  // user's edits, so this does NOT re-seed on those dep changes while open.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    const defaults = buildSessionToTaskPayload({ session, isRunning });
    setTitle(defaults.title);
    setDescription(defaults.description);
    setExecutorProvider(defaults.executorProvider);
    setExecutorModel(defaults.executorModel);
    setStatus(defaults.status);
    setPriority(defaults.priority);
    setLabel(defaults.label);
    setDeadline(defaults.deadline);
    setRemark(defaults.remark);
    setError(null);
  }, [open, session, isRunning]);

  async function handleCreate() {
    if (!session || submitting) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.tasks.create({
        projectPath,
        title: trimmedTitle,
        description: description.trim() || null,
        executorProvider,
        executorModel: executorModel.trim() || null,
        status,
        priority,
        label,
        deadline: deadline || null,
        remark: remark.trim() || null,
        sessionId: session.id,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        // 409 + SESSION_ALREADY_LINKED = the session is already linked
        // (concurrent double-click / another tab). The existing link surfaces
        // via useLinkedTask, so just close. Any other error (including
        // SESSION_PROJECT_MISMATCH, also 409) keeps the form open with a message.
        if (body?.error?.code === 'SESSION_ALREADY_LINKED') {
          onOpenChange(false);
          return;
        }
        setError(body?.error?.message ?? `创建失败 (${res.status})`);
        return;
      }
      onOpenChange(false);
    } catch (err) {
      setError('创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  const selectClass = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-lg p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">转为任务</h2>
        <div className="flex flex-col gap-3 pt-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">标题</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题" autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">描述</span>
            <textarea
              className="min-h-[64px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="任务描述"
              rows={3}
            />
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">执行引擎</span>
              <select
                className={selectClass}
                value={executorProvider}
                onChange={(e) => setExecutorProvider(e.target.value as TaskEngine)}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="sophcode">SophCode</option>
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">状态</span>
              <select
                className={selectClass}
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">优先级</span>
              <select
                className={selectClass}
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
              >
                {PRIORITY_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_META[p].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">标签</span>
              <select
                className={selectClass}
                value={label}
                onChange={(e) => setLabel(e.target.value as TaskLabel)}
              >
                {LABEL_ORDER.map((l) => (
                  <option key={l} value={l}>
                    {LABEL_META[l].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">截止时间</span>
              <input
                type="date"
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">备注</span>
              <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="需求来源等，可留空" />
            </label>
          </div>
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button size="sm" disabled={!title.trim() || submitting} onClick={() => void handleCreate()}>
            创建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 验证编译 + lint**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck && npm run lint
```
Expected: 无新增错误。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/chat/view/subcomponents/ConvertToTaskDialog.tsx
git commit -m "feat(tasks): add priority/label/deadline/remark fields to convert dialog"
```

---

## Task 3: 全量验证 + 手验清单

- [ ] **Step 1: 前端测试 + typecheck + lint**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
TSX_TSCONFIG_PATH=/mnt/b/workdir/github/lovdex/lovdex-cli/tsconfig.json npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts
npm run typecheck
npm run lint
```
Expected: 全 PASS。

- [ ] **Step 2: 后端回归确认（未改动，仅确认无影响）**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
npx tsx --test server/modules/tasks/tests/tasks.service.test.ts
npx tsx --test server/modules/database/tests/tasks.db.integration.test.ts
```
Expected: 全 PASS（后端未动，仅确认当前 main 状态干净）。

- [ ] **Step 3: 手验**（后端 tsx 起服务 + 前端 `npm run dev`）

1. 打开一个**无关联任务**的会话 → 头部「转为任务」→ 点击弹窗。
2. 弹窗新增 优先级（默认「P2 中」）/ 标签（默认「其他」）/ 截止时间（空）/ 备注（空）；**不显示执行模型字段**。
3. 选 P1 / 新特性 / 截止日期 / 填备注 → 点「创建」。
4. 到 `/tasks` 看板确认该任务显示 P1、新特性标签、截止日；打开任务详情确认备注与「模型」字段=会话当前模型。
5. 全部新字段留空再创建一个任务 → 创建成功，详情里优先级 P2、标签 其他、截止/备注空。
6. 空标题时「创建」按钮仍禁用。

- [ ] **Step 4: 收尾提交检查**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git log --oneline -4
```
Expected: 顶部两个本功能提交；工作区无残留改动。

---

## 验收标准（Spec 对照）

- [ ] 弹窗新增 优先级 / 标签 / 截止时间 / 备注，默认值 P2 / other / 空 / 空。
- [ ] 创建成功后在任务详情/看板能看到刚填的优先级、标签、截止、备注。
- [ ] 弹窗不出现「执行模型」字段，但创建的任务 `executor_model` 等于会话当前 provider 模型。
- [ ] 全部新字段留空时创建不报错（转 `null` 落库）。
- [ ] 后端测试套件回归通过（未改动，仅确认无影响）。
