import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { permissionModesFor } from '../chat/utils/providerPermissionModes';
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
      permissionModesFor(provider).map((mode) => ({
        value: mode,
        label: t(getPermissionModeLabelKeys(mode).fullKey),
      })),
    [provider, t],
  );
}

/**
 * 选中模式的后果说明。
 *
 * 刻意**不走 i18n bundle**：`codex.descriptions.*` 只有英文，而这几个表单的其余文案
 * 全是中文。模式名保持英文是有意的（用户要在 composer 和任务表单之间对上同一串字），
 * 但那只是标识符；解释是给人读的散文，该用中文。
 *
 * `autoApprove` 那条是必须看见的——它说明「不问你就动手」的边界在哪。
 */
const TASK_PERMISSION_MODE_DESCRIPTIONS: Record<string, string> = {
  default: '只自动放行可信命令（ls、cat、grep、git status 等），其余会跳过。可写工作区。',
  auto: '由模型分类器逐个工具判断批不批。不用你管，但比 Bypass 稳——仍会拒绝。',
  autoApprove:
    '无人值守时替你回答权限询问。工具调用自动放行，但危险命令（sudo、git push、rm -rf /、把下载管道进 shell 等）和需要人回答的提问会被拒绝。用于定时任务。',
  acceptEdits: '工作区内所有命令自动执行，带沙箱。',
  bypassPermissions: '完全放开，无任何限制，可全盘与网络访问。谨慎使用。',
  plan: '只做规划、不执行命令。无人值守时会停在等你批准计划（任务会标成 waiting_plan）。',
};

export function useTaskPermissionModeDescription(mode: string): string {
  return TASK_PERMISSION_MODE_DESCRIPTIONS[mode] ?? '';
}
