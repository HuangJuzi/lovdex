import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Initialize the shared i18n instance (chat namespace) before the component
// under test calls useTranslation.
import '../../../../i18n/config.js';

import type { LLMProvider } from '../../../../types/app';

import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';

const ALL_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder'];

const installed = (
  available: LLMProvider[],
): Record<LLMProvider, boolean> =>
  ALL_PROVIDERS.reduce<Record<LLMProvider, boolean>>(
    (acc, p) => ({ ...acc, [p]: available.includes(p) }),
    {} as Record<LLMProvider, boolean>,
  );

const noop = () => {};

function renderPicker(installedProviders: Record<LLMProvider, boolean> | null) {
  return renderToStaticMarkup(
    <ProviderSelectionEmptyState
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={noop}
      textareaRef={{ current: null }}
      claudeModel="claude-default"
      setClaudeModel={noop}
      codexModel="codex-default"
      setCodexModel={noop}
      opencodeModel="opencode-default"
      setOpenCodeModel={noop}
      qoderModel="qoder-default"
      setQoderModel={noop}
      providerModelCatalog={{}}
      providerModelsLoading={false}
      tasksEnabled={false}
      isTaskMasterInstalled={false}
      onShowAllTasks={null}
      setInput={noop}
      installedProviders={installedProviders}
    />,
  );
}

test('renders the provider picker card when a provider is installed', () => {
  const html = renderPicker(installed(['claude']));
  assert.match(html, /Choose Your AI Assistant/);
  assert.match(html, /\bClaude\b/); // provider card for the current provider
  assert.doesNotMatch(html, /No provider is installed on the target machine/);
});

test('renders the none-installed empty-state copy when every provider is hidden', () => {
  const html = renderPicker(installed([]));
  assert.match(html, /Choose Your AI Assistant/);
  assert.match(html, /No provider is installed on the target machine/);
  assert.doesNotMatch(html, /\bClaude\b/); // no provider card when none installed
});

test('keeps the picker visible while install availability is still loading', () => {
  const html = renderPicker(null);
  assert.match(html, /Choose Your AI Assistant/);
  assert.doesNotMatch(html, /No provider is installed on the target machine/);
});
