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
 */
export function useProviderModels(
  engine: TaskEngine,
  active: boolean,
): { models: ProviderModelOption[]; loadedEngine: TaskEngine | null } {
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [loadedEngine, setLoadedEngine] = useState<TaskEngine | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    authenticatedFetch(`/api/providers/${engine}/models`)
      .then(async (res) => {
        if (!res.ok) return [] as ProviderModelOption[];
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .catch((err) => {
        console.error(`load models for ${engine} failed`, err);
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
 * 模型 chip 的选项。空列表兜底成一项「默认模型」（值为空串 = 不指定，跑 provider
 * 默认槽位）；当前值不在列表里时**前置**一项带标注的同值项——没有这一条，芯片会
 * 显示空白，用户随手一保存就把模型静默改成 NULL。
 */
export function modelOptionsFor(models: ProviderModelOption[], current: string): ChipSelectOption[] {
  if (models.length === 0) return [{ value: '', label: '默认模型' }];
  const mapped: ChipSelectOption[] = models.map((m) => ({ value: m.value, label: m.label || m.value }));
  if (!current || mapped.some((o) => o.value === current)) return mapped;
  return [{ value: current, label: `${current}（不在当前引擎列表）` }, ...mapped];
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
