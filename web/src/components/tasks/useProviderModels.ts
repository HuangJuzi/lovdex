import { useEffect, useRef, useState } from 'react';

import type { ProviderModelOption, TaskEngine } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';

import type { ChipSelectOption } from './ChipSelect';

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: { models?: { OPTIONS?: ProviderModelOption[]; DEFAULT?: string } };
};

/**
 * 引擎模型列表拉取（含 stale-response 守卫），供定时任务表单与新建任务弹窗共用。
 *
 * `active === false` 时**不发请求**（弹窗关着就没必要拉）。引擎或 active 变化都会
 * 重新拉取；旧请求的结果若晚于新请求返回会被丢弃——没有这道守卫时，快速切换引擎
 * 会让先发的慢响应覆盖后发的快响应，芯片里显示的是上一个引擎的模型。
 *
 * 只负责「拉取」，**不管选中值**：两个调用方的选中策略不同（新建任务弹窗每次打开
 * 都重置到第一项，定时任务编辑老数据时要保持 NULL），把策略塞进来就需要一个回调
 * 参数，反而更绕。选中策略见 `nextModelOnLoad`，由调用方自己调。
 *
 * **调用方契约**：`loadedEngine` 是 `models` 的「适用引擎」，不是「当前引擎」。引擎
 * 切换后、新响应落地前，`models` 仍是**上一个引擎**的列表、`loadedEngine` 仍是上一个
 * 引擎名（不会清回 null）。所以消费 `models` 前必须先比对 `loadedEngine === engine`，
 * 否则会拿旧引擎的模型列表去渲染或设选中值，而且错得很安静。
 * 拉取失败时同样会把 `loadedEngine` 标成当前引擎，配合空列表兜底项使用。
 */
export function useProviderModels(
  engine: TaskEngine,
  active: boolean,
): { models: ProviderModelOption[]; loadedEngine: TaskEngine | null } {
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [loadedEngine, setLoadedEngine] = useState<TaskEngine | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    // 每次 effect run 都作废在途请求——**放在早退之前**，否则弹窗关闭时在途的
    // 那次响应仍持有有效 id，会在重新打开时先于新响应把旧列表写进 state。
    // 同 useTaskEngineAvailability。
    const requestId = ++requestRef.current;
    if (!active) return;
    authenticatedFetch(`/api/providers/${engine}/models`)
      .then(async (res) => {
        if (!res.ok) return [] as ProviderModelOption[];
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .catch((err) => {
        // 只给日志加守卫，**不要** early return：下面那个 .then 还要把 loadedEngine
        // 标上，失败路径也必须走到那里（否则调用方永远停在「加载中」）。
        if (requestRef.current === requestId) console.error(`load models for ${engine} failed`, err);
        return [] as ProviderModelOption[];
      })
      .then((list) => {
        if (requestRef.current !== requestId) return;
        setModels(list);
        // 失败也标记成「该引擎已加载」：否则调用方会永远停在「加载中」，
        // 而空列表本来就有「默认模型」兜底项可用。
        setLoadedEngine(engine);
      });
  }, [active, engine]);

  return { models, loadedEngine };
}

/**
 * 模型 chip 的选项。
 *
 * 「默认模型」（空串 = 跟随 provider 默认槽位）**常驻第一项**：它是合法选择，也是
 * 编辑老任务（`executor_model` 为 NULL）时唯一能表达当前值的项——少了它，ChipSelect
 * 的 `current?.label ?? label` 会退化成裸的「模型」二字。同 TaskDetail 的
 * `<option value="">默认模型 (default)</option>`。
 *
 * 列表为空（还没加载 / 拉取失败）时只给这一项；当前值不在列表里时，在它之后、列表
 * 之前插一项带标注的同值项，否则芯片会显示空白、用户随手一保存就把模型静默改成 NULL。
 */
export function modelOptionsFor(models: ProviderModelOption[], current: string): ChipSelectOption[] {
  const fallback: ChipSelectOption = { value: '', label: '默认模型' };
  // 列表为空时即便 current 非空也只给兜底项：没有「列表」可言，标「不在当前引擎列表」没有意义。
  if (models.length === 0) return [fallback];
  const mapped: ChipSelectOption[] = models.map((m) => ({ value: m.value, label: m.label || m.value }));
  const stale: ChipSelectOption[] =
    current && !mapped.some((o) => o.value === current)
      ? [{ value: current, label: `${current}（不在当前引擎列表）` }]
      : [];
  return [fallback, ...stale, ...mapped];
}

/**
 * 模型列表加载完成后该选中哪一项。
 *
 * 新建：总是第一项（与 CreateTaskDialog 一致，用户看到的就是实际会跑的模型）。
 * 编辑：保持库里的值——`''` 代表 NULL，即「跟随 provider 默认槽位」，一打开编辑就
 * 回填第一项会让「只是看一眼再保存」把老定时任务悄悄钉死到某个模型。
 * 但引擎被切过之后例外：旧模型不属于新引擎，只能取新引擎的第一项。
 */
export function nextModelOnLoad({
  mode,
  engineSwitched,
  models,
  current,
}: {
  mode: 'create' | 'edit';
  engineSwitched: boolean;
  models: ProviderModelOption[];
  current: string;
}): string {
  if (mode === 'edit' && !engineSwitched) return current;
  return models[0]?.value ?? '';
}
