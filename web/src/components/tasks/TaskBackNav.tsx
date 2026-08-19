import { ArrowLeft, Home } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { cn } from '../../lib/utils';
import { Button } from '../../shared/view/ui';

/** 「← 返回任务面板」chunky 按钮。 */
export function BackToTasksButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="chunky"
      size="toolbar"
      className={cn('gap-1.5', className)}
      onClick={() => navigate('/tasks')}
      title="返回任务面板"
      aria-label="返回任务面板"
    >
      <ArrowLeft />
      {/* 移动端（<640px）只留返回图标 */}
      <span className="hidden sm:inline">返回任务面板</span>
    </Button>
  );
}

/** 「返回主页」chunky 按钮。 */
export function HomeButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="chunky"
      size="toolbar"
      className={cn('gap-1.5', className)}
      onClick={() => navigate('/')}
      title="返回主页"
      aria-label="返回主页"
    >
      <Home />
      {/* 移动端（<640px）只留返回图标 */}
      <span className="hidden sm:inline">返回主页</span>
    </Button>
  );
}

/** TaskDetail 头部右侧的两个返回按钮。 */
export function TaskBackNav({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <BackToTasksButton />
      <HomeButton className="hidden sm:inline-flex" />
    </div>
  );
}
