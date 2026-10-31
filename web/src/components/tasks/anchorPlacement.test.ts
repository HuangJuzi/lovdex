import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_GAP,
  ANCHOR_MARGIN,
  computeAnchorPlacement,
  isAnchorWithinViewport,
  resolveExternalScrollAction,
} from './anchorPlacement';

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

// 回归测试（BUG2）：新建任务浮层是 fixed 的，后台会话流式输出自动滚动时锚点
// 根本不动 —— 外部滚动只能重算位置，绝不能把下拉直接关掉。
test('external scroll repositions a visible anchor instead of closing the popover', () => {
  assert.equal(
    resolveExternalScrollAction({
      targetInsidePopover: false,
      anchorRect: { top: 200, bottom: 236, left: 40, right: 140 },
      viewportWidth: 1200,
      viewportHeight: 800,
    }),
    'reposition',
  );
});

test('scroll inside the popover itself is ignored', () => {
  assert.equal(
    resolveExternalScrollAction({
      targetInsidePopover: true,
      anchorRect: { top: 200, bottom: 236, left: 40, right: 140 },
      viewportWidth: 1200,
      viewportHeight: 800,
    }),
    'ignore',
  );
});

test('anchor scrolled out of the viewport closes the popover', () => {
  assert.equal(
    resolveExternalScrollAction({
      targetInsidePopover: false,
      anchorRect: { top: -80, bottom: -44, left: 40, right: 140 },
      viewportWidth: 1200,
      viewportHeight: 800,
    }),
    'close',
  );
});

test('anchors touching any viewport edge still count as visible', () => {
  assert.equal(isAnchorWithinViewport({ top: 0, bottom: 36, left: 0, right: 100 }, 1200, 800), true);
  assert.equal(isAnchorWithinViewport({ top: 764, bottom: 800, left: 1100, right: 1200 }, 1200, 800), true);
  assert.equal(isAnchorWithinViewport({ top: 800, bottom: 836, left: 40, right: 140 }, 1200, 800), false);
  assert.equal(isAnchorWithinViewport({ top: 100, bottom: 136, left: 1200, right: 1300 }, 1200, 800), false);
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
