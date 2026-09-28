import test from 'node:test';
import assert from 'node:assert/strict';

import { ANCHOR_GAP, ANCHOR_MARGIN, computeAnchorPlacement } from './anchorPlacement';

// 定位辅助：锚定弹层，必须始终完整落在视口内（贴锚点下方，放不下就翻到上方）。
test('places the panel below the anchor when it fits', () => {
  const p = computeAnchorPlacement({ top: 100, bottom: 140, left: 40, right: 140 }, 1200, 800, 200, 'left');
  assert.equal(p.top, 140 + ANCHOR_GAP);
  assert.equal(p.bottom, undefined);
  assert.equal(p.left, 40);
  assert.ok(p.maxHeight >= 200); // 放得下就不该夹
});

test('flips above the anchor when the space below is too small', () => {
  // 小屏场景：芯片行贴在弹窗底部，下方只剩几十像素，上方却有一大片。
  const p = computeAnchorPlacement({ top: 500, bottom: 540, left: 40, right: 140 }, 1200, 600, 334, 'left');
  assert.equal(p.top, undefined);
  assert.equal(p.bottom, 600 - 500 + ANCHOR_GAP);
  assert.ok(p.maxHeight >= 334);
});

test('keeps the panel below when neither side fits but below has more room', () => {
  const p = computeAnchorPlacement({ top: 20, bottom: 60, left: 40, right: 140 }, 1200, 600, 800, 'left');
  assert.equal(p.top, 60 + ANCHOR_GAP);
  assert.equal(p.bottom, undefined);
  assert.equal(p.maxHeight, 600 - 60 - ANCHOR_GAP - ANCHOR_MARGIN); // 夹到下方可用空间，靠滚动兜底
});

test('aligns the panel to the anchor right edge', () => {
  const p = computeAnchorPlacement({ top: 100, bottom: 140, left: 900, right: 1000 }, 1200, 800, 200, 'right');
  assert.equal(p.right, 1200 - 1000);
  assert.equal(p.left, undefined);
});

// 回归测试：这条 bug 的判据 —— 无论视口多矮、锚点多靠下，弹层都不能越出视口。
test('never lets the panel cross the viewport edges, at any viewport height', () => {
  for (let vh = 320; vh <= 1400; vh += 20) {
    for (const anchorBottom of [60, 120, vh * 0.5, vh * 0.8, vh - 40]) {
      for (const panelHeight of [80, 200, 334, 900]) {
        const anchor = { top: anchorBottom - 36, bottom: anchorBottom, left: 40, right: 140 };
        const p = computeAnchorPlacement(anchor, 1200, vh, panelHeight, 'left');
        const rendered = Math.min(panelHeight, p.maxHeight);
        const ctx = `vh=${vh} anchorBottom=${anchorBottom} panelHeight=${panelHeight} -> ${JSON.stringify(p)}`;

        assert.ok(rendered > 0, `panel collapsed to zero height: ${ctx}`);
        // 贴下时 top 是面板顶边；贴上时 bottom 是面板底边到视口底的距离。
        const topEdge = p.top !== undefined ? p.top : vh - (p.bottom ?? 0) - rendered;
        const bottomEdge = p.top !== undefined ? p.top + rendered : vh - (p.bottom ?? 0);
        assert.ok(topEdge >= 0, `panel crosses the viewport top: ${ctx}`);
        assert.ok(bottomEdge <= vh, `panel crosses the viewport bottom: ${ctx}`);
      }
    }
  }
});
