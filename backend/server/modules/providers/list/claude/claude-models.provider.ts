import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

// Mirror the Claude Code CLI `/model` picker. The CLI lists:
//   1. Default (recommended) — "Use the default model (currently <ANTHROPIC_MODEL>)"
//   2..4. One "Custom <alias> model" entry per ANTHROPIC_DEFAULT_*_MODEL, labelled
//        with the real model id the alias resolves to.
//   5. A trailing "Custom model" entry for ANTHROPIC_MODEL itself.
// When an env var is unset (stock Anthropic env, no proxy), the entry falls
// back to the alias name so the option stays selectable.
const resolveEnvModel = (varName: string): string | null => {
  const value = process.env[varName];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const envDefault = resolveEnvModel('ANTHROPIC_MODEL');
const envOpus = resolveEnvModel('ANTHROPIC_DEFAULT_OPUS_MODEL');
const envSonnet = resolveEnvModel('ANTHROPIC_DEFAULT_SONNET_MODEL');
const envHaiku = resolveEnvModel('ANTHROPIC_DEFAULT_HAIKU_MODEL');

// The CLI shows a `[1m]` suffix for 1M-context models, but that metadata is
// detected internally by claude — neither the env vars nor the proxy's
// /v1/models endpoint expose it. Let the operator declare which model ids
// carry a 1M context via LOVDEX_CLAUDE_1M_MODELS (comma-separated); matching
// options get a `[1m]` tag in their label / description.
const env1mModels = new Set(
  (process.env.LOVDEX_CLAUDE_1M_MODELS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

const tag1m = (real: string | null): string =>
  real && env1mModels.has(real) ? ' [1m]' : '';

const claudeOptions: ProviderModelOption[] = [
  {
    value: 'default',
    label: 'Default (recommended)',
    description: envDefault
      ? `Use the default model (currently ${envDefault}${tag1m(envDefault)})`
      : 'Use the Claude Code default model',
    effort: {
      default: 'high',
      values: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
        { value: 'max' },
      ],
    },
  },
  {
    value: 'opus',
    label: `${envOpus ?? 'Opus'}${tag1m(envOpus)}`,
    description: envOpus ? 'Custom Opus model' : 'Opus (env 未配置)',
    effort: {
      default: 'high',
      values: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
        { value: 'xhigh' },
        { value: 'max' },
      ],
    },
  },
  {
    value: 'sonnet',
    label: `${envSonnet ?? 'Sonnet'}${tag1m(envSonnet)}`,
    description: envSonnet ? 'Custom Sonnet model' : 'Sonnet (env 未配置)',
    effort: {
      default: 'high',
      values: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
        { value: 'max' },
      ],
    },
  },
  {
    value: 'haiku',
    label: `${envHaiku ?? 'Haiku'}${tag1m(envHaiku)}`,
    description: envHaiku ? 'Custom Haiku model' : 'Haiku (env 未配置)',
  },
];

// Trailing "Custom model" entry for ANTHROPIC_MODEL (mirrors CLI item 5).
if (envDefault) {
  claudeOptions.push({
    value: envDefault,
    label: `${envDefault}${tag1m(envDefault)}`,
    description: 'Custom model',
    effort: {
      default: 'high',
      values: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
        { value: 'max' },
      ],
    },
  });
}

export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: claudeOptions,
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    return CLAUDE_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const sessionRow = sessionsDb.getSessionById(sessionId);
      const jsonlPath = sessionRow?.jsonl_path;
      // Transcript events carry the provider/CLI session id (provider_session_id),
      // not the app session id. extractClaudeEventModel skips events whose
      // sessionId doesn't match, so matching on the wrong id made this lookup
      // always miss and report the default model instead of the active one.
      const transcriptSessionId = sessionRow?.provider_session_id?.trim() || sessionId;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(transcriptSessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
