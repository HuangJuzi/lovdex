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
// Neutral black overlays (`hsl(0 0% 0% / <alpha>`) are masks/shadows, not theme
// colors, so they are exempt from the hardcoded-hsl check.
const HARDCODED_HSL = /hsl\(\s*(?!0\s+0%\s+0%)[0-9]/g;

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
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
  '--chart-6', '--chart-7', '--chart-8', '--chart-9', '--chart-10',
];

/** Tokens that are mode-independent and live only in `:root`. */
const ROOT_ONLY_TOKENS = [
  '--radius',
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/url\("data:image\/svg\+xml[^"]*"\)/g, 'url()');
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

function hslToRgb(value: string): [number, number, number] | null {
  const m = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) return null;
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const base = l - c / 2;
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + base) * 255)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function tokenMap(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
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

/** Text-form semantic colors need 4.5:1; chart colors are graphical objects needing 3:1 (WCAG 1.4.11). */
const CONTRAST_TEXT_TOKENS = ['--success', '--warning', '--info', '--destructive'];
const CONTRAST_GRAPHIC_TOKENS = [
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
  '--chart-6', '--chart-7', '--chart-8', '--chart-9', '--chart-10',
];

test('semantic and chart tokens meet WCAG contrast in both modes', () => {
  const css = readFileSync(join('src', 'index.css'), 'utf8');
  const darkStart = css.search(/\.dark\s*\{/);
  assert.ok(darkStart > 0, '.dark block not found in index.css');
  const modes = [
    { name: 'light', tokens: tokenMap(css.slice(0, darkStart)) },
    { name: 'dark', tokens: tokenMap(css.slice(darkStart)) },
  ];

  const failures: string[] = [];
  for (const { name: mode, tokens } of modes) {
    const surfaces = ['--background', '--card'].map((token) => {
      const rgb = hslToRgb(tokens.get(token) ?? '');
      if (!rgb) failures.push(`${mode}: cannot parse ${token}`);
      return { token, rgb };
    });

    const verify = (token: string, min: number) => {
      const rgb = hslToRgb(tokens.get(token) ?? '');
      if (!rgb) {
        failures.push(`${mode}: ${token} missing or unparseable`);
        return;
      }
      for (const surface of surfaces) {
        if (!surface.rgb) continue;
        const ratio = contrastRatio(rgb, surface.rgb);
        if (ratio < min) {
          failures.push(`${mode}: ${token} on ${surface.token} = ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
        }
      }
    };

    for (const token of CONTRAST_TEXT_TOKENS) verify(token, 4.5);
    for (const token of CONTRAST_GRAPHIC_TOKENS) verify(token, 3);
  }

  assert.deepEqual(failures, [], `contrast failures:\n  ${failures.join('\n  ')}`);
});
