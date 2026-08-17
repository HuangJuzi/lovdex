import { useNavigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

/**
 * 「定时任务」侧边栏整行入口，置于 Lovdex助手 与项目列表之间。
 * 点击跳转任务页的「⏰ 定时」视图（/tasks?view=scheduled）。样式对齐 Lovdex助手 行。
 */
export default function SidebarScheduledEntry() {
  const navigate = useNavigate();
  return (
    <div className="flex-shrink-0 px-2 pt-1.5 md:px-1.5">
      <Button
        variant="ghost"
        className={cn('flex w-full justify-between p-2 h-auto font-normal hover:bg-muted', 'bg-primary/5')}
        onClick={() => navigate('/tasks?view=scheduled')}
        title="定时任务"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <CalendarClock className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">定时任务</span>
        </div>
      </Button>
    </div>
  );
}
