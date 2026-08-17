import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ClipboardList, MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../lib/utils';

type View = 'chat' | 'tasks';

/**
 * Top-level mode switch between the chat/session workspace ("/") and the task
 * board ("/tasks"). Rendered in both the sidebar header and the task board
 * header so the two views toggle symmetrically, mirroring the sidebar's
 * project FilterToggle segmented-control styling.
 */
export function ViewSwitcher({ active, className }: { active: View; className?: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation('sidebar');

  const items: {
    value: View;
    label: string;
    icon: LucideIcon;
    to: string;
    /** 激活态实色胶囊（方案 C 全彩）。 */
    activeClass: string;
    /** 未激活时图标的品牌色。 */
    iconClass: string;
  }[] = [
    {
      value: 'chat',
      label: t('navigation.chat'),
      icon: MessageSquare,
      to: '/',
      activeClass: 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]',
      iconClass: 'text-sky-500',
    },
    {
      value: 'tasks',
      label: t('navigation.tasks'),
      icon: ClipboardList,
      to: '/tasks',
      activeClass: 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]',
      iconClass: 'text-emerald-500',
    },
  ];

  return (
    <div className={cn('flex rounded-xl border border-border/70 bg-muted/50 p-0.5', className)}>
      {items.map(({ value, label, icon: Icon, to, activeClass, iconClass }) => {
        const isActive = active === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isActive}
            onClick={() => {
              if (!isActive) navigate(to);
            }}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-normal transition-all',
              isActive ? activeClass : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('h-3 w-3 flex-shrink-0', isActive ? 'text-primary' : iconClass)} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
