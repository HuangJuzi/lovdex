import { useEffect, useState, type ReactNode } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

import { ProviderProfileSelector } from './ProviderProfileSelector';
import {
  FORM_FIELDS,
  buildConfigPutBody,
  findNewProfileId,
  isProfileModified,
  profileFormEntries,
  readSelections,
  withProfileBuckets,
  type ProviderKey,
  type ProfileBuckets,
} from './providerProfiles';

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

const MASK_PREFIX = '••••';

// ---- config shape (partial; we only touch what the page edits) ----
type ProvidersConfig = {
  claude?: {
    cliPath?: string;
    apiKey?: string;
    authToken?: string;
    baseUrl?: string;
    defaultModel?: string;
    haikuModel?: string;
    opusModel?: string;
    sonnetModel?: string;
    oneMillionModels?: string;
  };
  codex?: { binPath?: string; apiKey?: string };
  opencode?: { binPath?: string };
  qoder?: { personalAccessToken?: string };
};
type ServerConfig = { port?: number; host?: string; corsOrigin?: string };
type LlmProxyConfig = { enabled?: boolean; anthropicUrl?: string };
type AppConfig = {
  providers?: ProvidersConfig;
  server?: ServerConfig;
  llmProxy?: LlmProxyConfig;
  providerProfiles?: ProfileBuckets;
  activeProviderProfiles?: Record<string, string>;
  [k: string]: unknown;
};

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
      <span className="text-xs text-success">
        已认证{detail ? `（${detail}）` : ''}
      </span>
    );
  }
  return (
    <span className="text-xs text-warning">
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
  revealable = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** 非 revealable 时始终明文显示掩码（如 first6****last6），不带显示/隐藏切换。 */
  revealable?: boolean;
}) {
  const [show, setShow] = useState(false);
  const isMasked = value.startsWith(MASK_PREFIX) || value.includes('****');
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type={revealable && !show ? 'password' : 'text'}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
          value={value}
          placeholder={isMasked ? '已配置（留空不变）' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {revealable && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="h-9 flex-shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted"
          >
            {show ? '隐藏' : '显示'}
          </button>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  provider,
  headerExtra,
  children,
}: {
  title: string;
  provider?: ProviderKey;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {provider && <AuthStatus provider={provider} />}
      </div>
      {headerExtra && <div className="mb-3">{headerExtra}</div>}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** 设置表单主体：路由页与模态共用（draft 加载 / 保存 / 渲染）。 */
export function ProviderSettingsForm() {
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<ProviderKey, string>>({
    claude: '', codex: '', opencode: '', qoder: '',
  });

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
        if (!cancelled) {
          setDraft(cfg);
          setSelections(readSelections(cfg));
        }
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

  /** 选档：只填表单，不写盘（保存时才生效）。 */
  function selectProfile(provider: ProviderKey, id: string) {
    setSavedMsg(null);
    setSelections((prev) => ({ ...prev, [provider]: id }));
    if (!id || !draft) return;
    const profile = draft.providerProfiles?.[provider]?.[id];
    if (!profile) return;
    // 复用 patchProvider：它已经是这份文件里唯一经过类型检查的"改一个表单字段"写法。
    for (const [field, value] of profileFormEntries(profile, FORM_FIELDS[provider])) {
      patchProvider(provider, field, value);
    }
  }

  /** 存为新档：先把表单落盘（含档选择），再从生效字段快照 —— 存下来的就是屏幕上看到的。 */
  async function createProfile(provider: ProviderKey) {
    if (!draft) return;
    const raw = window.prompt('配置档名称');
    if (raw === null) return;
    const name = raw.trim();
    if (!name) {
      setSaveError('配置档名称不能为空');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    try {
      const beforeIds = Object.keys(draft.providerProfiles?.[provider] ?? {});
      const putRes = await api.put('/config', buildConfigPutBody(draft, selections));
      if (!putRes.ok) {
        setSaveError(`保存失败（${putRes.status}）`);
        return;
      }
      const postRes = await api.post('/config/provider-profiles', { provider, name });
      if (!postRes.ok) {
        const err = await postRes.json().catch(() => null);
        setSaveError(err?.error?.message ?? err?.error ?? `新建配置档失败（${postRes.status}）`);
        return;
      }
      const cfg = (await postRes.json()) as AppConfig;
      const newId = findNewProfileId(beforeIds, Object.keys(cfg.providerProfiles?.[provider] ?? {}));
      setDraft((prev) => (prev ? withProfileBuckets(prev, cfg) : cfg));
      setSelections((prev) => ({ ...prev, [provider]: newId || prev[provider] }));
      setSavedMsg(`已存为配置档「${name}」`);
    } catch (err) {
      setSaveError((err as Error).message ?? '新建配置档失败');
    } finally {
      setSaving(false);
    }
  }

  async function renameProfile(provider: ProviderKey) {
    if (!draft) return;
    const id = selections[provider];
    const current = draft.providerProfiles?.[provider]?.[id]?.name ?? '';
    const raw = window.prompt('新的配置档名称', current);
    if (raw === null) return;
    const name = raw.trim();
    if (!name || name === current) return;
    setSaveError(null);
    try {
      // 这次 PUT 不带 activeProviderProfiles，所以档标记不变；name 不是密钥，
      // deepMerge 直接改掉。注意它和任何 PUT 一样会触发一次 llm-proxy reconcile。
      const res = await api.put('/config', { providerProfiles: { [provider]: { [id]: { name } } } });
      if (!res.ok) {
        setSaveError(`重命名失败（${res.status}）`);
        return;
      }
      const cfg = (await res.json()) as AppConfig;
      setDraft((prev) => (prev ? withProfileBuckets(prev, cfg) : cfg));
      setSavedMsg(`已重命名为「${name}」`);
    } catch (err) {
      setSaveError((err as Error).message ?? '重命名失败');
    }
  }

  async function deleteProfile(provider: ProviderKey) {
    if (!draft) return;
    const id = selections[provider];
    const name = draft.providerProfiles?.[provider]?.[id]?.name ?? '';
    if (!window.confirm(`删除配置档「${name}」？（不会改变当前生效的配置）`)) return;
    setSaveError(null);
    try {
      const res = await api.delete(
        `/config/provider-profiles/${provider}/${encodeURIComponent(id)}`,
      );
      if (!res.ok) {
        setSaveError(`删除失败（${res.status}）`);
        return;
      }
      const cfg = (await res.json()) as AppConfig;
      // 只换配置档两个键 → 表单里未保存的编辑与生效字段都原样保留。
      setDraft((prev) => (prev ? withProfileBuckets(prev, cfg) : cfg));
      setSelections((prev) => (prev[provider] === id ? { ...prev, [provider]: '' } : prev));
      setSavedMsg(`已删除配置档「${name}」`);
    } catch (err) {
      setSaveError((err as Error).message ?? '删除失败');
    }
  }

  function selectorFor(provider: ProviderKey) {
    const profiles = draft?.providerProfiles?.[provider] ?? {};
    const id = selections[provider];
    const modified = id
      ? isProfileModified(
          (draft?.providers?.[provider] ?? {}) as Record<string, unknown>,
          profiles[id] ?? { name: '', values: {} },
          FORM_FIELDS[provider],
        )
      : false;
    return (
      <ProviderProfileSelector
        profiles={profiles}
        selectedId={id}
        modified={modified}
        disabled={saving}
        onSelect={(next) => selectProfile(provider, next)}
        onCreate={() => void createProfile(provider)}
        onRename={() => void renameProfile(provider)}
        onDelete={() => void deleteProfile(provider)}
      />
    );
  }

  function setLlmProxyEnabled(value: boolean) {
    setSavedMsg(null);
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, llmProxy: { ...(prev.llmProxy ?? {}), enabled: value } };
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
      const res = await api.put('/config', buildConfigPutBody(draft, selections));
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error?.message ?? err?.error ?? `保存失败（${res.status}）`);
        return;
      }
      const cfg = (await res.json()) as AppConfig;
      setDraft(cfg);
      setSavedMsg('已保存。模型 / Base URL / 凭据对新会话立即生效；端口 / 数据库路径 / host 修改需重启后端生效。');
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
  if (!draft) {
    return <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  const claude = draft?.providers?.claude ?? {};
  const codex = draft?.providers?.codex ?? {};
  const opencode = draft?.providers?.opencode ?? {};
  const qoder = draft?.providers?.qoder ?? {};
  const server = draft?.server ?? {};
  const llmProxy = draft?.llmProxy ?? {};

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-muted-foreground">
        API Key 只显示首尾各 6 位（<code>开头6位****结尾6位</code>），不支持显示完整值；保持占位即不改动。
        Base URL / 凭据 / 模型保存后对新会话立即生效；某字段留空并保存 = 清除该配置。
      </p>

      <Section
        title="Claude"
        provider="claude"
        headerExtra={selectorFor('claude')}
      >
        <SecretField
          label="API Key (apiKey)"
          value={claude.apiKey ?? ''}
          onChange={(v) => patchProvider('claude', 'apiKey', v)}
          revealable={false}
        />
        <TextField
          label="Base URL (baseUrl)"
          value={claude.baseUrl ?? ''}
          placeholder="https://www.sophnet.com/api/open-apis/anthropic"
          onChange={(v) => patchProvider('claude', 'baseUrl', v)}
        />
        <TextField
          label="默认模型 (defaultModel)"
          value={claude.defaultModel ?? ''}
          placeholder="DeepSeek-V4-Flash-0731"
          onChange={(v) => patchProvider('claude', 'defaultModel', v)}
        />
        <TextField
          label="Opus 模型 (opusModel)"
          value={claude.opusModel ?? ''}
          placeholder="DeepSeek-V4-Pro-0813"
          onChange={(v) => patchProvider('claude', 'opusModel', v)}
        />
        <TextField
          label="Sonnet 模型 (sonnetModel)"
          value={claude.sonnetModel ?? ''}
          placeholder="claude-opus-4-8"
          onChange={(v) => patchProvider('claude', 'sonnetModel', v)}
        />
        <TextField
          label="Haiku 模型 (haikuModel)"
          value={claude.haikuModel ?? ''}
          placeholder="DeepSeek-V4-Flash-0731"
          onChange={(v) => patchProvider('claude', 'haikuModel', v)}
        />
        <TextField
          label="百万上下文模型 (oneMillionModels)"
          value={claude.oneMillionModels ?? ''}
          placeholder="逗号分隔的模型名，留空关闭"
          onChange={(v) => patchProvider('claude', 'oneMillionModels', v)}
        />
        {llmProxy.enabled === true && (llmProxy.anthropicUrl ?? '').trim() !== '' && (
          <p className="text-xs text-warning">
            本地代理已显式指定上游（llmProxy.anthropicUrl），它不再跟随这里的 Base URL
            —— 切换配置档只影响直连路径，代理仍打老上游。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          配置档由服务端保管密钥；切换后点保存生效，只影响新会话（运行中的会话沿用启动时的凭据）。
        </p>
      </Section>

      <Section
        title="Codex"
        provider="codex"
        headerExtra={selectorFor('codex')}
      >
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
          revealable={false}
        />
        <p className="text-xs text-muted-foreground">
          配置档由服务端保管密钥；切换后点保存生效，只影响新会话（运行中的会话沿用启动时的凭据）。
        </p>
      </Section>

      <Section
        title="OpenCode"
        provider="opencode"
        headerExtra={selectorFor('opencode')}
      >
        <TextField
          label="可执行路径 (binPath)"
          value={opencode.binPath ?? ''}
          placeholder="opencode"
          onChange={(v) => patchProvider('opencode', 'binPath', v)}
        />
        <p className="text-xs text-muted-foreground">
          配置档由服务端保管密钥；切换后点保存生效，只影响新会话（运行中的会话沿用启动时的凭据）。
        </p>
      </Section>

      <Section
        title="Qoder"
        provider="qoder"
        headerExtra={selectorFor('qoder')}
      >
        <SecretField
          label="Personal Access Token (personalAccessToken)"
          value={qoder.personalAccessToken ?? ''}
          onChange={(v) => patchProvider('qoder', 'personalAccessToken', v)}
        />
        <p className="text-xs text-muted-foreground">
          配置档由服务端保管密钥；切换后点保存生效，只影响新会话（运行中的会话沿用启动时的凭据）。
        </p>
      </Section>

      <Section title="LLM Proxy（报错修复 + 远程转发）">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 accent-foreground"
            checked={llmProxy.enabled === true}
            onChange={(e) => setLlmProxyEnabled(e.target.checked)}
          />
          启用本地代理
        </label>
        <p className="text-xs text-muted-foreground">
          开启后，claude 请求经本机 Go 代理转发到上游，自动修复 SSE / thinking 等偶发报错；
          远程 lite 会话也走本机转发，远程设备无需联网。开关保存后对新会话生效，代理进程随开关自动启停。
        </p>
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
          <span className="text-xs text-success">{savedMsg}</span>
        )}
        {saveError && <span className="text-xs text-destructive">{saveError}</span>}
      </div>
    </div>
  );
}
