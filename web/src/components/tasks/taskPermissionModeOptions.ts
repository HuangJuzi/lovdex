import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { taskRunPermissionModesFor } from '../chat/utils/providerPermissionModes';
import { getPermissionModeLabelKeys } from '../chat/view/subcomponents/permissionModeLabels';

import type { ChipSelectOption } from './ChipSelect';

/**
 * 任务表单的权限模式选项：与 composer 的模式按钮**同源**——同一份 provider 列表、
 * 同一套 i18n 名称。任务页其余字段是中文，但模式名保持英文是刻意的：用户在 composer
 * 里看到的是 `Auto Approve`，在任务表单里必须看到同一串字才能建立对应关系。
 */
export function useTaskPermissionModeOptions(provider: string): ChipSelectOption[] {
  const { t } = useTranslation('chat');
  return useMemo(
    () =>
      taskRunPermissionModesFor(provider).map((mode) => ({
        value: mode,
        label: t(getPermissionModeLabelKeys(mode).fullKey),
      })),
    [provider, t],
  );
}

/**
 * 选中模式的后果说明（composer 同源的 `codex.descriptions.*`）。放在控件旁边的辅助行，
 * 因为 ChipSelect 的芯片只放得下模式名——`autoApprove` 那句「危险操作仍会拒绝」是必须
 * 让人看见的，不能因为换短名就丢掉。
 */
export function useTaskPermissionModeDescription(mode: string): string {
  const { t } = useTranslation('chat');
  return t(`codex.descriptions.${mode}`, { defaultValue: '' });
}
