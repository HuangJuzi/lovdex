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
