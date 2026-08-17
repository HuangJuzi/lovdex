import { promises as fs } from 'node:fs';

import { getOperatorConfig } from '@/modules/operators/operator.config.js';

/**
 * 解析 operator 工作区（Lovdex助手 的工作目录）的 canonical real path，
 * 未配置或目录不存在时返回 null。复用 main-agent-workspace 的判定思路，
 * 但读 operator 配置，使「Lovdex助手」工作区在项目列表、websocket 事件里被一致识别。
 */
export async function resolveOperatorWorkspaceRoot(): Promise<string | null> {
  const workspace = getOperatorConfig().workspace;
  if (!workspace) {
    return null;
  }
  try {
    return await fs.realpath(workspace);
  } catch {
    return null;
  }
}

/** 当 `projectPath` 解析到 Lovdex助手（operator）工作区时返回 true。 */
export async function isOperatorWorkspacePath(projectPath: string): Promise<boolean> {
  if (!projectPath) {
    return false;
  }
  const root = await resolveOperatorWorkspaceRoot();
  if (!root) {
    return false;
  }
  try {
    return (await fs.realpath(projectPath)) === root;
  } catch {
    return false;
  }
}
