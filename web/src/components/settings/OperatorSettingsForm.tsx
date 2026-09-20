import { useEffect, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

/**
 * Operator Agent 配置表单主体（无页面外框）。
 *
 * 后端 `GET/PUT /api/operator/settings` 读写 `app_config` 里的 operator 配置。
 * 不配置也能用（后端有安全默认）；这里开了能调自动化强度与模型/并发等。
 */

type VerdictMode = 'llm' | 'provider';

type OperatorConfig = {
  enabled: boolean;
  auto_verdict_enabled: boolean;
  verdict_mode: VerdictMode;
  model: string;
  max_concurrent: number;
  verdict_prompt_override: string | null;
  verdict_llm_prompt_override: string | null;
  interactive_chat_enabled: boolean;
  allow_skill_sync: boolean;
};

const EMPTY: OperatorConfig = {
  enabled: true,
  auto_verdict_enabled: true,
  verdict_mode: 'llm',
  model: '',
  max_concurrent: 2,
  verdict_prompt_override: null,
  verdict_llm_prompt_override: null,
  interactive_chat_enabled: true,
  allow_skill_sync: false,
};

/**
 * 单次调用模型。存在 app config 的 `oneshot` 命名空间里，**不在** operator_config
 * ——它们不是 operator 策略，只是两个一次性文本任务的模型选择。所以这个表单要同时
 * 读写两个接口（保存时两处一起写）。
 */
type OneshotModels = { titleModel: string; verdictModel: string };

const EMPTY_ONESHOT: OneshotModels = { titleModel: '', verdictModel: '' };

type AppConfigLike = {
  oneshot?: Partial<OneshotModels>;
  providers?: { claude?: { defaultModel?: string } };
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
          className={`inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}

export function OperatorSettingsForm() {
  const [config, setConfig] = useState<OperatorConfig>(EMPTY);
  const [oneshot, setOneshot] = useState<OneshotModels>(EMPTY_ONESHOT);
  const [defaultModel, setDefaultModel] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Two config slices: operator_config (this form's own endpoint) and the
    // app-config `oneshot` namespace (the model slots).
    Promise.all([api.operator.settings(), api.get('/config')])
      .then(async ([opRes, cfgRes]) => {
        if (!opRes.ok || !cfgRes.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const op = (await opRes.json()) as OperatorConfig;
        const cfg = (await cfgRes.json()) as AppConfigLike;
        if (cancelled) return;
        setConfig({ ...EMPTY, ...op });
        setOneshot({ ...EMPTY_ONESHOT, ...(cfg.oneshot ?? {}) });
        setDefaultModel(cfg.providers?.claude?.defaultModel ?? '');
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

  function patchOneshot(partial: Partial<OneshotModels>) {
    setOneshot((prev) => ({ ...prev, ...partial }));
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

      // Second slice. Report honestly if only this half fails rather than
      // claiming a clean save — the operator half is already persisted.
      const cfgRes = await api.put('/config', { oneshot });
      if (!cfgRes.ok) {
        setSaveError('Operator 设置已保存，但模型设置保存失败，请重试');
        return;
      }
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

  /** 把 `default` 这类槽位取值讲清楚：显示它当前解析成哪个模型。 */
  const slotHint = defaultModel
    ? `可填槽位名（default / haiku / sonnet / opus）或具体模型 id。当前 default 槽位 → ${defaultModel}`
    : '可填槽位名（default / haiku / sonnet / opus）或具体模型 id。';

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
        <Toggle
          label="允许助手同步技能"
          description="开启后助手可用 skill_sync_apply 把 skill 写到其他机器（默认关闭）。保存后需重启后端生效；预览差异（skill_sync_plan）始终可用。"
          checked={config.allow_skill_sync}
          onChange={(v) => patch({ allow_skill_sync: v })}
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
        <div className="mt-3">
          <label className="mb-1 block text-xs text-muted-foreground">判定通道</label>
          <select
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={config.verdict_mode}
            onChange={(e) => patch({ verdict_mode: e.target.value as VerdictMode })}
          >
            <option value="llm">LLM 单次判定（便宜，推荐）</option>
            <option value="provider">Operator 头跑会话（重量级，兜底）</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            LLM 通道调用失败（超时/返回不合 schema）时会自动回退到 Operator 头跑，不会漏判。
          </p>
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs text-muted-foreground">状态判断模型</label>
          <input
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={oneshot.verdictModel}
            placeholder="清空则用内置默认（default 槽位）"
            onChange={(e) => patchOneshot({ verdictModel: e.target.value })}
          />
          <p className="mt-1 text-xs text-muted-foreground">{slotHint}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            只在判定通道选「LLM 单次判定」时生效。回退到 Operator 头跑时，用的是下面「模型与运行环境」里的模型。
          </p>
        </div>
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
        <p className="mb-3 text-xs text-muted-foreground">
          两个通道各有一份覆盖，留空即用内置默认。<strong>只有当前选中的判定通道那份会生效。</strong>
        </p>

        <div className={config.verdict_mode === 'llm' ? '' : 'opacity-50'}>
          <label className="mb-1 block text-xs text-muted-foreground">
            LLM 通道判定标准
            {config.verdict_mode === 'llm' && <span className="ml-1 text-primary">（当前生效）</span>}
          </label>
          <textarea
            className="min-h-[120px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={config.verdict_llm_prompt_override ?? ''}
            placeholder="留空用默认判定标准"
            onChange={(e) => patch({ verdict_llm_prompt_override: e.target.value || null })}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            只替换「判定标准」这一段。最终输出、会话转录、以及「只输出 JSON」的格式要求始终会附上，
            所以自定义内容不会导致判定解析失败。
          </p>
        </div>

        <div className={`mt-4 ${config.verdict_mode === 'provider' ? '' : 'opacity-50'}`}>
          <label className="mb-1 block text-xs text-muted-foreground">
            Operator 头跑通道判定 Prompt
            {config.verdict_mode === 'provider' && <span className="ml-1 text-primary">（当前生效）</span>}
          </label>
          <textarea
            className="min-h-[120px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={config.verdict_prompt_override ?? ''}
            placeholder="留空用默认 prompt"
            onChange={(e) => patch({ verdict_prompt_override: e.target.value || null })}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            会完全替换发给 Operator Agent 的指令（原指令要求它调用 get_session_transcript /
            write_task_summary 工具）。
          </p>
        </div>
      </section>

      {/* 标题生成模型 —— 不归「自动判定」：它只在新建任务时用，和判定无关 */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">标题生成模型</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          新建任务时 title 为空，用 description 提炼任务名。取名失败会自动降级到需求首行，不会让建任务报错。
        </p>
        <input
          className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
          value={oneshot.titleModel}
          placeholder="清空则用内置默认（default 槽位）"
          onChange={(e) => patchOneshot({ titleModel: e.target.value })}
        />
        <p className="mt-1 text-xs text-muted-foreground">{slotHint}</p>
      </section>

      {/* 保存栏 */}
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {savedAt && !saveError && (
          <span className="text-xs text-success">已保存</span>
        )}
        {saveError && <span className="text-xs text-destructive">{saveError}</span>}
      </div>
    </div>
  );
}
