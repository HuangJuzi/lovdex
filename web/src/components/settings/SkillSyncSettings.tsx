import { useCallback, useEffect, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

/**
 * 「技能同步」设置区块：把 skill 从一个节点同步到另一个节点（本机 ↔ 远程主机，
 * 用户级 ~/.claude/skills 或项目级 <项目>/.claude/skills）。挂在 Operator Agent
 * 设置 Tab 下方，样式对齐相邻的 InboxSkillSettings。
 *
 * 流程两段式：先「预览差异」拿到 planId 与逐技能动作列表（create/update 才可
 * 勾选），再「同步选中」——planId 一次性、10 分钟过期，后端 apply 会复核两侧
 * 指纹，预览后被改动的条目会被拒绝而不是静默覆盖。
 */

type NodeOption = { label: string; name: string; online: boolean; reason?: string };

type ProjectOption = { projectId: string; displayName: string; remoteHostId: string | null };

type Entry = {
  name: string;
  action: 'create' | 'update' | 'same' | 'onlyTarget';
  fromHash?: string;
  toHash?: string;
  bytes?: number;
  description?: string;
  error?: string;
};

type Plan = {
  planId: string;
  entries: Entry[];
  summary: { create: number; update: number; same: number; onlyTarget: number };
};

type Result = {
  entries: { name: string; status: string; error?: string }[];
  summary: { ok: number; failed: number; conflict: number; skipped: number };
};

const ACTION_LABEL: Record<Entry['action'], string> = {
  create: '新增',
  update: '更新',
  same: '相同',
  onlyTarget: '目标多余',
};

/** Non-2xx bodies carry `{ error }` (express next(err)); surface that text. */
async function describeFailure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `请求失败（${res.status}）`;
}

export function SkillSyncSettings() {
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [from, setFrom] = useState('local');
  const [to, setTo] = useState('local');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [fromProjectId, setFromProjectId] = useState('');
  const [toProjectId, setToProjectId] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 节点列表（本机 + 已注册远程主机）与项目列表（项目级范围用）都只拉一次。
    // 项目接口在深链场景可能返回非 explicit 行，这里照设置页惯例不过滤。
    api
      .skills.nodes()
      .then(async (res) => {
        if (!res.ok) throw new Error(await describeFailure(res));
        const body = (await res.json()) as { nodes?: NodeOption[] };
        setNodes(body.nodes ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (scope !== 'project' || projects.length > 0) return;
    api
      .projects()
      .then(async (res) => {
        if (!res.ok) throw new Error(await describeFailure(res));
        const body = (await res.json()) as ProjectOption[];
        setProjects(
          (Array.isArray(body) ? body : []).map((p) => ({
            projectId: p.projectId,
            displayName: p.displayName,
            remoteHostId: p.remoteHostId ?? null,
          })),
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [scope, projects.length]);

  const preview = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body =
        scope === 'project'
          ? { from, to, scope, projectId: fromProjectId, targetProjectId: toProjectId }
          : { from, to, scope };
      const res = await api.skills.plan(body);
      if (!res.ok) throw new Error(await describeFailure(res));
      const next = (await res.json()) as Plan;
      setPlan(next);
      // 只有会真正传输的条目默认勾选
      setSelected(
        new Set(
          next.entries.filter((e) => e.action === 'create' || e.action === 'update').map((e) => e.name),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [from, to, scope, fromProjectId, toProjectId]);

  const run = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.skills.apply({ planId: plan.planId, names: [...selected] });
      if (!res.ok) throw new Error(await describeFailure(res));
      setResult((await res.json()) as Result);
      // planId 是一次性的：apply 之后预览必须失效，避免拿旧计划重放。
      setPlan(null);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [plan, selected]);

  const transferable = plan?.entries.filter((e) => e.action === 'create' || e.action === 'update') ?? [];
  const projectMissing = scope === 'project' && (!fromProjectId || !toProjectId);

  const nodeSelect = (value: string, onChange: (v: string) => void, ariaLabel: string) => (
    <select
      className="h-9 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {nodes.map((n) => (
        <option key={n.label} value={n.label} disabled={!n.online}>
          {n.name}
          {n.online ? '' : `（${n.reason ?? '离线'}）`}
        </option>
      ))}
    </select>
  );

  const projectSelect = (value: string, onChange: (v: string) => void, ariaLabel: string) => (
    <select
      className="h-9 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">选择项目…</option>
      {projects.map((p) => (
        <option key={p.projectId} value={p.projectId}>
          {p.displayName}
          {p.remoteHostId ? '（远程）' : ''}
        </option>
      ))}
    </select>
  );

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-1 text-sm font-semibold text-foreground">技能同步</h2>
      <p className="mb-2 text-xs text-muted-foreground">
        把 skill 从一个节点同步到另一个节点。以 .claude/skills 为主目录。
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          源
          {nodeSelect(from, setFrom, '源节点')}
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          目标
          {nodeSelect(to, setTo, '目标节点')}
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          范围
          <select
            className="h-9 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={scope}
            aria-label="同步范围"
            onChange={(e) => setScope(e.target.value as 'user' | 'project')}
          >
            <option value="user">用户级 ~/.claude/skills</option>
            <option value="project">项目级 &lt;项目&gt;/.claude/skills</option>
          </select>
        </label>
        {scope === 'project' && (
          <>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              源项目
              {projectSelect(fromProjectId, setFromProjectId, '源项目')}
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              目标项目
              {projectSelect(toProjectId, setToProjectId, '目标项目')}
            </label>
          </>
        )}
        <Button size="sm" onClick={() => void preview()} disabled={busy || from === to || projectMissing}>
          预览差异
        </Button>
      </div>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {plan && (
        <>
          <p className="mb-2 mt-3 text-xs text-muted-foreground">
            新增 {plan.summary.create} · 更新 {plan.summary.update} · 相同 {plan.summary.same} · 目标多余{' '}
            {plan.summary.onlyTarget}
          </p>
          {/* 桌面：表格。窄屏由响应式工具类切成卡片（保留桌面布局，见既有约定） */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="hidden md:table-header-group">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="w-8 py-1" aria-label="选择" />
                  <th className="py-1">技能</th>
                  <th className="py-1">动作</th>
                  <th className="py-1">源</th>
                  <th className="py-1">目标</th>
                  <th className="py-1">大小</th>
                </tr>
              </thead>
              <tbody>
                {plan.entries.map((e) => (
                  <tr
                    key={e.name}
                    className="mb-2 block rounded-md border border-border p-2 md:mb-0 md:table-row md:rounded-none md:border-0 md:p-0"
                  >
                    <td className="flex items-center md:table-cell md:p-1">
                      <input
                        type="checkbox"
                        aria-label={`同步 ${e.name}`}
                        disabled={e.action !== 'create' && e.action !== 'update'}
                        checked={selected.has(e.name)}
                        onChange={(ev) => {
                          const next = new Set(selected);
                          if (ev.target.checked) next.add(e.name);
                          else next.delete(e.name);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="md:table-cell md:p-1">
                      {e.name}
                      {e.description ? <small className="ml-1 text-muted-foreground"> {e.description}</small> : null}
                      {e.error ? <small className="ml-1 text-destructive">（{e.error}）</small> : null}
                    </td>
                    <td className="md:table-cell md:p-1">
                      <span className="text-xs text-muted-foreground md:hidden">动作 </span>
                      {ACTION_LABEL[e.action]}
                    </td>
                    <td className="md:table-cell md:p-1">
                      <span className="text-xs text-muted-foreground md:hidden">源 </span>
                      {e.fromHash?.slice(0, 8) ?? '—'}
                    </td>
                    <td className="md:table-cell md:p-1">
                      <span className="text-xs text-muted-foreground md:hidden">目标 </span>
                      {e.toHash?.slice(0, 8) ?? '—'}
                    </td>
                    <td className="md:table-cell md:p-1">
                      <span className="text-xs text-muted-foreground md:hidden">大小 </span>
                      {e.bytes != null ? `${e.bytes} B` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" onClick={() => void run()} disabled={busy || selected.size === 0}>
              同步选中的 {selected.size} 项
            </Button>
            {transferable.length === 0 && <span className="text-xs text-muted-foreground">两边已经完全一致。</span>}
          </div>
        </>
      )}

      {result && (
        <div className="mt-3 rounded-md border border-border p-2">
          <p className="text-xs text-muted-foreground">
            成功 {result.summary.ok} · 跳过 {result.summary.skipped} · 冲突 {result.summary.conflict} · 失败{' '}
            {result.summary.failed}
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-foreground">
            {result.entries
              .filter((e) => e.status !== 'skipped')
              .map((e) => (
                <li key={e.name}>
                  {e.name} — {e.status}
                  {e.error ? `：${e.error}` : ''}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default SkillSyncSettings;
