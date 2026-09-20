import { parseSkillNode } from '../skill-sync/skill-node.js';
import type { SkillSyncService } from '../skill-sync/skill-sync.service.js';
import type { SkillScope, SyncPlan } from '../skill-sync/types.js';

export type SkillSyncOperatorDeps = {
  service: Pick<SkillSyncService, 'plan' | 'apply'>;
  /** Operator config gate — writes are opt-in. */
  allowApply: boolean;
};

function requireScope(raw: unknown): SkillScope {
  if (raw !== 'user' && raw !== 'project') throw new Error('scope must be "user" or "project"');
  return raw;
}

function renderPlan(plan: SyncPlan): string {
  const { create, update, same, onlyTarget } = plan.summary;
  const head = `planId=${plan.planId} 新增 ${create} · 更新 ${update} · 相同 ${same} · 目标多余 ${onlyTarget}`;
  const rows = plan.entries
    .filter((e) => e.action !== 'same')
    .map((e) => `- ${e.name} [${e.action}]`);
  return [head, ...rows].join('\n');
}

export function createSkillSyncOperatorTools(deps: SkillSyncOperatorDeps) {
  return {
    /** Read-only: produces a preview and a planId. Writes nothing, audits nothing. */
    async skill_sync_plan(input: {
      from: string;
      to: string;
      scope: string;
      projectId?: number;
      targetProjectId?: number;
    }) {
      const plan = await deps.service.plan({
        from: parseSkillNode(input.from),
        to: parseSkillNode(input.to),
        scope: requireScope(input.scope),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.targetProjectId !== undefined ? { targetProjectId: input.targetProjectId } : {}),
      });
      return renderPlan(plan);
    },

    async skill_sync_apply(input: { planId: string; names?: string[]; force?: boolean }) {
      if (!deps.allowApply) {
        return '技能同步的写操作未开启。请在 设置 → Operator Agent 设置 里打开「允许助手同步技能」后重试。';
      }
      const result = await deps.service.apply({
        planId: input.planId,
        ...(input.names !== undefined ? { names: input.names } : {}),
        force: input.force === true,
        actor: 'operator',
      });
      const { ok, skipped, conflict, failed } = result.summary;
      const lines = [`成功 ${ok} · 跳过 ${skipped} · 冲突 ${conflict} · 失败 ${failed}`];
      for (const e of result.entries) {
        if (e.status === 'ok' || e.status === 'skipped') continue;
        lines.push(`- ${e.name} [${e.status}]${e.error ? `：${e.error}` : ''}`);
      }
      return lines.join('\n');
    },
  };
}
