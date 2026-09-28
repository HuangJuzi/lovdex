import { useCallback, useEffect, useState } from 'react';

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

  const refresh = useCallback(async () => {
    try {
      const response = (await api.quickReplies.list()) as Response;
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const payload = (await response.json()) as { items?: QuickReply[] };
      setItems(Array.isArray(payload?.items) ? payload.items : []);
      setError(null);
    } catch {
      setError('无法加载常用语');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
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
          if (response.ok) void refresh();
        })
        .catch(() => undefined);
    },
    [refresh],
  );

  return { items, isLoading, error, create, update, remove, markUsed };
}
