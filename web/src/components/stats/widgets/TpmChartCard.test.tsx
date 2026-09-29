import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { IngestStatus } from '../useTokenStats';

import { TpmChartCard } from './TpmChartCard';

function ingestStatus(overrides: Partial<IngestStatus> = {}): IngestStatus {
  return {
    scanning: true,
    filesTotal: 0,
    filesDone: 0,
    eventsIndexed: 0,
    startedAt: null,
    lastScanAt: null,
    ...overrides,
  };
}

// renderToStaticMarkup 不跑 effect；timeseries 传 null 时卡片走空态分支，
// 因此不会渲染 recharts（SSR 下 ResponsiveContainer 量不到尺寸）。
test('目录还没遍历完（filesTotal 为 0）时不显示 0/0 计数', () => {
  const html = renderToStaticMarkup(
    <TpmChartCard
      timeseries={null}
      ingest={ingestStatus()}
      metric="all"
      dimension="model"
      onMetricChange={() => {}}
    />,
  );
  assert.match(html, /首次回填进行中…/);
  assert.doesNotMatch(html, /0\/0/);
});

test('有文件计数时显示 x/y 与已入库条数', () => {
  const html = renderToStaticMarkup(
    <TpmChartCard
      timeseries={null}
      ingest={ingestStatus({ filesTotal: 1333, filesDone: 575, eventsIndexed: 2058 })}
      metric="all"
      dimension="model"
      onMetricChange={() => {}}
    />,
  );
  assert.match(html, /575\/1333 个文件/);
  assert.match(html, /已入库 2058 条/);
});

test('未在扫描时不显示回填提示', () => {
  const html = renderToStaticMarkup(
    <TpmChartCard
      timeseries={null}
      ingest={ingestStatus({ scanning: false, filesTotal: 1333, filesDone: 1333 })}
      metric="all"
      dimension="model"
      onMetricChange={() => {}}
    />,
  );
  assert.doesNotMatch(html, /回填/);
});

test('标题行渲染四个口径档位，当前档 aria-pressed=true', () => {
  const html = renderToStaticMarkup(
    <TpmChartCard
      timeseries={null}
      ingest={null}
      metric="input"
      dimension="model"
      onMetricChange={() => {}}
    />,
  );
  for (const label of ['全部', '仅新增', '仅输入', '仅输出']) {
    assert.match(html, new RegExp(`>${label}<`), `缺少档位 ${label}`);
  }
  // 只能有一个按下态，且必须是当前档
  const pressed = html.match(/aria-pressed="true"[^>]*>([^<]+)</g) ?? [];
  assert.equal(pressed.length, 1, '只能有一个按下态');
  assert.match(pressed[0], /仅输入/);
});

test('空态（暂无用量）下口径控件仍渲染', () => {
  const html = renderToStaticMarkup(
    <TpmChartCard
      timeseries={null}
      ingest={null}
      metric="all"
      dimension="model"
      onMetricChange={() => {}}
    />,
  );
  assert.match(html, /暂无用量数据/);
  assert.match(html, /仅输出/, '空态也要能切口径');
});

// ---------------------------------------------------------------------------
// 曲线与面积必须「同一个东西」——见
// docs/superpowers/specs/2026-09-29-stats-curve-area-blend-design.md
//
// 为什么只能读源码：本文件上下的 renderToStaticMarkup 用的是 timeseries=null 的
// 空态分支，SSR 下 ResponsiveContainer 量不到尺寸，recharts 根本不渲曲线路径。
// 所以这里钉的是「让两者合成结果相同」的那两个充分条件，量像素的结论由 spec §4.2
// 的浏览器探针给出（那个才量得到）。
//
// 判据的道理：填充 α=0.35 叠底色，合成结果不等于源色；描边若 α=1 就等于源色本身，
// 于是同一个色号算出两个颜色 —— 这正是用户看到的「曲线像另一条独立折线」。
// 让描边的 α 与填充一致，两者在同一块底色上合成结果就恒等。
// ---------------------------------------------------------------------------
const SOURCE = fileURLToPath(new URL('./TpmChartCard.tsx', import.meta.url));
const source = readFileSync(SOURCE, 'utf8');

/** 取源码里包含 `marker` 的那个 JSX 开标签的整段文本。 */
function openingTagContaining(src: string, marker: string): string {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `TpmChartCard.tsx 里找不到 ${marker}（改动后标记变了？）`);
  const open = src.lastIndexOf('<', at);
  const close = src.indexOf('>', at);
  assert.ok(open !== -1 && close > at, `${marker} 所在的标签读不出来`);
  return src.slice(open, close + 1);
}

/** 开标签上 `name={expr}` 形式的表达式文本；缺属性返回 null。 */
function exprAttr(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}=\\{([^}]*)\\}`).exec(tag);
  return match ? match[1].trim() : null;
}

test('TPM 曲线的描边与填充取自同一个色号', () => {
  const tag = openingTagContaining(source, 'stackId="tpm"');
  const stroke = exprAttr(tag, 'stroke');
  const fill = exprAttr(tag, 'fill');
  assert.ok(stroke && fill, `Area 上 stroke/fill 读不出来：${tag}`);
  assert.equal(
    stroke,
    fill,
    `描边与填充必须是同一个色号表达式，否则同一块色带会算出两种颜色（stroke=${stroke} / fill=${fill}）`,
  );
});

test('TPM 曲线的描边与填充共用同一个不透明度常量', () => {
  const tag = openingTagContaining(source, 'stackId="tpm"');
  const fillOpacity = exprAttr(tag, 'fillOpacity');
  const strokeOpacity = exprAttr(tag, 'strokeOpacity');
  assert.ok(
    fillOpacity,
    'Area 上必须有 fillOpacity（半透明填充是这张图的既有形态，删掉会让堆叠层次消失）',
  );
  assert.ok(
    strokeOpacity,
    'Area 上必须有 strokeOpacity：缺省时 SVG 取 α=1，描边会退回「纯源色」，本设计即告失效',
  );
  assert.equal(
    strokeOpacity,
    fillOpacity,
    `描边与填充的不透明度必须取自同一个常量（fillOpacity=${fillOpacity} / strokeOpacity=${strokeOpacity}）；` +
      '各写一个字面量会在将来只改一处时悄悄退回「两个颜色」，且不会有任何测试变红',
  );
  assert.match(
    strokeOpacity,
    /^[A-Za-z_$][\w$]*$/,
    `不透明度应当是具名常量而不是字面量（实际写了 ${strokeOpacity}）——共用一个常量才能挡住「只改一处」`,
  );
});

test('全图只有一个 TPM 堆叠 Area（避免漏改出第二处）', () => {
  const hits = source.match(/stackId="tpm"/g) ?? [];
  assert.equal(hits.length, 1, `stackId="tpm" 出现 ${hits.length} 次；上面的断言只覆盖第一处`);
});
