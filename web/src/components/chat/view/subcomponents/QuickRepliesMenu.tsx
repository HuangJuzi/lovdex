import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';

import type { QuickReply } from '../../hooks/useQuickReplies';

const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 360;
const MENU_MIN_HEIGHT = 160;
const EDGE_GAP = 8;

type MenuPosition = { left: number; top: number; maxHeight: number };

/**
 * 工具栏按钮在屏幕底部，浮层必须向上弹（向下必然出屏）。
 * `top` 取按钮顶边再 `translateY(-100%)`，等效于「底边贴在按钮上方 EDGE_GAP 处」。
 */
function computePosition(anchor: HTMLElement | null): MenuPosition {
  if (!anchor || typeof window === 'undefined') {
    return { left: EDGE_GAP, top: 0, maxHeight: MENU_MAX_HEIGHT };
  }
  const rect = anchor.getBoundingClientRect();
  return {
    left: Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE_GAP)),
    top: rect.top - EDGE_GAP,
    maxHeight: Math.min(MENU_MAX_HEIGHT, Math.max(MENU_MIN_HEIGHT, rect.top - EDGE_GAP * 2)),
  };
}

type QuickRepliesMenuProps = {
  items: QuickReply[];
  isLoading: boolean;
  error: string | null;
  /** 工具栏按钮，用于定位与「点自己不算点外部」。 */
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSelect: (item: QuickReply) => void;
  onCreate: (content: string) => Promise<void>;
  onUpdate: (quickReplyId: string, content: string) => Promise<void>;
  onRemove: (quickReplyId: string) => Promise<void>;
};

type Draft = { id: string | null; content: string };

function QuickRepliesMenu({
  items,
  isLoading,
  error,
  anchorRef,
  onClose,
  onSelect,
  onCreate,
  onUpdate,
  onRemove,
}: QuickRepliesMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition>(() => computePosition(anchorRef.current));
  // id === null 表示「新增」，有 id 表示编辑该条。
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const updatePosition = useCallback(() => {
    setPosition(computePosition(anchorRef.current));
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  // Escape：编辑态先退出编辑，否则关浮层。用 window capture 抢在 ChatInterface 的
  // 全局 Escape（那会中断会话）之前，并 preventDefault 让它跳过。
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (draft) {
        setDraft(null);
        setActionError(null);
        return;
      }
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [anchorRef, draft, onClose]);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    const content = draft.content.trim();
    if (!content) {
      setActionError('常用语内容不能为空');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      if (draft.id) {
        await onUpdate(draft.id, content);
      } else {
        await onCreate(content);
      }
      setDraft(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [draft, onCreate, onUpdate]);

  const handleDelete = useCallback(
    async (quickReplyId: string) => {
      setActionError(null);
      try {
        await onRemove(quickReplyId);
        // 删掉的可能正是当前编辑中的那一条，顺手退出编辑态。
        setDraft((current) => (current?.id === quickReplyId ? null : current));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '删除失败');
      }
    },
    [onRemove],
  );

  const startEditing = useCallback((item: QuickReply) => {
    setActionError(null);
    setDraft({ id: item.quick_reply_id, content: item.content });
  }, []);

  const startCreating = useCallback(() => {
    setActionError(null);
    setDraft({ id: null, content: '' });
  }, []);

  const message = actionError || error;

  // key 与「正在编辑的是哪一条」绑定：从「编辑 A」直接点「编辑 B」时，React 会复用
  // 同位置的 EditorRow，而它的 textarea 值是组件内部 state（只由 initialContent 初始化
  // 一次），不加 key 会留住 A 的文本。这条是计划代码漏掉的，实现时补上。
  const editorRow = (draftId: string | null) => (
    <EditorRow
      key={`editor-${draftId ?? 'new'}`}
      initialContent={draft?.content ?? ''}
      busy={busy}
      onChange={(content) => setDraft({ id: draftId, content })}
      onSave={() => void handleSave()}
      onCancel={() => setDraft(null)}
    />
  );

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      aria-label="常用语"
      className="fixed z-[100] overflow-y-auto rounded-lg border border-border bg-card shadow-lg"
      style={{
        left: position.left,
        top: position.top,
        width: MENU_WIDTH,
        maxHeight: position.maxHeight,
        transform: 'translateY(-100%)',
      }}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">常用语</span>
        {!draft && (
          <button
            type="button"
            onClick={startCreating}
            className="flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
          >
            <Plus className="h-3 w-3" />
            新建
          </button>
        )}
      </div>

      {message && (
        <div className="border-b border-border/50 bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          {message}
        </div>
      )}

      {isLoading && items.length === 0 && (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">加载中…</div>
      )}

      {!isLoading && items.length === 0 && !draft && (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">还没有常用语</div>
      )}

      {/* 新增态挂在列表最前面：「新建」按钮在 header，编辑行却在末尾会让视线跳一大截。 */}
      {draft && draft.id === null && editorRow(null)}

      {items.map((item) => (
        draft && draft.id === item.quick_reply_id ? (
          <div key={item.quick_reply_id}>{editorRow(item.quick_reply_id)}</div>
        ) : (
          <div
            key={item.quick_reply_id}
            className="group flex items-center gap-1 border-b border-border/50 px-2 py-1.5 last:border-b-0 hover:bg-accent/60"
          >
            <button
              type="button"
              onClick={() => onSelect(item)}
              title={item.content}
              className="flex-1 truncate text-left text-xs text-foreground"
            >
              {item.content}
            </button>
            <button
              type="button"
              aria-label="编辑常用语"
              title="编辑"
              onClick={() => startEditing(item)}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="删除常用语"
              title="删除"
              onClick={() => void handleDelete(item.quick_reply_id)}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )
      ))}
    </div>,
    document.body,
  );
}

function EditorRow({
  initialContent,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  initialContent: string;
  busy: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialContent);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="border-b border-border/50 px-2 py-2 last:border-b-0">
      <textarea
        ref={textareaRef}
        value={value}
        rows={2}
        placeholder="输入常用语，Enter 保存，Shift+Enter 换行"
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSave();
          }
        }}
        className="w-full resize-none rounded border border-border bg-muted/40 p-2 text-xs text-foreground outline-none focus:border-primary"
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded px-2 py-1 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-2xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Check className="h-3 w-3" />
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

export default QuickRepliesMenu;
