import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appConfig, resolveLlmProxy } from '@/modules/config/config.js';
import type { AppConfig } from '@/modules/config/config.js';

/** Renders the llm-proxy TOML config from app.config. Pure for testing. */
export function generateToml(cfg: AppConfig): string {
  const p = resolveLlmProxy(cfg);
  const lines: string[] = [];
  lines.push('[proxy]', `port = ${p.port}`, `vlm_model = "${p.vlmModel}"`, `vlm_max_tokens = ${p.vlmMaxTokens}`, '');
  lines.push('[upstream]', `anthropic_url = "${p.anthropicUrl}"`, `openai_url = "${p.openaiUrl}"`, '');
  lines.push('[keys]', 'sophnet = ""', '');
  lines.push('[routing]');

  // String entries must all precede [routing.<alias>] sub-tables in TOML, so do
  // two passes: emit string entries first, then table entries.
  const tableEntries: Array<[string, { model: string; upstream?: string }]> = [];
  for (const [alias, target] of Object.entries(p.routing)) {
    if (typeof target === 'string') {
      lines.push(`${alias} = "${target}"`);
    } else if (target && typeof target.model === 'string') {
      tableEntries.push([alias, target]);
    }
  }
  for (const [alias, target] of tableEntries) {
    lines.push('', `[routing.${alias}]`, `model = "${target.model}"`);
    if (target.upstream) lines.push(`upstream = "${target.upstream}"`);
  }
  return lines.join('\n') + '\n';
}

export type LlmProxyManager = {
  /** (Re)generate the TOML from current config and (re)start the sidecar. */
  reconcile(): void;
  /** Kill the sidecar and stop auto-respawn (idempotent). */
  stop(): void;
};

export function createLlmProxyManager(opts?: { binaryPath?: string; respawnDelayMs?: number }): LlmProxyManager {
  let child: ChildProcess | null = null;
  let stopped = false;
  let respawnTimer: NodeJS.Timeout | null = null;
  const respawnDelayMs = opts?.respawnDelayMs ?? 3000;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const binaryPath = opts?.binaryPath ?? path.join(here, '..', '..', '..', 'llm-proxy', 'llm-proxy');

  function tomlPath(): string {
    return path.join(path.dirname(appConfig().filePath), 'llm-proxy.toml');
  }

  function stopChild(): void {
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    if (child) { try { child.kill('SIGTERM'); } catch { /* ignore */ } child = null; }
  }

  function spawnProxy(): void {
    const p = resolveLlmProxy(appConfig().get());
    const proc = spawn(binaryPath, [], {
      env: { ...process.env, LLM_PROXY_CONFIG: tomlPath(), SOPHNET_API_KEY: p.apiKey },
      stdio: 'ignore',
    });
    child = proc;
    console.log(`[llm-proxy] started pid=${proc.pid} port=${p.port}`);
    proc.on('exit', (code, signal) => {
      if (child !== proc) return; // stale exit from a superseded child — ignore
      child = null;
      if (stopped) return;
      console.warn(`[llm-proxy] exited code=${code} signal=${signal}; respawning in ${respawnDelayMs}ms`);
      respawnTimer = setTimeout(() => { if (!stopped) reconcile(); }, respawnDelayMs);
    });
  }

  function reconcile(): void {
    if (stopped) return;
    const cfg = appConfig().get();
    const p = resolveLlmProxy(cfg);
    if (!p.enabled) {
      stopChild();
      return;
    }
    if (!fs.existsSync(binaryPath)) {
      console.warn(`[llm-proxy] binary not found at ${binaryPath}; run backend/llm-proxy/build.sh`);
      return;
    }
    fs.mkdirSync(path.dirname(tomlPath()), { recursive: true });
    fs.writeFileSync(tomlPath(), generateToml(cfg), 'utf8');
    stopChild(); // restart to pick up new config
    spawnProxy();
  }

  function stop(): void {
    stopped = true;
    stopChild();
  }

  return { reconcile, stop };
}
