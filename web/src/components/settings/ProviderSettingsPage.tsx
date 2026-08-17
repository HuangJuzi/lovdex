import { useEffect, useState, type ReactNode } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';
import { BackToTasksButton } from '../tasks/TaskBackNav';

/**
 * Provider 凭据 + 运行参数设置页。
 *
 * 后端 `GET /api/config`（匿名、密钥打码）读、`PUT /api/config`（需登录）写。
 * GET 回来的密钥是打码占位（`••••abcd`）；PUT 时后端 `stripMaskedPlaceholders`
 * 会丢弃任何以 `••••` 开头的字段，因此这里可以把整个 draft 原样 PUT，打码字段
 * 自动保留真实值 —— 前端无需特殊处理，只发 draft。
 *
 * 保存后后端会 re-sync process.env（Task 9），新起的 session 立即用上新凭据；
 * 但端口 / host / 数据库路径需重启后端才生效。
 */

const MASK_PREFIX = '••••';

// ---- config shape (partial; we only touch what the page edits) ----
type ProvidersConfig = {
  claude?: { cliPath?: string; apiKey?: string; authToken?: string; oneMillionModels?: string };
  codex?: { binPath?: string; apiKey?: string };
  opencode?: { binPath?: string };
  qoder?: { personalAccessToken?: string };
};
type ServerConfig = { port?: number; host?: string; corsOrigin?: string };
type AppConfig = {
  providers?: ProvidersConfig;
  server?: ServerConfig;
  [k: string]: unknown;
};

type ProviderKey = 'claude' | 'codex' | 'opencode' | 'qoder';

type AuthStatusData = {
  installed?: boolean;
  authenticated?: boolean;
  email?: string | null;
  method?: string | null;
  error?: string | null;
};

/** 单个 provider 的实时认证状态行；自带 useEffect 拉取。 */
function AuthStatus({ provider }: { provider: ProviderKey }) {
  const [status, setStatus] = useState<AuthStatusData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/providers/${provider}/auth/status`)
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const json = await res.json();
        // envelope: { data: { installed, authenticated, ... } } 或裸对象
        const data = (json?.data ?? json) as AuthStatusData;
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (failed) {
    return <span className="text-xs text-muted-foreground">认证状态未知</span>;
  }
  if (!status) {
    return <span className="text-xs text-muted-foreground">检测中…</span>;
  }
  if (status.authenticated) {
    const detail = status.method || status.email;
    return (
      <span className="text-xs text-green-600 dark:text-green-400">
        已认证{detail ? `（${detail}）` : ''}
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-600 dark:text-amber-400">
      {status.error ?? '未认证'}
    </span>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <input
        className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  const isMasked = value.startsWith(MASK_PREFIX);
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type={show ? 'text' : 'password'}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
          value={value}
          placeholder={isMasked ? '已配置（留空不变）' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="h-9 flex-shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted"
        >
          {show ? '隐藏' : '显示'}
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  provider,
  children,
}: {
  title: string;
  provider?: ProviderKey;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {provider && <AuthStatus provider={provider} />}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function ProviderSettingsPage() {
  const [draft, setDraft] = useState<AppConfig | null>(null);
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
        const cfg = (await res.json()) as AppConfig;
        if (!cancelled) setDraft(cfg);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Patch a nested provider field, cloning along the way so state stays immutable.
  function patchProvider(provider: ProviderKey, field: string, value: string) {
    setSavedMsg(null);
    setDraft((prev) => {
      if (!prev) return prev;
      const providers = { ...(prev.providers ?? {}) };
      providers[provider] = { ...(providers[provider] ?? {}), [field]: value };
      return { ...prev, providers };
    });
  }

  function patchServer(field: keyof ServerConfig, value: string | number) {
    setSavedMsg(null);
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, server: { ...(prev.server ?? {}), [field]: value } };
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    try {
      // Send the whole draft as-is: the backend strips `••••`-prefixed masked
      // values so real secrets are preserved. No client-side masking handling.
      const res = await api.put('/config', draft);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error?.message ?? err?.error ?? `保存失败（${res.status}）`);
        return;
      }
      const cfg = (await res.json()) as AppConfig;
      setDraft(cfg);
      setSavedMsg('已保存。端口 / 数据库路径 / host 修改需重启后端生效。');
    } catch (err) {
      setSaveError((err as Error).message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <div className="text-sm text-muted-foreground">加载配置失败</div>
        <Button size="sm" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }

  const claude = draft?.providers?.claude ?? {};
  const codex = draft?.providers?.codex ?? {};
  const opencode = draft?.providers?.opencode ?? {};
  const qoder = draft?.providers?.qoder ?? {};
  const server = draft?.server ?? {};

  return (
    <div className="h-dvh overflow-y-auto bg-background">
      <header className="pwa-header-safe sticky top-0 z-10 flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <BackToTasksButton />
        <h1 className="ml-2 text-sm font-semibold text-foreground">Provider 设置</h1>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-6 sm:p-6">
        {!draft ? (
          <div className="text-sm text-muted-foreground">加载中…</div>
        ) : (
          <div className="flex flex-col gap-6">
            <p className="text-xs text-muted-foreground">
              密钥以打码形式显示（<code>••••</code> 开头）；留空或保持打码占位则不改动真实值。
              保存后新起的会话立即生效。
            </p>

            <Section title="Claude" provider="claude">
              <TextField
                label="CLI 路径 (cliPath)"
                value={claude.cliPath ?? ''}
                placeholder="claude"
                onChange={(v) => patchProvider('claude', 'cliPath', v)}
              />
              <SecretField
                label="API Key (apiKey)"
                value={claude.apiKey ?? ''}
                onChange={(v) => patchProvider('claude', 'apiKey', v)}
              />
              <SecretField
                label="Auth Token (authToken)"
                value={claude.authToken ?? ''}
                onChange={(v) => patchProvider('claude', 'authToken', v)}
              />
              <TextField
                label="百万上下文模型 (oneMillionModels)"
                value={claude.oneMillionModels ?? ''}
                placeholder="逗号分隔的模型名，留空关闭"
                onChange={(v) => patchProvider('claude', 'oneMillionModels', v)}
              />
            </Section>

            <Section title="Codex" provider="codex">
              <TextField
                label="可执行路径 (binPath)"
                value={codex.binPath ?? ''}
                placeholder="codex"
                onChange={(v) => patchProvider('codex', 'binPath', v)}
              />
              <SecretField
                label="API Key (apiKey)"
                value={codex.apiKey ?? ''}
                onChange={(v) => patchProvider('codex', 'apiKey', v)}
              />
            </Section>

            <Section title="OpenCode" provider="opencode">
              <TextField
                label="可执行路径 (binPath)"
                value={opencode.binPath ?? ''}
                placeholder="opencode"
                onChange={(v) => patchProvider('opencode', 'binPath', v)}
              />
            </Section>

            <Section title="Qoder" provider="qoder">
              <SecretField
                label="Personal Access Token (personalAccessToken)"
                value={qoder.personalAccessToken ?? ''}
                onChange={(v) => patchProvider('qoder', 'personalAccessToken', v)}
              />
            </Section>

            <Section title="运行参数">
              <p className="-mt-1 text-xs text-muted-foreground">
                端口 / host 修改需重启后端才生效。
              </p>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">端口 (server.port)</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                  value={server.port ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    patchServer('port', Number.isFinite(n) ? n : 0);
                  }}
                />
              </div>
              <TextField
                label="Host (server.host)"
                value={server.host ?? ''}
                placeholder="0.0.0.0"
                onChange={(v) => patchServer('host', v)}
              />
              <TextField
                label="CORS Origin (server.corsOrigin)"
                value={server.corsOrigin ?? ''}
                placeholder="*"
                onChange={(v) => patchServer('corsOrigin', v)}
              />
            </Section>

            {/* 保存栏 */}
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
        )}
      </div>
    </div>
  );
}

export default ProviderSettingsPage;
