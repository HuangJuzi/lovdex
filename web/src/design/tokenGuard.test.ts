import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the design token migration. See
 * docs/superpowers/specs/2026-09-20-design-token-unification-design.md
 *
 * Colors must come from semantic tokens (bg-card, text-muted-foreground, ...)
 * and never from the raw Tailwind palette (bg-gray-800, text-blue-500, ...).
 */

/** Content colors, not theme colors — see spec §6.2. */
const EXEMPT_DIRS = [
  join('src', 'components', 'llm-logo-provider'),
  join('src', 'components', 'terminal'),
];

const UTILS =
  'bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret';
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const SHADE = '[0-9]{2,3}';

const RAW_CLASS = new RegExp(`\\b(?:${UTILS})-(?:${PALETTE})-${SHADE}\\b`, 'g');
const DARK_PAIR = new RegExp(`dark:(?:${UTILS})-(?:${PALETTE})-${SHADE}`, 'g');
const HARDCODED_HEX = /#[0-9a-fA-F]{6}\b|%23[0-9a-fA-F]{6}/g;
const RGB_LITERAL = /\brgba?\(\s*[0-9]/g;
const HARDCODED_HSL = /hsl\(\s*[0-9]/g;

/** Tokens that must exist in both `:root` and `.dark`. */
const THEME_TOKENS = [
  '--background', '--foreground',
  '--card', '--card-foreground',
  '--popover', '--popover-foreground',
  '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground',
  '--accent', '--accent-foreground',
  '--destructive', '--destructive-foreground',
  '--success', '--success-foreground',
  '--warning', '--warning-foreground',
  '--info', '--info-foreground',
  '--border', '--input', '--ring',
];

/** Tokens that are mode-independent and live only in `:root`. */
const ROOT_ONLY_TOKENS = [
  '--radius',
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
  '--chart-6', '--chart-7', '--chart-8', '--chart-9', '--chart-10',
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXEMPT_DIRS.includes(path)) continue;
      sourceFiles(path, acc);
    } else if (/\.(ts|tsx|css|js|jsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(path);
    }
  }
  return acc;
}

function matches(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of sourceFiles('src')) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push(`${file}:${line}: ${match[0]}`);
    }
  }
  return found;
}

function report(found: string[]): string {
  const sample = found.slice(0, 10).join('\n  ');
  return `${found.length} occurrences, first 10:\n  ${sample}`;
}

test('no raw Tailwind palette classes outside exempt dirs', () => {
  const found = matches(RAW_CLASS);
  assert.equal(found.length, 0, report(found));
});

test('no dark: overrides of raw palette colors', () => {
  const found = matches(DARK_PAIR);
  assert.equal(found.length, 0, report(found));
});

test('no hardcoded hex colors outside exempt dirs', () => {
  const found = matches(HARDCODED_HEX);
  assert.equal(found.length, 0, report(found));
});

test('no rgb()/rgba() literals outside exempt dirs', () => {
  const found = matches(RGB_LITERAL);
  assert.equal(found.length, 0, report(found));
});

test('no hardcoded hsl() literals outside exempt dirs', () => {
  const found = matches(HARDCODED_HSL);
  assert.equal(found.length, 0, report(found));
});

test('index.css defines every required token', () => {
  const css = readFileSync(join('src', 'index.css'), 'utf8');
  const darkStart = css.search(/\.dark\s*\{/);
  assert.ok(darkStart > 0, '.dark block not found in index.css');
  const light = css.slice(0, darkStart);
  const dark = css.slice(darkStart);

  const missing: string[] = [];
  for (const token of THEME_TOKENS) {
    if (!light.includes(`${token}:`)) missing.push(`${token} (light)`);
    if (!dark.includes(`${token}:`)) missing.push(`${token} (dark)`);
  }
  for (const token of ROOT_ONLY_TOKENS) {
    if (!light.includes(`${token}:`)) missing.push(`${token} (root)`);
  }
  assert.deepEqual(missing, [], `missing tokens: ${missing.join(', ')}`);
});
