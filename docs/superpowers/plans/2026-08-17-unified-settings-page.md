# Unified Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Provider settings, Operator Agent settings, Change password, Logout, and a new Database path field into one `/settings` page with left-tab navigation.

**Architecture:** A new `SettingsPage` route renders a left (desktop) / top (mobile) tab nav and dispatches to four form components. `ProviderSettingsForm` is reused as-is; `OperatorSettingsForm` is extracted from the old operator route page; `DatabaseSettingsForm` and `AccountSettingsSection` are new. Old routes `/settings/providers` and `/settings/operator` redirect to `/settings?tab=…`, and the modal-based settings dialog + footer password/logout buttons are removed.

**Tech Stack:** React 18 + TypeScript, react-router-dom v6, Tailwind, i18next. Tests: `node:test` + `node:assert/strict` + `react-dom/server` `renderToStaticMarkup` smoke tests (run via `npx tsx --test`). No backend changes.

**Repo / commands:**
- Frontend dir: `/mnt/b/workdir/github/lovdex/lovdex/web`
- Run a frontend test: `cd /mnt/b/workdir/github/lovdex/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test <file>`
- Typecheck: `cd /mnt/b/workdir/github/lovdex/lovdex/web && npm run typecheck`
- Lint: `cd /mnt/b/workdir/github/lovdex/lovdex/web && npm run lint`
- ⚠️ Git is a "hot branch": another process commits to `main` concurrently. Before every commit, run `git branch --show-current` and `git status`; `git add` ONLY the files for the current task, never `git add -A`.

---

## File Structure

Create:
- `web/src/components/settings/settingsTabs.ts` — `SettingsTab` type + tab list + `resolveSettingsTab` pure helper.
- `web/src/components/settings/SettingsPage.tsx` — page shell (header + tab nav + form dispatch).
- `web/src/components/settings/OperatorSettingsForm.tsx` — operator form body (extracted from old page).
- `web/src/components/settings/DatabaseSettingsForm.tsx` — database path form.
- `web/src/components/settings/ChangePasswordForm.tsx` — inline change-password form (from old dialog).
- `web/src/components/settings/AccountSettingsSection.tsx` — change-password form + logout button.
- Tests: `settingsTabs.test.ts`, `SettingsPage.test.tsx`, `DatabaseSettingsForm.test.tsx`.

Modify:
- `web/src/components/settings/ProviderSettingsPage.tsx` — keep `ProviderSettingsForm`, delete the `ProviderSettingsPage` route wrapper + `BackToTasksButton` import.
- `web/src/App.tsx` — add `/settings` route + redirects; remove `SettingsDialog`/`SettingsDialogProvider`.
- `web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx` — gear navigates to `/settings`; remove password/logout buttons.
- `web/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx` — deep links → `/settings?tab=operator`.

Delete:
- `web/src/components/settings/SettingsDialog.tsx`
- `web/src/hooks/useSettingsDialog.tsx`
- `web/src/components/auth/ChangePasswordDialog.tsx`
- `web/src/components/operators/OperatorSettingsPage.tsx`

---

### Task 1: Tab type + resolver (pure logic)

**Files:**
- Create: `web/src/components/settings/settingsTabs.ts`
- Test: `web/src/components/settings/settingsTabs.test.ts`

- [ ] **Step 1: Write the failing test**

`web/src/components/settings/settingsTabs.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSettingsTab, SETTINGS_TABS } from './settingsTabs';

test('resolveSettingsTab defaults to providers for missing/unknown values', () => {
  assert.equal(resolveSettingsTab(undefined), 'providers');
  assert.equal(resolveSettingsTab(null), 'providers');
  assert.equal(resolveSettingsTab(''), 'providers');
  assert.equal(resolveSettingsTab('bogus'), 'providers');
});

test('resolveSettingsTab maps known tab keys', () => {
  assert.equal(resolveSettingsTab('providers'), 'providers');
  assert.equal(resolveSettingsTab('operator'), 'operator');
  assert.equal(resolveSettingsTab('database'), 'database');
  assert.equal(resolveSettingsTab('account'), 'account');
});

test('SETTINGS_TABS lists the four tabs in order', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((t) => t.key),
    ['providers', 'operator', 'database', 'account'],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/settings/settingsTabs.test.ts`

Expected: FAIL — cannot resolve `./settingsTabs`.

- [ ] **Step 3: Write implementation**

`web/src/components/settings/settingsTabs.ts`:

```ts
export type SettingsTab = 'providers' | 'operator' | 'database' | 'account';

export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'providers', label: 'Provider 设置' },
  { key: 'operator', label: 'Operator Agent 设置' },
  { key: 'database', label: '数据库' },
  { key: 'account', label: '账号' },
];

const VALID_TABS = new Set<SettingsTab>(['providers', 'operator', 'database', 'account']);

/** Map a `?tab=` value to a valid tab key, defaulting to `providers` for missing/unknown. */
export function resolveSettingsTab(raw: string | null | undefined): SettingsTab {
  return raw && VALID_TABS.has(raw as SettingsTab) ? (raw as SettingsTab) : 'providers';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/settings/settingsTabs.test.ts`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git branch --show-current && git status --short
git add web/src/components/settings/settingsTabs.ts web/src/components/settings/settingsTabs.test.ts
git commit -m "feat(settings): add settings tab type + resolver"
```

---

### Task 2: Database path form

**Files:**
- Create: `web/src/components/settings/DatabaseSettingsForm.tsx`
- Test: `web/src/components/settings/DatabaseSettingsForm.test.tsx`

- [ ] **Step 1: Write the component**

`web/src/components/settings/DatabaseSettingsForm.tsx`:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

type DatabaseConfig = { database?: { path?: string } };

/**
 * 数据库路径设置。后端 `GET /api/config` 读 `database.path`、`PUT /api/config`
 * 写。数据库连接在 boot 时建立，保存后需重启后端才生效（与端口/host 同等待遇）。
 */
export function DatabaseSettingsForm() {
  const [path, setPath] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/config')
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const cfg = (await res.json()) as DatabaseConfig;
        if (!cancelled) {
          setPath(cfg.database?.path ?? '');
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    try {
      const res = await api.put('/config', { database: { path: path.trim() } });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error?.message ?? `保存失败（${res.status}）`);
        return;
      }
      setSavedMsg('已保存。数据库路径修改需重启后端生效。');
    } catch (err) {
      setSaveError((err as Error).message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <div className="text-sm text-muted-foreground">加载配置失败</div>
        <Button size="sm" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }
  if (!loaded) {
    return <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">数据库路径</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          后端 SQLite 数据库文件位置。保存后需重启后端生效。
        </p>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            数据库路径 (database.path)
          </label>
          <input
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={path}
            placeholder="~/.lovdex/data/auth.db"
            onChange={(e) => {
              setSavedMsg(null);
              setPath(e.target.value);
            }}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {savedMsg && !saveError && (
          <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>
        )}
        {saveError && <span className="text-xs text-red-500">{saveError}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the smoke test**

`web/src/components/settings/DatabaseSettingsForm.test.tsx`:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DatabaseSettingsForm } from './DatabaseSettingsForm';

// renderToStaticMarkup does not run effects, so the form renders its initial
// "loading" state without touching fetch.
test('renders loading state before config loads', () => {
  const html = renderToStaticMarkup(<DatabaseSettingsForm />);
  assert.match(html, /加载中/);
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/settings/DatabaseSettingsForm.test.tsx`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git branch --show-current && git status --short
git add web/src/components/settings/DatabaseSettingsForm.tsx web/src/components/settings/DatabaseSettingsForm.test.tsx
git commit -m "feat(settings): add database path form"
```

---

### Task 3: Extract OperatorSettingsForm

**Files:**
- Create: `web/src/components/settings/OperatorSettingsForm.tsx`
- Delete: `web/src/components/operators/OperatorSettingsPage.tsx`

- [ ] **Step 1: Create the extracted form**

`web/src/components/settings/OperatorSettingsForm.tsx` (the operator form body, no page header/container — the full state/effect/patch/save logic is carried over verbatim from the old `OperatorSettingsPage`; the `loadError` branch drops the full-screen `h-dvh` centering in favor of inline padding, and the `!loaded` branch is identical):

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

/**
 * Operator Agent 配置表单主体（无页面外框）。
 *
 * 后端 `GET/PUT /api/operator/settings` 读写 `app_config` 里的 operator 配置。
 * 不配置也能用（后端有安全默认）；这里开了能调自动化强度与模型/并发等。
 */

type OperatorConfig = {
  enabled: boolean;
  auto_verdict_enabled: boolean;
  model: string;
  max_concurrent: number;
  verdict_prompt_override: string | null;
  interactive_chat_enabled: boolean;
};

const EMPTY: OperatorConfig = {
  enabled: true,
  auto_verdict_enabled: true,
  model: '',
  max_concurrent: 2,
  verdict_prompt_override: null,
  interactive_chat_enabled: true,
};

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}

export function OperatorSettingsForm() {
  const [config, setConfig] = useState<OperatorConfig>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.operator
      .settings()
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const data = (await res.json()) as OperatorConfig;
        if (cancelled) return;
        setConfig({ ...EMPTY, ...data });
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function patch(partial: Partial<OperatorConfig>) {
    setConfig((prev) => ({ ...prev, ...partial }));
    setSavedAt(null);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.operator.updateSettings(config);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error?.message ?? `保存失败（${res.status}）`);
        return;
      }
      const data = (await res.json()) as OperatorConfig;
      setConfig({ ...EMPTY, ...data });
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError((err as Error).message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <div className="text-sm text-muted-foreground">加载 Operator 配置失败</div>
        <Button size="sm" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }

  if (!loaded) {
    return <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 总开关 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">总开关</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          关闭后 Operator Agent 完全停用（含自动判定）。不配置也能用，后端有安全默认。
        </p>
        <Toggle
          label="启用 Operator Agent"
          checked={config.enabled}
          onChange={(v) => patch({ enabled: v })}
        />
        <Toggle
          label="启用 Lovdex助手面板"
          description="关闭后侧边栏不显示「Lovdex助手」入口。"
          checked={config.interactive_chat_enabled}
          onChange={(v) => patch({ interactive_chat_enabled: v })}
        />
      </section>

      {/* 自动判定 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">自动判定</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          任务 session 跑完后，Operator 自动读 transcript 出 summary + verdict，写入 sub_status
          标签。done 判定留在评审列等你验收；计划待执行/待你决策/需协助会移回进行中列。
        </p>
        <Toggle
          label="完成时自动判定"
          description="session completed 后自动起头跑读 transcript、写 summary/verdict。"
          checked={config.auto_verdict_enabled}
          onChange={(v) => patch({ auto_verdict_enabled: v })}
        />
      </section>

      {/* 模型与运行环境 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">模型与运行环境</h2>
        <div className="mb-3">
          <label className="mb-1 block text-xs text-muted-foreground">模型</label>
          <input
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={config.model}
            placeholder="留空用默认 Claude 模型"
            onChange={(e) => patch({ model: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">头跑并发上限</label>
          <input
            type="number"
            min={1}
            max={16}
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={config.max_concurrent}
            onChange={(e) => patch({ max_concurrent: Math.max(1, Number(e.target.value) || 1) })}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            同时跑多少个 auto-verdict 头跑；超了排队。
          </p>
        </div>
      </section>

      {/* 判定 prompt 覆盖 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">判定 Prompt 覆盖</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          留空用内置默认 prompt。覆盖后会完全替换自动判定时发给 Operator 的指令。
        </p>
        <textarea
          className="min-h-[120px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
          value={config.verdict_prompt_override ?? ''}
          placeholder="留空用默认 prompt"
          onChange={(e) => patch({ verdict_prompt_override: e.target.value || null })}
        />
      </section>

      {/* 保存栏 */}
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {savedAt && !saveError && (
          <span className="text-xs text-green-600 dark:text-green-400">已保存</span>
        )}
        {saveError && <span className="text-xs text-red-500">{saveError}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Delete the old route page**

Delete `web/src/components/operators/OperatorSettingsPage.tsx` (its `/settings/operator` route will be replaced by a redirect in Task 6).

- [ ] **Step 3: Typecheck (module still referenced by App.tsx until Task 6 — defer full typecheck to Task 6)**

Expected: this task alone leaves `App.tsx` importing a now-deleted module; do NOT run typecheck yet. Proceed to Task 6 which fixes `App.tsx`.

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git branch --show-current && git status --short
git add web/src/components/settings/OperatorSettingsForm.tsx
git rm web/src/components/operators/OperatorSettingsPage.tsx
git commit -m "refactor(settings): extract OperatorSettingsForm from route page"
```

---

### Task 4: Change-password form + account section

**Files:**
- Create: `web/src/components/settings/ChangePasswordForm.tsx`
- Create: `web/src/components/settings/AccountSettingsSection.tsx`

- [ ] **Step 1: Create ChangePasswordForm**

`web/src/components/settings/ChangePasswordForm.tsx` (form logic migrated from `ChangePasswordDialog.tsx`, minus the `Dialog` wrapper and open/close effect; on success it clears fields and auto-dismisses the success banner after 800ms):

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';

/**
 * 修改密码内联表单（从 ChangePasswordDialog 迁入，去掉 Dialog 外框）。
 * 走 `POST /api/auth/change-password`（raw fetch，避免 401 触发全局登出）。
 */
export default function ChangePasswordForm() {
  const { t } = useTranslation('auth');
  const [currentCode, setCurrentCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentCode.trim() || !newCode.trim() || !confirmCode.trim()) {
      setError(t('changePassword.errors.requiredFields'));
      return;
    }
    if (newCode !== confirmCode) {
      setError(t('changePassword.errors.mismatch'));
      return;
    }
    if (newCode.trim().length < 4) {
      setError(t('changePassword.errors.tooShort'));
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await api.auth.changePassword(currentCode, newCode);
      if (res.ok) {
        setSuccess(true);
        setCurrentCode('');
        setNewCode('');
        setConfirmCode('');
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          setSuccess(false);
          setSubmitting(false);
        }, 800);
      } else {
        setError(
          res.status === 401
            ? t('changePassword.errors.wrongCurrent')
            : res.status === 400
              ? t('changePassword.errors.invalidNew')
              : t('changePassword.errors.generic'),
        );
        setSubmitting(false);
      }
    } catch (err) {
      setError(
        err instanceof TypeError
          ? t('changePassword.errors.networkError')
          : t('changePassword.errors.generic'),
      );
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="cp-current" className="text-sm font-medium text-foreground">
          {t('changePassword.current')}
        </label>
        <Input
          id="cp-current"
          type="password"
          value={currentCode}
          onChange={(e) => setCurrentCode(e.target.value)}
          placeholder={t('changePassword.placeholders.current')}
          autoComplete="current-password"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="cp-new" className="text-sm font-medium text-foreground">
          {t('changePassword.new')}
        </label>
        <Input
          id="cp-new"
          type="password"
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          placeholder={t('changePassword.placeholders.new')}
          autoComplete="new-password"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="cp-confirm" className="text-sm font-medium text-foreground">
          {t('changePassword.confirm')}
        </label>
        <Input
          id="cp-confirm"
          type="password"
          value={confirmCode}
          onChange={(e) => setConfirmCode(e.target.value)}
          placeholder={t('changePassword.placeholders.confirm')}
          autoComplete="new-password"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {t('changePassword.success')}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="submit" disabled={submitting}>
          {submitting ? t('changePassword.loading') : t('changePassword.submit')}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Create AccountSettingsSection**

`web/src/components/settings/AccountSettingsSection.tsx`:

```tsx
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/AuthGate';
import { Button } from '../../shared/view/ui';
import ChangePasswordForm from './ChangePasswordForm';

/**
 * 账号 Tab：修改密码（内联表单）+ 登出。platform 模式下由 SettingsPage
 * 隐藏整个 Tab（无本地密码/登出）。
 */
export function AccountSettingsSection() {
  const { t } = useTranslation('auth');
  const { logout } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">{t('changePassword.title')}</h2>
        <ChangePasswordForm />
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">{t('logout.title')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('logout.confirm')}</p>
        <Button variant="destructive" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" />
          {t('logout.button')}
        </Button>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git branch --show-current && git status --short
git add web/src/components/settings/ChangePasswordForm.tsx web/src/components/settings/AccountSettingsSection.tsx
git commit -m "feat(settings): add account section (change password + logout)"
```

Note: no automated test for these two — `ChangePasswordForm` needs i18next's browser `LanguageDetector` (window) and `AccountSettingsSection` needs `AuthGate`'s context; both are covered by typecheck + the full-app build in Task 10.

---

### Task 5: SettingsPage shell + smoke test

**Files:**
- Create: `web/src/components/settings/SettingsPage.tsx`
- Test: `web/src/components/settings/SettingsPage.test.tsx`

- [ ] **Step 1: Create SettingsPage**

`web/src/components/settings/SettingsPage.tsx`:

```tsx
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { cn } from '../../lib/utils';
import { IS_PLATFORM } from '../../constants/config';
import { BackToTasksButton } from '../tasks/TaskBackNav';
import { ProviderSettingsForm } from './ProviderSettingsPage';
import { OperatorSettingsForm } from './OperatorSettingsForm';
import { DatabaseSettingsForm } from './DatabaseSettingsForm';
import { AccountSettingsSection } from './AccountSettingsSection';
import { SETTINGS_TABS, resolveSettingsTab, type SettingsTab } from './settingsTabs';

/**
 * 统一设置页：左侧 Tab 导航（Provider / Operator Agent / 数据库 / 账号），
 * 右侧渲染对应表单。Tab 由 ?tab= 查询参数驱动，默认 providers；非法值回退。
 * platform 模式下隐藏「账号」Tab（无本地密码/登出）。
 */
export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const visibleTabs = useMemo(
    () => (IS_PLATFORM() ? SETTINGS_TABS.filter((tab) => tab.key !== 'account') : SETTINGS_TABS),
    [],
  );

  const requested = resolveSettingsTab(searchParams.get('tab'));
  const activeTab: SettingsTab = visibleTabs.some((tab) => tab.key === requested)
    ? requested
    : 'providers';

  function selectTab(key: SettingsTab) {
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <BackToTasksButton />
        <h1 className="ml-2 text-sm font-semibold text-foreground">设置</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 桌面左侧 Tab 导航 */}
        <nav className="hidden w-52 flex-shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 p-3 md:flex">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => selectTab(tab.key)}
              className={cn(
                'rounded-md px-3 py-2 text-left text-sm transition-colors',
                activeTab === tab.key
                  ? 'bg-primary/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 移动端顶部横排 Tab */}
          <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 md:hidden">
            {visibleTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => selectTab(tab.key)}
                className={cn(
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
                  activeTab === tab.key
                    ? 'bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-4 py-6 sm:p-6">
              {activeTab === 'providers' && <ProviderSettingsForm />}
              {activeTab === 'operator' && <OperatorSettingsForm />}
              {activeTab === 'database' && <DatabaseSettingsForm />}
              {activeTab === 'account' && <AccountSettingsSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the smoke test**

`web/src/components/settings/SettingsPage.test.tsx` (renders with `StaticRouter`; `renderToStaticMarkup` does not run effects, so the forms show their "loading" state; avoid rendering the `account` tab content because it calls `useAuth` which has no provider in this test):

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import SettingsPage from './SettingsPage';

test('renders default providers tab with all nav labels', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/settings">
      <SettingsPage />
    </StaticRouter>,
  );
  assert.match(html, /设置/);
  assert.match(html, /Provider 设置/);
  assert.match(html, /Operator Agent 设置/);
  assert.match(html, /数据库/);
  assert.match(html, /账号/);
});

test('renders database form for tab=database', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/settings?tab=database">
      <SettingsPage />
    </StaticRouter>,
  );
  assert.match(html, /数据库路径/);
});

test('falls back to providers for unknown tab', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/settings?tab=bogus">
      <SettingsPage />
    </StaticRouter>,
  );
  assert.match(html, /加载中/); // ProviderSettingsForm initial state
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/settings/SettingsPage.test.tsx`

Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git branch --show-current && git status --short
git add web/src/components/settings/SettingsPage.tsx web/src/components/settings/SettingsPage.test.tsx
git commit -m "feat(settings): add unified settings page shell"
```

---

### Task 6: Routes + remove modal wiring (App.tsx)

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Update imports**

In `web/src/App.tsx`:

Change line 2 from:
```tsx
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
```
to:
```tsx
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
```

Replace the component import block (lines 10–16) — remove `OperatorSettingsPage`, `ProviderSettingsPage`, `SettingsDialogProvider`, `SettingsDialog`; add `SettingsPage`:
```tsx
import { TaskBoardPage, TaskDetailPage } from './components/tasks';
import { AssistantPanel } from './components/operators/AssistantPanel';
import SettingsPage from './components/settings/SettingsPage';
import { TerminalDrawerProvider } from './hooks/useTerminalDrawer';
import i18n from './i18n/config.js';
```

- [ ] **Step 2: Update the Router tree**

Replace:
```tsx
              <SettingsDialogProvider>
                <TerminalDrawerProvider>
                  <Routes>
                    <Route path="/" element={<AppContent />} />
                    <Route path="/session/:sessionId" element={<AppContent />} />
                    <Route path="/tasks" element={<TaskBoardPage />} />
                    <Route path="/task/:taskId" element={<TaskDetailPage />} />
                    <Route path="/assistant" element={<AssistantPanel />} />
                    <Route path="/settings/operator" element={<OperatorSettingsPage />} />
                    <Route path="/settings/providers" element={<ProviderSettingsPage />} />
                  </Routes>
                  <SettingsDialog />
                </TerminalDrawerProvider>
              </SettingsDialogProvider>
```
with:
```tsx
              <TerminalDrawerProvider>
                <Routes>
                  <Route path="/" element={<AppContent />} />
                  <Route path="/session/:sessionId" element={<AppContent />} />
                  <Route path="/tasks" element={<TaskBoardPage />} />
                  <Route path="/task/:taskId" element={<TaskDetailPage />} />
                  <Route path="/assistant" element={<AssistantPanel />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/settings/providers" element={<Navigate to="/settings?tab=providers" replace />} />
                  <Route path="/settings/operator" element={<Navigate to="/settings?tab=operator" replace />} />
                </Routes>
              </TerminalDrawerProvider>
```

- [ ] **Step 3: Delete modal + provider page leftovers**

- Delete `web/src/components/settings/SettingsDialog.tsx`
- Delete `web/src/hooks/useSettingsDialog.tsx`

Also in `web/src/components/settings/ProviderSettingsPage.tsx`: delete the `BackToTasksButton` import (line 5), the `ProviderSettingsPage` wrapper function (the block starting `/** 路由页入口：/settings/providers…` through its closing brace), and the `export default ProviderSettingsPage;` line. Keep `ProviderSettingsForm`. Update the top JSDoc block (lines 7–19) to remove the now-dead `SettingsDialog` reference:

```tsx
/**
 * Provider 凭据 + 运行参数设置。
 *
 * 表单主体是 <ProviderSettingsForm />：由统一设置页 /settings 的 Provider Tab
 * 渲染（draft 加载 / 保存 / 渲染逻辑全在这里）。
 *
 * 后端 `GET /api/config`（匿名、密钥打码）读、`PUT /api/config`（需登录）写。
 * GET 回来的密钥是打码占位（`••••abcd`）；PUT 时后端 `stripMaskedPlaceholders`
 * 会丢弃任何以 `••••` 开头的字段，因此这里可以把整个 draft 原样 PUT。
 *
 * 保存后后端 re-sync process.env（权威语义），模型 / Base URL / 凭据对新起的
 * session 立即生效；端口 / host / 数据库路径需重启后端才生效。
 */
```

- [ ] **Step 4: Delete ChangePasswordDialog**

Delete `web/src/components/auth/ChangePasswordDialog.tsx` (logic now lives in `ChangePasswordForm`).

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git branch --show-current && git status --short
git add web/src/App.tsx web/src/components/settings/ProviderSettingsPage.tsx
git rm web/src/components/settings/SettingsDialog.tsx web/src/hooks/useSettingsDialog.tsx web/src/components/auth/ChangePasswordDialog.tsx
git commit -m "feat(settings): route /settings with redirects; remove modal dialog"
```

Note: do NOT run typecheck yet — `SidebarFooter.tsx` still imports the now-deleted `useSettingsDialog` until Task 7 fixes it. Typecheck runs in Task 7 Step 5.

---

### Task 7: Sidebar entry points (footer + assistant)

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx`

- [ ] **Step 1: Rewrite SidebarFooter imports**

In `web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`:

- Delete line 1 (`import { useState } from 'react';`).
- Add `import { useNavigate } from 'react-router-dom';`.
- Change the lucide import (line 2) to drop `KeyRound` and `LogOut`:
```tsx
import { ArrowUpCircle, Bug, AlertTriangle, Settings2 } from 'lucide-react';
```
- Delete line 4 (`import { IS_PLATFORM } from '../../../../constants/config';`).
- Delete line 6 (`import { useAuth } from '../../../auth/AuthGate';`).
- Delete line 7 (`import ChangePasswordDialog from '../../../auth/ChangePasswordDialog';`).
- Delete line 9 (`import { useSettingsDialog } from '../../../../hooks/useSettingsDialog';`).

- [ ] **Step 2: Update component body**

Delete lines 43–45:
```tsx
  const { logout } = useAuth();
  const { openSettings } = useSettingsDialog();
  const [showChangePassword, setShowChangePassword] = useState(false);
```
Add after `export default function SidebarFooter({...}) {`:
```tsx
  const navigate = useNavigate();
```

Replace the settings button block (lines 115–129) with:
```tsx
      {/* 统一设置页入口（Provider / Operator Agent / 数据库 / 账号）。 */}
      <div className="px-2 pb-1.5 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate('/settings')}
          title="设置"
          aria-label="设置"
          className="w-full justify-start px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
        >
          <Settings2 />
          <span className="truncate">设置</span>
        </Button>
      </div>
```

Delete the entire `{!IS_PLATFORM() && (...)}` block (the change-password + logout buttons and the `<ChangePasswordDialog … />` line) — from the `{/* Change password + logout … */}` comment through its closing `)}`.

- [ ] **Step 3: Update SidebarAssistant deep links**

In `web/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx`, replace all three occurrences of `navigate('/settings/operator')` with `navigate('/settings?tab=operator')` (lines 440, 496, 502).

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git branch --show-current && git status --short
git add web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx web/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx
git commit -m "feat(settings): point sidebar entries at unified settings page"
```

- [ ] **Step 5: Typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex/web && npm run typecheck`

Expected: PASS (0 errors). Fix any unused-import errors in `SidebarFooter.tsx` (e.g. leftover `onShowSettings` prop is pre-existing and should stay).

---

### Task 8: Lint + full test run

**Files:** none (verification only)

- [ ] **Step 1: Run all settings tests**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/settings/settingsTabs.test.ts src/components/settings/DatabaseSettingsForm.test.tsx src/components/settings/SettingsPage.test.tsx
```

Expected: PASS (3 + 1 + 3 tests).

- [ ] **Step 2: Lint**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex/web && npm run lint`

Expected: PASS. If import-order / unused-import errors appear in touched files, run `npm run lint:fix -- src/components/settings src/components/sidebar/view/subcomponents/SidebarFooter.tsx src/components/sidebar/view/subcomponents/SidebarAssistant.tsx src/App.tsx` then re-run `npm run lint`.

- [ ] **Step 3: Build**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex/web && npm run build`

Expected: build completes (may warn about chunk size — pre-existing).

- [ ] **Step 4: Final commit (if lint:fix changed files)**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex && git status --short
# commit only if files changed
```

---

## Self-Review Notes

- Spec coverage: all four tabs (Provider reuse / Operator extraction / Database new / Account new), `/settings` route + redirects, sidebar entry points, and modal removal are each implemented by a task. Backend untouched.
- Type consistency: `SettingsTab` (`providers|operator|database|account`) is used identically in `settingsTabs.ts` and `SettingsPage.tsx`; `resolveSettingsTab` signature matches its test; `DatabaseSettingsForm` / `OperatorSettingsForm` / `AccountSettingsSection` / `ChangePasswordForm` export names match their imports.
- No placeholders: every step contains complete code or exact commands.
- Deviation from spec: `OperatorSettingsForm` lives in `web/src/components/settings/OperatorSettingsForm.tsx` (deleting the now-unused route wrapper `operators/OperatorSettingsPage.tsx`) instead of keeping the form inside the old page file — the route redirect makes the old wrapper dead code.
