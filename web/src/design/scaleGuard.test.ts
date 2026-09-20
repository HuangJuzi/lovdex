import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the scale unification (radius / font-size / shadow).
 * See docs/superpowers/specs/2026-09-20-scale-unification-design.md
 *
 * Scales must come from the named steps in tailwind.config.js, never from
 * arbitrary values. Arbitrary values are exactly how the scale drifted last
 * time: 153 font sizes and 40 shadows accumulated one inline value at a time.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, acc);
    } else if (
      /\.(ts|tsx|css|js|jsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      acc.push(path);
    }
  }
  return acc;
}

function matches(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of sourceFiles('src')) {
    const source = readFileSync(file, 'utf8');
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

const ARBITRARY_FONT_SIZE = /\btext-\[[0-9.]+(?:px|em|rem)\]/g;
const ARBITRARY_RADIUS = /\brounded(?:-[a-z]+)*-\[([^\]]+)\]/g;
const HARDCODED_BORDER_RADIUS = /border-radius:\s*[0-9]/g;

// The five recurring 3D recipes, matched as EXACT strings. A prefix pattern
// like `shadow-[0_[23]px_0_` would also catch two one-off recipes that merely
// share the `0 3px 0` start (they end in 24px/60px and 8px/18px spreads) --
// those are deliberately NOT named, so a prefix pattern would make this test
// impossible to pass. See spec §1.3.
const RECURRING_SHADOW_RECIPES = [
  'shadow-[0_2px_0_hsl(var(--foreground)/0.10),0_4px_10px_hsl(var(--foreground)/0.06)]',
  'shadow-[0_3px_0_hsl(var(--foreground)/0.07),0_12px_26px_hsl(var(--foreground)/0.07)]',
  'shadow-[0_2px_0_hsl(var(--primary))]',
  'shadow-[0_2px_0_hsl(var(--foreground)/0.08)]',
  'shadow-[0_3px_0_hsl(var(--foreground)/0.08),0_6px_16px_hsl(var(--foreground)/0.07)]',
];

/** Finds inlined occurrences of the recurring recipes, with line numbers. */
function findInlineRecipes(source: string): string[] {
  const found: string[] = [];
  for (const recipe of RECURRING_SHADOW_RECIPES) {
    let from = 0;
    for (;;) {
      const at = source.indexOf(recipe, from);
      if (at < 0) break;
      found.push(`line ${source.slice(0, at).split('\n').length}: ${recipe}`);
      from = at + recipe.length;
    }
  }
  return found;
}

test('no arbitrary font sizes', () => {
  const found = matches(ARBITRARY_FONT_SIZE);
  assert.equal(found.length, 0, report(found));
});

test('no arbitrary radius values (rounded-[inherit] is allowed)', () => {
  const found = matches(ARBITRARY_RADIUS).filter((hit) => !hit.includes('[inherit]'));
  assert.equal(found.length, 0, report(found));
});

test('no hardcoded border-radius in CSS', () => {
  const found = matches(HARDCODED_BORDER_RADIUS);
  assert.equal(found.length, 0, report(found));
});

test('the recurring 3D shadow recipes are named, not inlined', () => {
  const failures: string[] = [];
  for (const file of sourceFiles('src')) {
    const source = readFileSync(file, 'utf8');
    for (const hit of findInlineRecipes(source)) failures.push(`${file}:${hit}`);
  }
  assert.equal(failures.length, 0, report(failures));
});
