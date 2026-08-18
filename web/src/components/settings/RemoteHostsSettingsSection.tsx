import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { api } from '../../utils/api';
import { copyTextToClipboard } from '../../utils/clipboard';
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
type PubkeyResponse = { data?: { publicKey?: string } };
type DeployResponse = { data?: { status?: string; message?: string } };

const POLL_INTERVAL_MS = 3000;

function statusLabel(host: RemoteHost): string {
  switch (host.status) {
    case 'online':
      return '在线';
    case 'offline':
      return '离线';
    case 'deploying':
      return '部署中';
    case 'error':
      return '错误';
    default:
      return host.status;
  }
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
 * 远程机器设置：注册/部署/删除远程 lite agent 主机，并展示 Lovdex 公钥以便
 * 手动写入目标机 authorized_keys。部署是阻塞式 ssh 调用，发起后本地进入
 * "部署中…" 并每 ~3s 轮询 GET / 直到状态不再是 deploying。
 */
export function RemoteHostsSettingsSection() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [publicKey, setPublicKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add-host dialog.
  const [addOpen, setAddOpen] = useState(false);

  const [pubkeyCopied, setPubkeyCopied] = useState(false);
  // Per-host transient action state.
  const [deployingIds, setDeployingIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

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
    Promise.all([
      loadHosts(),
      api.get('/remote-agents/pubkey').then(async (res) => {
        if (!res.ok) return '';
        const body = (await res.json()) as PubkeyResponse;
        return body.data?.publicKey ?? '';
      }),
    ])
      .then(([, key]) => {
        if (cancelled) return;
        setPublicKey(key);
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

  // Clear any pending poll intervals on unmount.
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      timers.forEach((timer) => clearInterval(timer));
      timers.clear();
    };
  }, []);

  const markDeploying = useCallback((hostId: string, on: boolean) => {
    setDeployingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  }, []);

  const startPolling = useCallback(
    (hostId: string) => {
      if (pollTimers.current.has(hostId)) return;
      const timer = setInterval(() => {
        void loadHosts()
          .then((list) => {
            const row = list.find((h) => h.host_id === hostId);
            if (!row || row.status !== 'deploying') {
              clearInterval(timer);
              pollTimers.current.delete(hostId);
              markDeploying(hostId, false);
            }
          })
          .catch(() => {
            // Transient list errors during polling are non-fatal; keep polling.
          });
      }, POLL_INTERVAL_MS);
      pollTimers.current.set(hostId, timer);
    },
    [loadHosts, markDeploying],
  );

  async function handleDeploy(host: RemoteHost) {
    // Synchronous double-click guard: the poll timer for this host is set before
    // the blocking deploy resolves, so a second click must be a no-op.
    if (pollTimers.current.has(host.host_id)) return;
    setActionError(null);
    markDeploying(host.host_id, true);
    // Poll while the blocking deploy runs so the row status reflects progress.
    startPolling(host.host_id);
    try {
      const res = await api.post(`/remote-agents/${encodeURIComponent(host.host_id)}/deploy`, {});
      if (!res.ok) {
        setActionError(await readErrorMessage(res, `部署 ${host.name} 失败`));
        return;
      }
      (await res.json()) as DeployResponse;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '部署失败');
    } finally {
      // The blocking call returned; stop the poll loop and refresh once more.
      const timer = pollTimers.current.get(host.host_id);
      if (timer) {
        clearInterval(timer);
        pollTimers.current.delete(host.host_id);
      }
      markDeploying(host.host_id, false);
      await loadHosts().catch(() => undefined);
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

  async function copyPubkey() {
    const ok = await copyTextToClipboard(publicKey);
    if (ok) {
      setPubkeyCopied(true);
      window.setTimeout(() => setPubkeyCopied(false), 1500);
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
      {/* Public key */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Lovdex 公钥</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          将下列公钥追加到目标机的 <code>~/.ssh/authorized_keys</code>，Lovdex 才能通过 SSH 部署 lite agent。
        </p>
        <div className="flex items-start gap-2">
          <textarea
            readOnly
            value={publicKey || '（未生成公钥）'}
            className="h-16 w-full resize-none rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyPubkey()}
            disabled={!publicKey}
            title="复制公钥"
          >
            {pubkeyCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </section>

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
            const isDeploying = host.status === 'deploying' || deployingIds.has(host.host_id);
            return (
              <div key={host.host_id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 flex-shrink-0 rounded-full ${
                          host.online ? 'bg-green-500' : 'bg-gray-400'
                        }`}
                        title={host.online ? '在线' : '离线'}
                      />
                      <span className="truncate text-sm font-medium text-foreground">{host.name}</span>
                      <span className="text-xs text-muted-foreground">{statusLabel(host)}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {host.ssh_user}@{host.host}:{host.port}
                      {host.os ? ` · ${host.os}` : ''}
                    </div>
                    {host.last_error && (
                      <div
                        className="mt-1 truncate text-xs text-red-500"
                        title={host.last_error}
                      >
                        {host.last_error.length > 120
                          ? `${host.last_error.slice(0, 120)}…`
                          : host.last_error}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleDeploy(host)}
                      disabled={isDeploying}
                    >
                      {isDeploying ? '部署中…' : '部署'}
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
