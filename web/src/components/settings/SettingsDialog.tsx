import { X } from 'lucide-react';

import { Dialog, DialogContent } from '../../shared/view/ui/Dialog';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';

import { ProviderSettingsForm } from './ProviderSettingsPage';

/**
 * Provider 设置模态浮层。挂在 App 根部，覆盖所有页面；复用 shared/view/ui/Dialog
 * 原语（Escape / 遮罩点击关闭、focus trap、body 滚动锁定），内部渲染与
 * /settings/providers 路由页同一份 <ProviderSettingsForm />。
 */
export function SettingsDialog() {
  const { open, closeSettings } = useSettingsDialog();
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeSettings(); }}>
      <DialogContent className="max-w-3xl">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
          <h2 className="text-sm font-semibold text-foreground">Provider 设置</h2>
          <button
            type="button"
            onClick={closeSettings}
            title="关闭"
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[80dvh] overflow-y-auto p-4">
          <ProviderSettingsForm />
        </div>
      </DialogContent>
    </Dialog>
  );
}
