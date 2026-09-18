import test from 'node:test';
import assert from 'node:assert/strict';

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
    <TpmChartCard timeseries={null} ingest={ingestStatus()} metric="all" dimension="model" />,
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
    />,
  );
  assert.doesNotMatch(html, /回填/);
});
