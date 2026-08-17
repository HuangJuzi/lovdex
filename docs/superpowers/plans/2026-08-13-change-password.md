# 修改密码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lovdex 登录门槛上增加「修改密码」能力（登录后改验证码，立即生效），并清理侧边栏底部的版本品牌行。

**Architecture:** 后端在 `auth.config.ts` 加 `updateAuthCode()`（原子写回 `auth.config.json` 并热更新内存 `authConfig.code`），新路由 `POST /api/auth/change-password` 套 `authenticateToken` 校验当前码后调用它；前端新增 `ChangePasswordDialog` 弹窗 + 侧边栏底部「修改密码」按钮，`api.auth.changePassword` 走既有 `authenticatedFetch`。

**Tech Stack:** Express + node:test + tsx（后端）；React + Tailwind + i18next（前端）。两个独立 git 仓库：`lovdex-backend`、`lovdex-cli`。

**Spec:** `docs/superpowers/specs/2026-08-13-change-password-design.md`

**注意（已完成的清理，勿重做）：** 侧边栏品牌行 "Lovdex v… – Open Source" 已删除，`currentVersion` 在 `SidebarFooter.tsx` / `SidebarContent.tsx` / `Sidebar.tsx` 的传参链已清理——改动已在工作区（uncommitted），由 Task 4 提交。

---

### Task 1: 后端 — `updateAuthCode` 热更新（auth.config.ts）

**Files:**
- Modify: `lovdex-backend/server/modules/auth/auth.config.ts`
- Test: `lovdex-backend/server/modules/auth/tests/auth.config.test.ts`

- [ ] **Step 1: 写失败的单元测试**

在 `auth.config.test.ts` 末尾追加。先把顶部 import 改为：

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { authConfig, isAuthEnabled, updateAuthCode } from '../auth.config.js';
```

（保持原有 `CONFIG_PATH` 与两个既有测试不动。）追加：

```ts
test('updateAuthCode persists a new code and hot-updates memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lovdex-auth-'));
  const configPath = join(dir, 'auth.config.json');
  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({ email: authConfig.email, code: authConfig.code, jwtSecret: authConfig.jwtSecret }, null, 2)}\n`,
      'utf8'
    );
    const original = authConfig.code;
    try {
      const ok = updateAuthCode('newcode123', configPath);
      assert.equal(ok, true);
      assert.equal(authConfig.code, 'newcode123');
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as {
        code: string;
        email: string;
        jwtSecret: string;
      };
      assert.equal(persisted.code, 'newcode123');
      assert.equal(persisted.email, authConfig.email);
      assert.equal(persisted.jwtSecret, authConfig.jwtSecret);
    } finally {
      authConfig.code = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateAuthCode returns false and leaves memory unchanged on write failure', () => {
  const original = authConfig.code;
  try {
    const ok = updateAuthCode('whatever123', '/nonexistent/lovdex-auth-test/auth.config.json');
    assert.equal(ok, false);
    assert.equal(authConfig.code, original);
  } finally {
    authConfig.code = original;
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（在 `lovdex-backend` 目录）：
```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/auth/tests/auth.config.test.ts
```
Expected: FAIL（`updateAuthCode` 未导出，模块加载报错）。

- [ ] **Step 3: 实现 `updateAuthCode`**

在 `auth.config.ts` 的 `isAuthEnabled` 之后追加：

```ts
export const MIN_CODE_LENGTH = 4;
export const MAX_CODE_LENGTH = 64;

/**
 * Persists a new verification code to the config file (atomic tmp + rename) and
 * hot-updates the in-memory value so the change applies immediately. Returns
 * false (and leaves memory untouched) if the write fails. `configPath` is a
 * test seam — production always targets the real CONFIG_PATH.
 */
export function updateAuthCode(newCode: string, configPath: string = CONFIG_PATH): boolean {
  let existing: AuthCredentials;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AuthCredentials>;
    existing = {
      email: typeof parsed.email === 'string' && parsed.email ? parsed.email : authConfig.email,
      code: typeof parsed.code === 'string' && parsed.code ? parsed.code : authConfig.code,
      jwtSecret:
        typeof parsed.jwtSecret === 'string' && parsed.jwtSecret
          ? parsed.jwtSecret
          : authConfig.jwtSecret,
    };
  } catch {
    existing = { email: authConfig.email, code: authConfig.code, jwtSecret: authConfig.jwtSecret };
  }
  const next = { ...existing, code: newCode };
  const tmpPath = `${configPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    console.warn(
      `[auth] Failed to persist new code to ${configPath}:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
  authConfig.code = newCode;
  console.log(`[auth] Verification code updated (persisted to ${configPath})`);
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run 同上。Expected: PASS（3 个 test：2 个既有 + 2 个新，共 4 个）。

- [ ] **Step 5: Commit**

```bash
git add server/modules/auth/auth.config.ts server/modules/auth/tests/auth.config.test.ts
git commit -m "feat(auth): hot-update verification code in auth.config.json"
```

---

### Task 2: 后端 — `POST /api/auth/change-password` 路由

**Files:**
- Modify: `lovdex-backend/server/modules/auth/auth.routes.ts`
- Test: `lovdex-backend/server/modules/auth/tests/auth.routes.test.ts`

- [ ] **Step 1: 写失败的路由测试**

在 `auth.routes.test.ts` 顶部 import 追加（保留既有 import 与 `withServer`）：

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { authConfig, updateAuthCode } from '../auth.config.js';
```

（`signToken` 已 import。）文件底部追加：

```ts
const CONFIG_PATH = fileURLToPath(new URL('../auth.config.json', import.meta.url));

async function changePassword(base: string, opts: { token?: string; body: unknown }) {
  const { token, body } = opts;
  return fetch(`${base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('change-password updates the code when the current code matches', async () => {
  const original = authConfig.code;
  try {
    await withServer(async (base) => {
      const token = signToken({ sub: 1, username: authConfig.email });
      const res = await changePassword(base, { token, body: { currentCode: original, newCode: 'newcode123' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(authConfig.code, 'newcode123');
      const persisted = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { code: string };
      assert.equal(persisted.code, 'newcode123');
    });
  } finally {
    updateAuthCode(original);
  }
});

test('change-password rejects a wrong current code', async () => {
  await withServer(async (base) => {
    const token = signToken({ sub: 1, username: authConfig.email });
    const res = await changePassword(base, { token, body: { currentCode: '000000', newCode: 'whatever123' } });
    assert.equal(res.status, 401);
  });
});

test('change-password rejects a too-short new code', async () => {
  await withServer(async (base) => {
    const token = signToken({ sub: 1, username: authConfig.email });
    const res = await changePassword(base, { token, body: { currentCode: authConfig.code, newCode: 'ab' } });
    assert.equal(res.status, 400);
  });
});

test('change-password requires a valid token', async () => {
  await withServer(async (base) => {
    const res = await changePassword(base, { body: { currentCode: 'x', newCode: 'yyyy' } });
    assert.equal(res.status, 401);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（在 `lovdex-backend` 目录）：
```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/auth/tests/auth.routes.test.ts
```
Expected: FAIL（`/change-password` 返回 404，`updateAuthCode`/`MIN_CODE_LENGTH` 相关断言失败或模块加载报错）。

- [ ] **Step 3: 实现路由**

`auth.routes.ts` 顶部 import 追加：

```ts
import { authenticateToken } from '../../middleware/auth.js';
import {
  authConfig,
  isAuthEnabled,
  MAX_CODE_LENGTH,
  MIN_CODE_LENGTH,
  updateAuthCode,
} from './auth.config.js';
```

在 `router.get('/me', ...)` 之后追加：

```ts
// Authenticated password change: verifies the current code, then persists the
// new one to auth.config.json and hot-updates memory (takes effect immediately).
router.post('/change-password', authenticateToken, (req, res) => {
  if (!isAuthEnabled()) {
    // Open / platform mode has no password gate — nothing to change.
    return res.status(404).json({ error: 'Not found' });
  }
  const { currentCode, newCode } = (req.body ?? {}) as {
    currentCode?: unknown;
    newCode?: unknown;
  };
  const current = typeof currentCode === 'string' ? currentCode.trim() : '';
  const next = typeof newCode === 'string' ? newCode.trim() : '';
  if (!current || current !== authConfig.code) {
    return res.status(401).json({ error: '当前验证码不正确' });
  }
  if (next.length < MIN_CODE_LENGTH || next.length > MAX_CODE_LENGTH) {
    return res.status(400).json({ error: '新验证码长度需在 4-64 位之间' });
  }
  if (!updateAuthCode(next)) {
    return res.status(500).json({ error: '修改失败，请检查服务端配置文件权限' });
  }
  res.json({ ok: true });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run 同上。Expected: PASS（既有 6 个 + 新 4 个 = 10 个）。

- [ ] **Step 5: Commit**

```bash
git add server/modules/auth/auth.routes.ts server/modules/auth/tests/auth.routes.test.ts
git commit -m "feat(auth): add POST /api/auth/change-password"
```

---

### Task 3: 后端 — 全量质量门

**Files:** 无（仅验证）

- [ ] **Step 1: 全量测试**

Run（在 `lovdex-backend` 目录）：
```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/auth/tests/*.test.ts
```
Expected: 全部 PASS（23 + 6 = 29 个左右，最终以实际为准）。

- [ ] **Step 2: typecheck + lint**

```bash
npm run typecheck
npm run lint
```
Expected: typecheck 无报错；lint 0 errors（允许既有 warnings）。若有新 error 就地修复后重跑。

- [ ] **Step 3: 确认 auth.config.json 未被测试改动**

```bash
cat server/modules/auth/auth.config.json
```
Expected: `"code": "888888"`（测试已恢复原码）。若被改动，执行 `git checkout -- server/modules/auth/auth.config.json` 恢复。

---

### Task 4: 前端 — 提交已完成的品牌行清理

**Files:**
- Modify（已在工作区）: `lovdex-cli/src/components/sidebar/view/Sidebar.tsx`
- Modify（已在工作区）: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- Modify（已在工作区）: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`

- [ ] **Step 1: 确认改动符合预期**

`SidebarFooter.tsx` 中应已无 "Lovdex v" 品牌行、无 `currentVersion`；`SidebarContent.tsx` 与 `Sidebar.tsx` 中无 `currentVersion={currentVersion}` 传给 footer。若与预期不符，先修正再继续。

- [ ] **Step 2: Commit**

```bash
git add src/components/sidebar/view/Sidebar.tsx src/components/sidebar/view/subcomponents/SidebarContent.tsx src/components/sidebar/view/subcomponents/SidebarFooter.tsx
git commit -m "chore: remove version brand line from sidebar footer"
```

---

### Task 5: 前端 — `api.auth.changePassword` + i18n 文案

**Files:**
- Modify: `lovdex-cli/src/utils/api.js`
- Modify: `lovdex-cli/src/i18n/locales/en/auth.json`

- [ ] **Step 1: 加 API 方法**

`api.js` 中 `auth` 对象（`login` / `me` 之后）追加：

```js
  auth: {
    login: (email, code) =>
      fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      }),
    me: () => authenticatedFetch('/api/auth/me'),
    changePassword: (currentCode, newCode) =>
      authenticatedFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentCode, newCode }),
      }),
  },
```

- [ ] **Step 2: 加 i18n 文案**

将 `auth.json` 整体替换为：

```json
{
  "login": {
    "title": "Welcome Back",
    "description": "Sign in with your email and password",
    "email": "Email",
    "code": "Password",
    "submit": "Sign In",
    "loading": "Signing in...",
    "errors": {
      "invalidCredentials": "Invalid email or password",
      "requiredFields": "Please fill in all fields",
      "networkError": "Network error. Please try again."
    },
    "placeholders": {
      "email": "you@example.com",
      "code": "Enter your password"
    }
  },
  "logout": {
    "title": "Sign Out",
    "confirm": "Are you sure you want to sign out?",
    "button": "Sign Out"
  },
  "changePassword": {
    "title": "Change Password",
    "description": "Update the password used to sign in.",
    "button": "Change Password",
    "current": "Current Password",
    "new": "New Password",
    "confirm": "Confirm New Password",
    "submit": "Update Password",
    "loading": "Updating...",
    "cancel": "Cancel",
    "success": "Password updated",
    "errors": {
      "requiredFields": "Please fill in all fields",
      "mismatch": "New passwords do not match",
      "tooShort": "New password must be at least 4 characters",
      "wrongCurrent": "Current password is incorrect",
      "invalidNew": "New password is invalid",
      "networkError": "Network error. Please try again.",
      "generic": "Something went wrong. Please try again."
    },
    "placeholders": {
      "current": "Enter current password",
      "new": "Enter new password",
      "confirm": "Repeat new password"
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/api.js src/i18n/locales/en/auth.json
git commit -m "feat(auth): add changePassword API and i18n keys"
```

---

### Task 6: 前端 — `ChangePasswordDialog` 组件

**Files:**
- Create: `lovdex-cli/src/components/auth/ChangePasswordDialog.tsx`

- [ ] **Step 1: 创建组件**

```tsx
// src/components/auth/ChangePasswordDialog.tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';

type ChangePasswordDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export default function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { t } = useTranslation('auth');
  const [currentCode, setCurrentCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Clear the form whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setCurrentCode('');
      setNewCode('');
      setConfirmCode('');
      setError(null);
      setSuccess(false);
      setSubmitting(false);
    }
  }, [open]);

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
        setSubmitting(false);
        // Brief success feedback, then close (the effect clears the form).
        setTimeout(() => onOpenChange(false), 800);
      } else {
        setError(
          res.status === 401
            ? t('changePassword.errors.wrongCurrent')
            : res.status === 400
              ? t('changePassword.errors.invalidNew')
              : t('changePassword.errors.generic')
        );
        setSubmitting(false);
      }
    } catch (err) {
      setError(
        err instanceof TypeError
          ? t('changePassword.errors.networkError')
          : t('changePassword.errors.generic')
      );
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-md">
        <DialogTitle>{t('changePassword.title')}</DialogTitle>
        <div className="p-6">
          <h3 className="mb-1 flex items-center gap-2 text-lg font-semibold text-foreground">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            {t('changePassword.title')}
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">{t('changePassword.description')}</p>
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
                autoFocus
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
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                {t('changePassword.cancel')}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? t('changePassword.loading') : t('changePassword.submit')}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 验证 typecheck**

Run（在 `lovdex-cli` 目录）：
```bash
npm run typecheck
```
Expected: 无报错。

---

### Task 7: 前端 — 侧边栏底部「修改密码」按钮

**Files:**
- Modify: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`

- [ ] **Step 1: 改 import**

`SidebarFooter.tsx` 顶部 import 改为：

```tsx
import { useState } from 'react';
import { ArrowUpCircle, Bug, AlertTriangle, KeyRound, LogOut } from 'lucide-react';
import type { TFunction } from 'i18next';
import { IS_PLATFORM } from '../../../../constants/config';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import { useAuth } from '../../../auth/AuthGate';
import ChangePasswordDialog from '../../../auth/ChangePasswordDialog';
```

- [ ] **Step 2: 组件内加 state**

```tsx
export default function SidebarFooter({ ... }: SidebarFooterProps) {
  const { logout } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);
```

- [ ] **Step 3: 登出区块上方加按钮 + 渲染弹窗**

把现有登出区块：

```tsx
      {/* Logout (OSS mode only — the login gate is backend-enforced). */}
      {!IS_PLATFORM && (
        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={logout}
            title={t('auth:logout.button')}
            aria-label={t('auth:logout.button')}
            className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>{t('auth:logout.button')}</span>
          </button>
        </div>
      )}
```

替换为：

```tsx
      {/* Change password + logout (OSS mode only — the login gate is backend-enforced). */}
      {!IS_PLATFORM && (
        <>
          <div className="px-2 pb-1">
            <button
              type="button"
              onClick={() => setShowChangePassword(true)}
              title={t('auth:changePassword.button')}
              aria-label={t('auth:changePassword.button')}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>{t('auth:changePassword.button')}</span>
            </button>
          </div>
          <div className="px-2 pb-2">
            <button
              type="button"
              onClick={logout}
              title={t('auth:logout.button')}
              aria-label={t('auth:logout.button')}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>{t('auth:logout.button')}</span>
            </button>
          </div>
          <ChangePasswordDialog open={showChangePassword} onOpenChange={setShowChangePassword} />
        </>
      )}
```

- [ ] **Step 4: 验证 typecheck + lint**

Run（在 `lovdex-cli` 目录）：
```bash
npm run typecheck
npm run lint
```
Expected: typecheck 无报错；lint 0 errors（既有 warnings 允许）。

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/ChangePasswordDialog.tsx src/components/sidebar/view/subcomponents/SidebarFooter.tsx
git commit -m "feat(auth): add change-password dialog and sidebar entry"
```

（`ChangePasswordDialog.tsx` 在 Task 6 创建，若 Task 6 未单独提交则一并加入此 commit；两个文件一起提交即可。）

---

### Task 8: 前端 — 全量质量门

**Files:** 无（仅验证）

- [ ] **Step 1: build + typecheck + lint**

Run（在 `lovdex-cli` 目录）：
```bash
npm run build
npm run typecheck
npm run lint
```
Expected: build 成功（"✓ built in …"）；typecheck 无报错；lint 0 errors。若有新 error 就地修复后重跑，并在需要时补充提交。

---

## Self-Review

**Spec 覆盖核对：**
- 4.1 `updateAuthCode` 原子写 + 热更新 → Task 1 ✅
- 4.2 `POST /change-password`（鉴权/当前码/格式/写失败 401/400/500）→ Task 2 ✅（含 `!isAuthEnabled()` 时 404 保护）
- 5.1 `api.auth.changePassword` → Task 5 ✅
- 5.2 `ChangePasswordDialog` 三框 + 校验 → Task 6 ✅
- 5.3 侧边栏按钮 → Task 7 ✅
- 5.4 i18n → Task 5 ✅
- 5.5 登出保留 + 品牌行删除 → Task 4（已应用）+ Task 7 ✅
- 8 测试：config 单测 + 路由测试（改密成功/当前码错/新码过短/未登录）→ Task 1/2 ✅
- 5.5 的 `currentVersion` 传参链清理 → Task 4 ✅

**占位符扫描：** 无 TBD/TODO；所有代码步骤含完整代码。

**类型一致性：** `updateAuthCode(newCode, configPath = CONFIG_PATH)` 在 Task 1 定义、Task 2 以单参调用、测试以双参调用——一致；`MIN_CODE_LENGTH`/`MAX_CODE_LENGTH` 在 Task 1 导出、Task 2 使用——一致；`api.auth.changePassword(currentCode, newCode)` 在 Task 5 定义、Task 6 调用——一致；i18n key 命名 `changePassword.*` 在 Task 5 定义、Task 6/7 使用——一致。
