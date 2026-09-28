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
      setError(err instanceof Error ? err.message : '无法加载常用语');
      throw err;
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

  // 写操作后重拉列表，不做乐观更新：服务端要按 last_used_at 重排，
  // 本地先插入/移动会让列表抖动。
  const mutate = useCallback(
    async (request: () => Promise<Response>) => {
      const response = await request();
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

  return { items, isLoading, error, create, update, remove, markUsed };
}
