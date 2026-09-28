import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';

/** 后端线上形状：quick_replies 行原样透出（snake_case），与其他业务表 API 一致。 */
export type QuickReply = {
  quick_reply_id: string;
  content: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

export type UseQuickRepliesResult = {
  items: QuickReply[];
  isLoading: boolean;
  error: string | null;
  /**
   * 重拉列表。打开浮层时调用，以及页面从后台回到前台时调用——
   * 列表只在挂载时拉一次的话，另一台设备（或另一个标签页）建的条目永远看不到。
   * 失败时把错误写进 `error` 并抛出，调用方自行决定是否吞掉。
   */
  refresh: () => Promise<void>;
  create: (content: string) => Promise<void>;
  update: (quickReplyId: string, content: string) => Promise<void>;
  remove: (quickReplyId: string) => Promise<void>;
  /** 打点，不阻塞点选：失败静默吞掉，下一次 GET 会把顺序纠正回来。 */
  markUsed: (quickReplyId: string) => void;
};

/** 从后端的 {success:false,error:{message}} 里取可展示的文案。 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload?.error?.message || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

/**
 * 把底层错误换成可展示的 Error。
 * fetch 在断网或请求被中断时抛 TypeError，message 是英文的 "Failed to fetch"，
 * 直接透给用户没意义；后端业务错误（我们自己抛的 Error）则原样保留文案。
 */
function toDisplayError(err: unknown, fallback: string): Error {
  if (err instanceof Error && err.name !== 'TypeError') {
    return err;
  }
  return new Error(fallback);
}

export function useQuickReplies(): UseQuickRepliesResult {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 刷新代际。markUsed 的旁路刷新与用户紧接着的写操作刷新会并发，两个 GET 乱序
  // 返回时后到的旧响应会把刚建的条目短暂冲掉；只认最新一次请求的结果。
  const refreshGenerationRef = useRef(0);

  /**
   * 重拉列表。失败时抛错，让写操作的调用方能感知「写成功但列表没跟上」，
   * 而不是误以为整件事都成了、把编辑框关掉。
   */
  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    try {
      const response = await api.quickReplies.list();
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const payload = (await response.json()) as { items?: QuickReply[] };
      if (generation !== refreshGenerationRef.current) {
        return;
      }
      setItems(Array.isArray(payload?.items) ? payload.items : []);
      setError(null);
    } catch (err) {
      // 过期的那次请求失败不该覆盖新一代的展示状态。
      if (generation !== refreshGenerationRef.current) {
        return;
      }
      const displayError = toDisplayError(err, '无法加载常用语');
      setError(displayError.message);
      throw displayError;
    } finally {
      if (generation === refreshGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // 首次挂载的失败只展示在 error 上，不往外抛——没有调用方在等这个 Promise。
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  // 页面从后台回到前台时重拉。手机浏览器的后台标签页会被冻结，冻结期间另一台设备
  // 建的条目不会自己出现；用户切回来时补一次。
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh]);

  // 写操作后重拉列表，不做乐观更新：服务端要按 last_used_at 重排，
  // 本地先插入/移动会让列表抖动。
  const mutate = useCallback(
    async (request: () => Promise<Response>) => {
      let response: Response;
      try {
        response = await request();
      } catch (err) {
        // 请求根本没发出去（断网、被中断）：换成中文文案再抛。
        throw toDisplayError(err, '网络异常，请稍后重试');
      }
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      await refresh();
    },
    [refresh],
  );

  const create = useCallback(
    (content: string) => mutate(() => api.quickReplies.create(content)),
    [mutate],
  );

  const update = useCallback(
    (quickReplyId: string, content: string) =>
      mutate(() => api.quickReplies.update(quickReplyId, content)),
    [mutate],
  );

  const remove = useCallback(
    (quickReplyId: string) => mutate(() => api.quickReplies.remove(quickReplyId)),
    [mutate],
  );

  const markUsed = useCallback(
    (quickReplyId: string) => {
      void api.quickReplies
        .use(quickReplyId)
        .then((response: Response) => {
          // 打点是旁路的：刷新失败也不该冒泡成未处理的 rejection。
          if (response.ok) void refresh().catch(() => undefined);
        })
        .catch(() => undefined);
    },
    [refresh],
  );

  return { items, isLoading, error, refresh, create, update, remove, markUsed };
}
