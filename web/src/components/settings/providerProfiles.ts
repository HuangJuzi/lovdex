/**
 * 配置档的前端纯逻辑。
 *
 * 单独成模块是为了可测：仓库的 web 测试走 renderToStaticMarkup SSR（不跑
 * effect、无 DOM），只有纯函数测得到。
 *
 * 设计见 docs/superpowers/specs/2026-10-10-provider-profiles-design.md。
 */

/**
 * 设置页**有配置档 UI** 的 provider。
 *
 * 注意这个集合比后端的 `PROFILE_FIELDS` **窄**：后端还带 `dsh`（它今天在设置页
 * 没有凭据区块，是刻意不做）。所以 API 建出来的 `dsh` 档在前端是看不见的、其
 * `activeProviderProfiles.dsh` 标记也没法从这里清。**给后端 PROFILE_FIELDS 加
 * provider 时，如果同时要给它 UI，必须一并加宽这个联合类型** —— 否则是静默失能。
 */
export type ProviderKey = 'claude' | 'codex' | 'opencode' | 'qoder';

export type ProviderProfile = { name: string; values: Record<string, unknown> };
export type ProfileBuckets = Record<string, Record<string, ProviderProfile>>;

/**
 * 设置页每个 provider 表单**真实渲染**的字段 —— 决定"选档时往表单填哪些值"和
 * "表单是不是被改过了"的比对范围。
 * opencode 只渲染 binPath（它的 apiKeys 没有 UI，由服务端在保存时整份应用）。
 * 与后端 provider-profiles.ts 的 PROFILE_FIELDS 是两个同心圆：那边是"档里存
 * 什么"，这边是"表单看得见什么"。**这里必须是表单字段的全集且 ⊆ 后端的
 * PROFILE_FIELDS** —— 漏一个的症状是：改了那个字段「保存到该档」不亮（比对范围
 * 不含它），而且它也不会被存进档里。加表单字段时两个白名单一起改。
 */
export const FORM_FIELDS: Record<ProviderKey, readonly string[]> = {
  claude: ['apiKey', 'baseUrl', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel', 'oneMillionModels'],
  codex: ['binPath', 'apiKey'],
  opencode: ['binPath'],
  qoder: ['personalAccessToken'],
};

/**
 * "无档"标记。**必须是空串不是 null**：后端 deepMerge 的 `override ?? base` 会把
 * null 当成"未提供"从而保留旧标记，清不掉。
 */
export const NO_PROFILE = '';

/** 某个 provider 当前选中的档 id（缺省 = 自定义）。 */
export function selectionFor(active: Record<string, string> | undefined, provider: ProviderKey): string {
  return active?.[provider] || NO_PROFILE;
}

/** 从 GET 回来的配置里读出四个 provider 的档选择。 */
export function readSelections(cfg: Record<string, unknown>): Record<ProviderKey, string> {
  const active = (cfg.activeProviderProfiles ?? {}) as Record<string, string>;
  return {
    claude: selectionFor(active, 'claude'),
    codex: selectionFor(active, 'codex'),
    opencode: selectionFor(active, 'opencode'),
    qoder: selectionFor(active, 'qoder'),
  };
}

/** 选档时要填进表单的 (字段, 值) 对：只含表单渲染的字段、且档里是字符串的。 */
export function profileFormEntries(
  profile: ProviderProfile,
  fields: readonly string[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const field of fields) {
    const value = profile.values[field];
    if (typeof value === 'string') out.push([field, value]);
  }
  return out;
}

/**
 * 表单值与档是否还有差别（决定标不标「已修改」）。
 * 打码串也能比：打码由真值决定，值同则码同。
 */
export function isProfileModified(
  providerValues: Record<string, unknown>,
  profile: ProviderProfile,
  fields: readonly string[],
): boolean {
  return fields.some(
    (field) =>
      field in providerValues && String(providerValues[field] ?? '') !== String(profile.values[field] ?? ''),
  );
}

/** 组装 PUT body：整份 draft + 每个 provider 的档选择。 */
export function buildConfigPutBody(
  draft: Record<string, unknown>,
  selections: Record<ProviderKey, string>,
): Record<string, unknown> {
  const active: Record<string, string> = {};
  for (const [provider, id] of Object.entries(selections)) active[provider] = id || NO_PROFILE;
  return { ...draft, activeProviderProfiles: active };
}

/** 只换配置档相关的两个键，保留表单里未保存的编辑。 */
export function withProfileBuckets<T extends Record<string, unknown>>(
  draft: T,
  cfg: Record<string, unknown>,
): T {
  return {
    ...draft,
    providerProfiles: (cfg.providerProfiles ?? {}) as ProfileBuckets,
    activeProviderProfiles: (cfg.activeProviderProfiles ?? {}) as Record<string, string>,
  };
}

/** POST 之后找出服务端刚生成的那个档 id（响应里从未出现过的那个）。 */
export function findNewProfileId(before: readonly string[], after: readonly string[]): string {
  return after.find((id) => !before.includes(id)) ?? '';
}
