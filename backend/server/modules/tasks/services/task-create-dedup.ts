/**
 * createTask 的重复提交闸门。
 *
 * 「新建任务」是**非幂等**的 POST：同一个弹窗连点两次、两个标签页各点一次、
 * 请求发出后没等到响应又重试一次，都会各建一条任务。前端那道防线（确认按钮在途
 * 禁用）只在同一个弹窗实例里有效，这里兜住它管不到的部分。
 *
 * 判定依据是**请求体归一化后的指纹**（`taskCreateDedupKey`），不是客户端传的
 * idempotency key：重复提交往往来自不同弹窗 / 不同标签页，它们各自生成的 key 不
 * 一样，而内容是一样的。
 *
 * 两道拦截：
 * - 在途：指纹相同的创建已经在跑（典型是后端取名那最长 3s 的阻塞窗口），第二次
 *   提交直接等同一个 Promise，拿到同一条任务。
 * - 窗口期：刚落库的创建在 `TASK_CREATE_DEDUP_WINDOW_MS` 内被重复提交时复用该
 *   任务 —— 覆盖「第一次其实成功了但客户端没拿到响应，又提交了一次」。
 *
 * 代价是同一份内容在窗口内**故意**建两次会被合并。窗口取 60s：长到覆盖所有真实的
 * 重复提交，短到不至于挡住「过一会儿再建一条一样的」这种明确意图。
 */
import { createHash } from 'node:crypto';

import type { TaskRow } from '@/shared/types.js';

/** 已落库的创建在多长时间内算「同一份意图」。 */
export const TASK_CREATE_DEDUP_WINDOW_MS = 60_000;

/** 决定落库内容的字段全集：任一不同就不是同一份创建意图。 */
type DedupKeyInput = {
  projectPath: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  executorProvider?: string | null;
  executorModel?: string | null;
  sessionId?: string | null;
  priority?: string | null;
  deadline?: string | null;
  isOperator?: boolean;
  label?: string | null;
  remark?: string | null;
  sourceScheduleId?: string | null;
  sourceSessionId?: string | null;
  contextMode?: string | null;
  autoApprove?: boolean;
};

/** undefined / null / 空串 / 首尾空白都归一化，避免同一份意图算出两个指纹。 */
function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 请求体的内容指纹。按固定字段顺序序列化后取 sha1 —— 顺序固定是为了让字段顺序
 * 不同的等价请求也能命中同一个指纹，取哈希是为了日志里不落用户原文。
 */
export function taskCreateDedupKey(input: DedupKeyInput): string {
  const payload = [
    normalize(input.projectPath),
    normalize(input.title),
    normalize(input.description),
    normalize(input.status),
    normalize(input.executorProvider),
    normalize(input.executorModel),
    normalize(input.sessionId),
    normalize(input.priority),
    normalize(input.deadline),
    input.isOperator === true ? 1 : 0,
    normalize(input.label),
    normalize(input.remark),
    normalize(input.sourceScheduleId),
    normalize(input.sourceSessionId),
    normalize(input.contextMode),
    // 追加在末尾（而不是插进 isOperator 旁边）纯粹是为了让「这次改动的 diff 最小」：
    // 数组多一个元素本来就改变了所有指纹，但指纹只活在进程内的 Map 里（见下方闸门），
    // 重启即清空，所以改动本身不需要考虑旧指纹的兼容。
    input.autoApprove === true ? 1 : 0,
  ];
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

export type TaskCreateDedupGate = {
  /**
   * 执行一次创建：同一 key 在途时并入同一次，窗口内已落库时直接复用。
   * `create` 抛错不写窗口 —— 下一次提交会真的重试。
   */
  run(key: string, create: () => Promise<TaskRow>): Promise<TaskRow>;
};

export function createTaskDedupGate(opts: {
  /** 窗口期，默认 `TASK_CREATE_DEDUP_WINDOW_MS`；0 表示只合并「在途」。 */
  windowMs?: number;
  /** 单测用的时钟注入口。 */
  now?: () => number;
  /** 复用已完成任务时取当前行（改名 / 删除都以这里为准）。 */
  lookup: (taskId: string) => TaskRow | null;
  /**
   * 合并掉一次重复提交时回调（在途合并要等第一次落库、拿到 taskId 之后再回调）。
   * 合并是静默的 —— 没有这条日志，用户报「我提交了两次怎么只有一条」时无从查起。
   */
  onHit?: (key: string, taskId: string) => void;
}): TaskCreateDedupGate {
  const windowMs = opts.windowMs ?? TASK_CREATE_DEDUP_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const inflight = new Map<string, Promise<TaskRow>>();
  // 只在 run 时清理：条目数天然被「一个窗口内的创建量」封顶，没有定时器要管。
  const settled = new Map<string, { taskId: string; at: number }>();

  function prune(nowMs: number): void {
    for (const [key, entry] of settled) {
      if (nowMs - entry.at >= windowMs) settled.delete(key);
    }
  }

  return {
    run(key, create) {
      const inFlight = inflight.get(key);
      if (inFlight) {
        return inFlight.then((row) => {
          opts.onHit?.(key, row.task_id);
          return row;
        });
      }

      prune(now());
      const done = settled.get(key);
      if (done) {
        const row = opts.lookup(done.taskId);
        if (row) {
          opts.onHit?.(key, row.task_id);
          return Promise.resolve(row);
        }
        // 任务已被删除 —— 这份意图当作新的处理。
        settled.delete(key);
      }

      const running = (async () => {
        try {
          const row = await create();
          settled.set(key, { taskId: row.task_id, at: now() });
          return row;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, running);
      return running;
    },
  };
}
