import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { cn } from '../../lib/utils';
import { IS_PLATFORM } from '../../constants/config';
import { BackToTasksButton } from '../tasks/TaskBackNav';

import { ProviderSettingsForm } from './ProviderSettingsPage';
import { OperatorSettingsForm } from './OperatorSettingsForm';
import { OperatorSkillExecSettings } from './OperatorSkillExecSettings';
import { DatabaseSettingsForm } from './DatabaseSettingsForm';
import { AccountSettingsSection } from './AccountSettingsSection';
import { SETTINGS_TABS, resolveSettingsTab, type SettingsTab } from './settingsTabs';

/**
 * 统一设置页：左侧 Tab 导航（Provider / Operator Agent / 数据库 / 账号），
 * 右侧渲染对应表单。Tab 由 ?tab= 查询参数驱动，默认 providers；非法值回退。
 * platform 模式下隐藏「账号」Tab（无本地密码/登出）。
 */
export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const visibleTabs = useMemo(
    () => (IS_PLATFORM() ? SETTINGS_TABS.filter((tab) => tab.key !== 'account') : SETTINGS_TABS),
    [],
  );

  const requested = resolveSettingsTab(searchParams.get('tab'));
  const activeTab: SettingsTab = visibleTabs.some((tab) => tab.key === requested)
    ? requested
    : 'providers';

  function selectTab(key: SettingsTab) {
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <BackToTasksButton />
        <h1 className="ml-2 text-sm font-semibold text-foreground">设置</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 桌面左侧 Tab 导航 */}
        <nav className="hidden w-52 flex-shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 p-3 md:flex">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => selectTab(tab.key)}
              className={cn(
                'rounded-md px-3 py-2 text-left text-sm transition-colors',
                activeTab === tab.key
                  ? 'bg-primary/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 移动端顶部横排 Tab */}
          <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 md:hidden">
            {visibleTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => selectTab(tab.key)}
                className={cn(
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
                  activeTab === tab.key
                    ? 'bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-4 py-6 sm:p-6">
              {activeTab === 'providers' && <ProviderSettingsForm />}
              {activeTab === 'operator' && (
                <>
                  <OperatorSettingsForm />
                  <OperatorSkillExecSettings />
                </>
              )}
              {activeTab === 'database' && <DatabaseSettingsForm />}
              {activeTab === 'account' && <AccountSettingsSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
