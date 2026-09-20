import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../shared/view/ui';
import { api } from '../../utils/api';
import { describeSkillStatus, type AlertSkillStatus } from './inboxSkillStatus';

/**
 * 「收件箱技能」设置区块：把 lovdex-alert 上报约定装进 ~/.claude/skills，
 * 任务会话即可在描述里说"放到收件箱"就触发通知。装/卸/更新共用同一操作
 * （后端 addSkills 先 rm 再写，天然幂等）。
 */
export function InboxSkillSettings() {
  const [status, setStatus] = useState<AlertSkillStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.notifications.skillStatus();
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as AlertSkillStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as AlertSkillStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <Card>
        <CardHeader><CardTitle>收件箱技能</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{error ?? '加载中…'}</CardContent>
      </Card>
    );
  }

  const view = describeSkillStatus(status);

  return (
    <Card className={view.highlight ? 'border-warning' : undefined}>
      <CardHeader>
        <CardTitle>收件箱技能</CardTitle>
        <CardDescription>
          把 <code>lovdex-alert</code> 上报约定装进系统 skill 目录（<code>~/.claude/skills</code>）。
          装好后，任务描述里写「有问题放到收件箱」即可自动触发通知，不用再手抄格式。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">{view.versionLine}</div>
        <div className="break-all text-xs text-muted-foreground">{status.skillPath}</div>
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void run(api.notifications.skillInstall)}>
            {view.primaryLabel}
          </Button>
          {view.switchOn ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(api.notifications.skillUninstall)}>
              卸载
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default InboxSkillSettings;
