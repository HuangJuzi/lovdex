import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useTasks } from '../../hooks/useTasks';
import useLocalStorage from '../../hooks/useLocalStorage';
import { Button } from '../../shared/view/ui';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';

import { HomeButton } from './TaskBackNav';
import { projectPathOf, taskFormProjects, toProjectOption } from './projectOptions';
import { ScheduledTasksPanel, type ScheduledTasksPanelHandle } from './ScheduledTasksPanel';
import type { ScheduledTab } from './ScheduledTabBar';

/**
 * 定时任务独立页（/scheduled）。原本作为任务页的第三个视图（viewMode='scheduled'）
 * 嵌在 TaskBoard 里，现拆成独立路由：侧边栏「定时任务」入口与任务详情页的「⏰ 定时」
 * 徽标都跳到这里，任务页本身不再渲染任何定时内容。
 */
export function ScheduledTasksPage() {
  const { subscribe } = useWebSocket();
  // 运行记录来源：定时任务跑出来的任务就混在全量任务列表里，按 source_schedule_id
  // 过滤（见 ScheduledRunHistoryView.runsOf）。这里和 TaskBoard 一样拉全量。
  const { tasks, remove } = useTasks({}, subscribe);
  const [projects, setProjects] = useState<Project[]>([]);
  // 子标签（调度 / 运行记录）沿用旧的 localStorage key：从任务页拆过来后老用户已存的
  // 取值继续有效。URL 上的 `?tab=runs` 优先，见下面的挂载 effect。
  const [scheduledTab, setScheduledTab] = useLocalStorage<ScheduledTab>('scheduledViewTab', 'schedules');

  // `?tab=runs` 优先于 localStorage，但仅在挂载时读一次（与 TaskBoard 旧逻辑一致）。
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('tab') === 'runs') setScheduledTab('runs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 项目下拉的去重规则与 TaskBoard / CreateTaskDialog 一致：名字撞了才补路径。
  const duplicateProjectNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of taskFormProjects(projects)) {
      const name = project.displayName || projectPathOf(project);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );
  }, [projects]);

  const projectOptions = useMemo(
    () => taskFormProjects(projects).map((project) => toProjectOption(project, duplicateProjectNames)),
    [projects, duplicateProjectNames],
  );

  useEffect(() => {
    let cancelled = false;
    api.projects()
      .then(async (res) => {
        if (!res.ok) {
          console.error('load projects for scheduled page failed', res.status);
          return [];
        }
        const data = (await res.json()) as Project[];
        return Array.isArray(data) ? data : [];
      })
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
      })
      .catch((err) => console.error('load projects for scheduled page failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const panelRef = useRef<ScheduledTasksPanelHandle>(null);

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <HomeButton />
        <span className="text-sm font-semibold text-foreground">定时任务</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="toolbar" variant="chunkyPrimary" onClick={() => panelRef.current?.openNew()} title="新建定时任务" aria-label="新建定时任务">
            <Plus />
            {/* 移动端（<640px）只留 + 号 */}
            <span className="hidden sm:inline">新建定时任务</span>
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <ScheduledTasksPanel
          ref={panelRef}
          projectOptions={projectOptions}
          tasks={tasks}
          tab={scheduledTab}
          onTabChange={setScheduledTab}
          onRunsDeleted={(ids) => ids.forEach(remove)}
        />
      </div>
    </div>
  );
}
