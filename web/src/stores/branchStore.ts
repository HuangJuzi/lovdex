/**
 * Shared「当前项目分支」状态源。
 *
 * 分支是在应用之外被切换的（外部 shell、内置终端、或某个会话里跑 git checkout），
 * 组件内部没有任何 mutation 可以挂刷新，只能轮询。轮询点集中在这里，各组件只订阅，
 * 这样既不会每个消费者各打一份 `/api/git/status`，也不会再出现"同一件事两份 state
 * 各自漂移"的老问题（右上角标签曾因此长期显示旧分支）。
 */

import { authenticatedFetch } from '../utils/api';
import type { GitStatusResponse } from '../components/git-panel/types/types';

/** 轮询间隔。`/api/git/status` 会 spawn 若干 git 进程，别调得太激进。 */
export const BRANCH_PROBE_INTERVAL_MS = 10_000;

export type BranchSnapshot = {
  branch: string;
  notGitRepository: boolean;
};

/** 时序/可见性依赖，抽出来是为了能在 node:test 里用假实现验证。 */
export type BranchStoreScheduler = {
  /** 周期触发，返回可取消的句柄。 */
  repeat(handler: () => void, intervalMs: number): number;
  cancelRepeat(handle: number): void;
  /** 页面重新可见 / 窗口重新聚焦时调用 handler；返回取消订阅函数。 */
  onResume(handler: () => void): () => void;
  isVisible(): boolean;
};

export type BranchStoreDeps = {
  /** 取一次分支；返回 null 表示本次探测无结论（网络失败/真正的 git 报错）。 */
  fetchBranch: (projectId: string) => Promise<BranchSnapshot | null>;
  scheduler: BranchStoreScheduler;
  intervalMs?: number;
};

type Listener = (snapshot: BranchSnapshot) => void;

type StoreEntry = {
  snapshot: BranchSnapshot | null;
  listeners: Set<Listener>;
  stopPolling: (() => void) | null;
  inFlight: boolean;
};

export function createBranchStore({
  fetchBranch,
  scheduler,
  intervalMs = BRANCH_PROBE_INTERVAL_MS,
}: BranchStoreDeps) {
  const entries = new Map<string, StoreEntry>();

  const sameSnapshot = (a: BranchSnapshot, b: BranchSnapshot) =>
    a.branch === b.branch && a.notGitRepository === b.notGitRepository;

  const probe = async (projectId: string) => {
    const entry = entries.get(projectId);
    // 隐藏的标签页不探测：切回来后 onResume 会立刻补一次。
    if (!entry || entry.inFlight || !scheduler.isVisible()) {
      return;
    }

    entry.inFlight = true;
    try {
      const snapshot = await fetchBranch(projectId);
      // 订阅可能已经全部退订（entry 被移除）——丢弃这次迟到的结果。
      if (!snapshot || entries.get(projectId) !== entry) {
        return;
      }
      if (entry.snapshot && sameSnapshot(entry.snapshot, snapshot)) {
        return;
      }
      entry.snapshot = snapshot;
      entry.listeners.forEach((listener) => listener(snapshot));
    } finally {
      entry.inFlight = false;
    }
  };

  const startPolling = (projectId: string, entry: StoreEntry) => {
    const handle = scheduler.repeat(() => void probe(projectId), intervalMs);
    const stopResume = scheduler.onResume(() => void probe(projectId));
    entry.stopPolling = () => {
      scheduler.cancelRepeat(handle);
      stopResume();
    };
    // 第一个订阅者立刻取一次，而不是干等一个周期。
    void probe(projectId);
  };

  /** 最近一次已知快照；null = 还没探测出结果。 */
  const getSnapshot = (projectId: string): BranchSnapshot | null =>
    entries.get(projectId)?.snapshot ?? null;

  /** 订阅该项目的分支变化（含首个结果）。 */
  const subscribe = (projectId: string, listener: Listener): (() => void) => {
    let entry = entries.get(projectId);
    if (!entry) {
      entry = { snapshot: null, listeners: new Set(), stopPolling: null, inFlight: false };
      entries.set(projectId, entry);
    }
    entry.listeners.add(listener);
    if (!entry.stopPolling) {
      startPolling(projectId, entry);
    }

    return () => {
      const current = entries.get(projectId);
      if (!current) {
        return;
      }
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        current.stopPolling?.();
        entries.delete(projectId);
      }
    };
  };

  /**
   * 订阅"分支相对订阅时刻发生了变化"：首个结果只当基线，不回调。
   * 适合那些需要"变了才做某件重活"的消费者（重拉面板、重拉文件树）。
   */
  const subscribeChange = (projectId: string, handler: Listener): (() => void) => {
    let baseline = getSnapshot(projectId);
    return subscribe(projectId, (snapshot) => {
      const previous = baseline;
      baseline = snapshot;
      if (!previous || sameSnapshot(previous, snapshot)) {
        return;
      }
      handler(snapshot);
    });
  };

  return { getSnapshot, subscribe, subscribeChange };
}

async function fetchBranchSnapshot(projectId: string): Promise<BranchSnapshot | null> {
  try {
    const response = await authenticatedFetch(
      `/api/git/status?project=${encodeURIComponent(projectId)}`,
    );
    const data = (await response.json()) as GitStatusResponse;
    // 不是 git 仓库时后端会同时给 error 和 notGitRepository，只有真正的失败才放弃本次结果。
    if (data.error && !data.notGitRepository) {
      return null;
    }
    return {
      branch: typeof data.branch === 'string' ? data.branch : '',
      notGitRepository: Boolean(data.notGitRepository),
    };
  } catch {
    // 瞬时失败保留上一次已知值，别把标签清空。
    return null;
  }
}

const browserScheduler: BranchStoreScheduler = {
  repeat: (handler, intervalMs) => window.setInterval(handler, intervalMs),
  cancelRepeat: (handle) => window.clearInterval(handle),
  onResume: (handler) => {
    const probeIfVisible = () => {
      if (document.visibilityState === 'visible') {
        handler();
      }
    };
    window.addEventListener('focus', probeIfVisible);
    document.addEventListener('visibilitychange', probeIfVisible);
    return () => {
      window.removeEventListener('focus', probeIfVisible);
      document.removeEventListener('visibilitychange', probeIfVisible);
    };
  },
  isVisible: () => document.visibilityState === 'visible',
};

export const branchStore = createBranchStore({
  fetchBranch: fetchBranchSnapshot,
  scheduler: browserScheduler,
});
