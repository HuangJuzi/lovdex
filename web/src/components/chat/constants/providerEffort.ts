import type { LLMProvider, ProviderModelOption } from '../../../types/app';

export const DEFAULT_EFFORT_VALUE = 'default';

export const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  qoder: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  // dsh's own vocabulary — NOT the same set as its siblings. The backend dsh
  // catalog carries the same four values; this list only covers the window
  // before that catalog arrives.
  dsh: ['off', 'low', 'high', 'max'],
};

export const toProviderEffortOptions = (
  values: readonly string[],
): NonNullable<ProviderModelOption['effort']>['values'] => values.map((value) => ({ value }));
