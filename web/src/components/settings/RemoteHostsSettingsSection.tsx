import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

import { AddRemoteHostDialog } from './AddRemoteHostDialog';

// Row shape projected by GET /api/remote-agents (credentials are never sent).
type RemoteHost = {
  host_id: string;
  name: string;
  host: string;
  port: number;
  ssh_user: string;
  os: string | null;
  status: 'offline' | 'online' | 'deploying' | 'error' | string;
  last_error: string | null;
  last_seen_at: string | null;
  online: boolean;
};

type HostsResponse = { data?: { hosts?: RemoteHost[] } };
type DeployResponse = { data?: { status?: string; message?: string } };

const POLL_INTERVAL_MS = 3000;
// After a deploy command completes, keep watching the row this long for the
// lite to actually connect back (green dot). Bounds the wait so a host that
// never dials back doesn't hold the button in 部署中… forever.
const ONLINE_GRACE_MS = 30_000;

// Combined display state of one host row. `status` is the PERSISTED bootstrap
// result; `online` is the LIVE registry connection. Both must be read together:
//   online=true                         → 真·在线（lite 已连回主站）
//   status=online 但 online=false       → 部署命令成功，lite 未连回 ← 最常见误读点
function deriveHostState(host: RemoteHost): {
  label: string;
  dotClass: string;
  hint?: string;
  hintTone: 'muted' | 'warn';
} {
  if (host.online) {
    return { label: '在线', dotClass: 'bg-green-500', hintTone: 'muted' };
  }
  switch (host.status) {
    case 'deploying':
      return {
        label: '部署中',
        dotClass: 'bg-amber-400 animate-pulse',
        hint: '正在推送 lite 到目标机，请等待…',
        hintTone: 'muted',
      };
    case 'online':
      return {
        label: '未连接',
        dotClass: 'bg-amber-500',
        hint: '部署命令已完成，但 lite 尚未连回主站。等待几秒后若无变化，请点「重新部署」'
          + '（并确认主站 LOVDEX_PUBLIC_WS_URL 指向本机对目标机可达的地址）。',
        hintTone: 'warn',
      };
    case 'error':
      return {
        label: '错误',
        dotClass: 'bg-red-500',
        hint: host.last_error ?? '部署失败',
        hintTone: 'warn',
      };
    case 'offline':
    default:
      return {
        label: '离线',
        dotClass: 'bg-gray-400',
        hint: '尚未部署或未在线，点「部署」上线',
        hintTone: 'muted',
      };
  }
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string } | string }
    | null;
  if (body && typeof body.error === 'object' && typeof body.error?.message === 'string') {
    return body.error.message;
  }
  if (body && typeof body.error === 'string') {
    return body.error;
  }
  return `${fallback}（${res.status}）`;
}

/**
 * 远程机器设置：添加（弹窗一键注入公钥+部署）、部署/删除远程 lite agent 主机。
 *
 * 部署成功与否的判定（直观信号）：
 *   - 绿点 + 「在线」= lite 已连回主站，真正可用；
 *   - 黄点 + 「未连接」= 部署命令完成但 lite 没连回（查 LOVDEX_PUBLIC_WS_URL 后重新部署）；
 *   - 红点 + 「错误」+ 红字原因 = 部署失败。
 * 点「重新部署」会重跑整条 ssh/scp/install 链路，期间按钮显示「部署中…」，
 * 部署完成后持续轮询至多 30s 观察 lite 是否连回，绿点会自动亮起。
 */
export function RemoteHostsSettingsSection() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add-host dialog.
  const [addOpen, setAddOpen] = useState(false);

  // Per-host transient action state.
  const [deployingIds, setDeployingIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  // Transient deploy outcome note (cleared on next deploy).
  const [deployNotes, setDeployNotes] = useState<Record<string, string>>({});

  // Synchronous double-click guard: a ref, not state — two clicks in the same
  // render tick would both see the same `deployingIds` value.
  const inFlightDeploys = useRef<Set<string>>(new Set());

  const loadHosts = useCallback(async (): Promise<RemoteHost[]> => {
    const res = await api.get('/remote-agents');
    if (!res.ok) {
      throw new Error(await readErrorMessage(res, '加载远程主机失败'));
    }
    const body = (await res.json()) as HostsResponse;
    const list = body.data?.hosts ?? [];
    setHosts(list);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadHosts()
      .then(() => {
        if (cancelled) return;
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [loadHosts]);

  const markDeploying = useCallback((hostId: string, on: boolean) => {
    setDeployingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  }, []);

  // Wait (polling GET /) up to `timeoutMs` for the host to reach a terminal,
  // intuitive state: lite connected (online=true) or bootstrap error. Resolves
  // on the deadline otherwise. loadHosts already refreshes the list on each
  // tick, so the dot/label/success signals update live as the lite dials back.
  function waitForTerminal(hostId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        void loadHosts()
          .then((list) => {
            const row = list.find((h) => h.host_id === hostId);
            const done =
              !row || row.online === true || row.status === 'error' || Date.now() >= deadline;
            if (done) {
              clearInterval(timer);
              resolve();
            }
          })
          .catch(() => {
            // Transient list errors during polling are non-fatal; keep polling.
          });
      }, POLL_INTERVAL_MS);
      void loadHosts()
        .then((list) => {
          const row = list.find((h) => h.host_id === hostId);
          if (!row || row.online === true || row.status === 'error') {
            clearInterval(timer);
            resolve();
          }
        })
        .catch(() => undefined);
    });
  }

  async function handleDeploy(host: RemoteHost) {
    if (inFlightDeploys.current.has(host.host_id)) return;
    inFlightDeploys.current.add(host.host_id);
    setActionError(null);
    setDeployNotes((prev) => {
      const next = { ...prev };
      delete next[host.host_id];
      return next;
    });
    markDeploying(host.host_id, true);
    try {
      const res = await api.post(`/remote-agents/${encodeURIComponent(host.host_id)}/deploy`, {});
      if (!res.ok) {
        setActionError(await readErrorMessage(res, `部署 ${host.name} 失败`));
        return;
      }
      (await res.json()) as DeployResponse;

      // The blocking deploy returned (row status already flipped off
      // 'deploying'). Keep watching so the definitive success signal — the lite
      // dialing back → green dot 「在线」— shows up on its own.
      await waitForTerminal(host.host_id, ONLINE_GRACE_MS);
      const refreshed = await loadHosts().catch(() => null);
      const row = refreshed?.find((h) => h.host_id === host.host_id);
      setDeployNotes((prev) => ({
        ...prev,
        [host.host_id]: row?.online
          ? '✓ 部署成功，lite 已连回主站'
          : '部署命令已执行完毕，lite 尚未连回主站（见上方状态提示）',
      }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '部署失败');
    } finally {
      inFlightDeploys.current.delete(host.host_id);
      markDeploying(host.host_id, false);
    }
  }

  async function handleDelete(host: RemoteHost) {
    if (!window.confirm(`确定删除远程主机「${host.name}」？该操作会断开其 lite agent 连接。`)) {
      return;
    }
    setActionError(null);
    try {
      const res = await api.delete(`/remote-agents/${encodeURIComponent(host.host_id)}`);
      if (!res.ok) {
        setActionError(await readErrorMessage(res, `删除 ${host.name} 失败`));
        return;
      }
      await loadHosts();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除失败');
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <div className="text-sm text-muted-foreground">{loadError}</div>
        <Button size="sm" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }
  if (!loaded) {
    return <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Add host */}
      <section className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">添加远程机器</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            一次点击完成注入公钥、注册、部署与状态检测。
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          添加远程机器
        </Button>
      </section>

      <AddRemoteHostDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => void loadHosts().catch(() => undefined)}
      />

      {/* Host list */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">已注册主机（{hosts.length}）</h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void loadHosts().catch(() => undefined)}
            title="刷新"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {actionError && <p className="text-xs text-red-500">{actionError}</p>}

        {hosts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            暂无远程机器
          </div>
        ) : (
          hosts.map((host) => {
            const state = deriveHostState(host);
            const isDeploying = host.status === 'deploying' || deployingIds.has(host.host_id);
            const lastSeen = formatRelativeTime(host.last_seen_at);
            // A host that has been deployed before (or failed) can be re-run —
            // relabel the button so the re-deploy affordance is obvious.
            const deployLabel = host.status === 'offline' ? '部署' : '重新部署';
            return (
              <div key={host.host_id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 flex-shrink-0 rounded-full ${state.dotClass}`}
                        title={state.label}
                      />
                      <span className="truncate text-sm font-medium text-foreground">{host.name}</span>
                      <span
                        className={
                          state.hintTone === 'warn'
                            ? 'text-xs font-medium text-amber-600'
                            : 'text-xs text-muted-foreground'
                        }
                      >
                        {state.label}
                      </span>
                      {lastSeen && (
                        <span className="text-xs text-muted-foreground">· 最后在线 {lastSeen}</span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {host.ssh_user}@{host.host}:{host.port}
                      {host.os ? ` · ${host.os}` : ''}
                    </div>
                    {deployNotes[host.host_id] && (
                      <div className="mt-1 text-xs text-emerald-600">{deployNotes[host.host_id]}</div>
                    )}
                    {state.hint && (
                      <div
                        className={`mt-1 text-xs ${
                          state.hintTone === 'warn' ? 'text-amber-600' : 'text-muted-foreground'
                        }`}
                        title={state.hint}
                      >
                        {state.hint.length > 120 ? `${state.hint.slice(0, 120)}…` : state.hint}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleDeploy(host)}
                      disabled={isDeploying}
                      title={isDeploying ? '部署进行中…' : '重新把 lite 部署到目标机'}
                    >
                      {isDeploying ? '部署中…' : deployLabel}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleDelete(host)}
                      disabled={isDeploying}
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}