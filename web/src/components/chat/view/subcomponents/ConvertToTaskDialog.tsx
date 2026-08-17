import { useEffect, useRef, useState } from 'react';

import { Button, Dialog, DialogContent, Input } from '../../../../shared/view/ui';
import { STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER, LABEL_META, LABEL_ORDER } from '../../../tasks/taskStatus';
import { api } from '../../../../utils/api';
import type { ProjectSession, TaskEngine, TaskStatus, TaskPriority, TaskLabel } from '../../../../types/app';
import { buildSessionToTaskPayload } from './convertToTaskPayload';

type ConvertToTaskDialogProps = {
  session: ProjectSession | null;
  projectPath: string;
  isRunning: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ConvertToTaskDialog({
  session,
  projectPath,
  isRunning,
  open,
  onOpenChange,
}: ConvertToTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // executorProvider + executorModel are determined from the session (its
  // provider / current model) and carried silently into the create body — the
  // dialog never renders them as editable fields.
  const [executorProvider, setExecutorProvider] = useState<TaskEngine>('claude');
  const [executorModel, setExecutorModel] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [label, setLabel] = useState<TaskLabel>('other');
  const [deadline, setDeadline] = useState('');
  const [remark, setRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed form state only when the dialog transitions to open (fresh conversion
  // or a different session). Mid-open changes to `isRunning` / `session`
  // (e.g. the session completes while the user is typing) must not clobber the
  // user's edits, so this does NOT re-seed on those dep changes while open.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    const defaults = buildSessionToTaskPayload({ session, isRunning });
    setTitle(defaults.title);
    setDescription(defaults.description);
    setExecutorProvider(defaults.executorProvider);
    setExecutorModel(defaults.executorModel);
    setStatus(defaults.status);
    setPriority(defaults.priority);
    setLabel(defaults.label);
    setDeadline(defaults.deadline);
    setRemark(defaults.remark);
    setError(null);
  }, [open, session, isRunning]);

  async function handleCreate() {
    if (!session || submitting) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.tasks.create({
        projectPath,
        title: trimmedTitle,
        description: description.trim() || null,
        executorProvider,
        executorModel: executorModel.trim() || null,
        status,
        priority,
        label,
        deadline: deadline || null,
        remark: remark.trim() || null,
        sessionId: session.id,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        // 409 + SESSION_ALREADY_LINKED = the session is already linked
        // (concurrent double-click / another tab). The existing link surfaces
        // via useLinkedTask, so just close. Any other error (including
        // SESSION_PROJECT_MISMATCH, also 409) keeps the form open with a message.
        if (body?.error?.code === 'SESSION_ALREADY_LINKED') {
          onOpenChange(false);
          return;
        }
        setError(body?.error?.message ?? `创建失败 (${res.status})`);
        return;
      }
      onOpenChange(false);
    } catch (err) {
      setError('创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  const selectClass = 'h-10 rounded-xl border-2 border-border bg-card px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-lg p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">转为任务</h2>
        <div className="flex flex-col gap-3 pt-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">标题</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题" autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">描述</span>
            <textarea
              className="min-h-[64px] w-full resize-y rounded-xl border-2 border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-primary/60"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="任务描述"
              rows={3}
            />
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">状态</span>
              <select
                className={selectClass}
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">优先级</span>
              <select
                className={selectClass}
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
              >
                {PRIORITY_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_META[p].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">标签</span>
              <select
                className={selectClass}
                value={label}
                onChange={(e) => setLabel(e.target.value as TaskLabel)}
              >
                {LABEL_ORDER.map((l) => (
                  <option key={l} value={l}>
                    {LABEL_META[l].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">截止时间</span>
              <input
                type="date"
                className="h-10 rounded-xl border-2 border-border bg-card px-2 text-sm text-foreground"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">备注</span>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="需求来源等，可留空" />
          </label>
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button size="sm" disabled={!title.trim() || submitting} onClick={() => void handleCreate()}>
            创建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
