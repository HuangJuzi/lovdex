import { useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';
import { Dialog, DialogContent, DialogTitle } from '../../shared/view/ui/Dialog';

type RemoteHost = {
  host_id: string;
  status: string;
  last_error: string | null;
  online: boolean;
};

type HostsResponse = { data?: { hosts?: RemoteHost[] } };
type AddHostResponse = { data?: { hostId?: string } };

type AuthType = 'password' | 'key';

const POLL_INTERVAL_MS = 3000;

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

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface AddRemoteHostDialogProps {
  open: boolean;
  onClose(): void;
  onAdded(): void;
}

/**
 * 一步式添加远程机器：一次点击串联「注入公钥 → 注册 → 部署 → 轮询状态」。
 *
 * 密码认证模式下，密码只用于一次性把 Lovdex 公钥写入目标机 authorized_keys
 * （等价 ssh-copy-id），后端注入成功后即丢弃，绝不落库。此后所有 ssh/scp 走
 * Lovdex 密钥。若目标机已装好公钥，可选「已装 Lovdex 公钥」跳过注入。
 */
export function AddRemoteHostDialog({ open, onClose, onAdded }: AddRemoteHostDialogProps) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [sshUser, setSshUser] = useState('');
  const [authType, setAuthType] = useState<AuthType>('password');
  const [password, setPassword] = useState('');

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Guards against setState after the dialog closes/unmounts mid-poll.
  const activeRef = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, []);

  // Reset the form whenever the dialog is (re)opened.
  useEffect(() => {
    if (!open) return;
    setName('');
    setHost('');
    setPort('22');
    setSshUser('');
    setAuthType('password');
    setPassword('');
    setRunning(false);
    setPhase('');
    setError(null);
  }, [open]);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  // Poll GET / until the target host leaves the 'deploying' status, then
  // classify online vs. error. Stops on unmount/close via activeRef.
  function pollUntilSettled(hostId: string): Promise<RemoteHost | null> {
    return new Promise((resolve) => {
      const tick = () => {
        void api
          .get('/remote-agents')
          .then(async (res) => {
            if (!res.ok) return; // transient list error → keep polling
            const body = (await res.json()) as HostsResponse;
            const row = (body.data?.hosts ?? []).find((h) => h.host_id === hostId) ?? null;
            if (!activeRef.current) {
              stopPolling();
              resolve(null);
              return;
            }
            if (!row || row.status !== 'deploying') {
              stopPolling();
              resolve(row);
            }
          })
          .catch(() => {
            // Non-fatal during polling; keep trying.
          });
      };
      pollTimer.current = setInterval(tick, POLL_INTERVAL_MS);
      tick();
    });
  }

  async function run() {
    const trimmedName = name.trim();
    const trimmedHost = host.trim();
    const trimmedSshUser = sshUser.trim();
    if (!trimmedName || !trimmedHost || !trimmedSshUser) {
      setError('名称、主机、SSH 用户均为必填');
      return;
    }
    if (authType === 'password' && !password) {
      setError('密码认证需要填写密码');
      return;
    }
    const portNum = Number.parseInt(port, 10);
    const portValue = Number.isInteger(portNum) && portNum > 0 ? portNum : 22;

    setRunning(true);
    setError(null);
    try {
      // 1. Register (password mode injects the pubkey server-side first).
      setPhase(authType === 'password' ? '注入公钥中…' : '注册中…');
      const registerRes = await api.post('/remote-agents', {
        name: trimmedName,
        host: trimmedHost,
        port: portValue,
        sshUser: trimmedSshUser,
        authType,
        ...(authType === 'password' ? { password } : {}),
      });
      if (!registerRes.ok) {
        setError(await readErrorMessage(registerRes, '添加失败'));
        return;
      }
      const registerBody = (await registerRes.json()) as AddHostResponse;
      const hostId = registerBody.data?.hostId;
      if (!hostId) {
        setError('服务端未返回 hostId');
        return;
      }
      // Password consumed; drop it from state so it never lingers in memory.
      setPassword('');

      // 2. Deploy (blocking ssh/scp), poll while it runs.
      setPhase('部署中…');
      const deployPromise = api.post(`/remote-agents/${encodeURIComponent(hostId)}/deploy`, {});
      const settled = await pollUntilSettled(hostId);
      // Ensure the blocking deploy call finished (may resolve after the poll).
      const deployRes = await deployPromise.catch(() => null);
      if (!activeRef.current) return;

      const finalRow =
        settled ??
        (await (async () => {
          const res = await api.get('/remote-agents').catch(() => null);
          if (!res || !res.ok) return null;
          const body = (await res.json()) as HostsResponse;
          return (body.data?.hosts ?? []).find((h) => h.host_id === hostId) ?? null;
        })());

      if (deployRes && !deployRes.ok && !finalRow) {
        setError(await readErrorMessage(deployRes, '部署失败'));
        return;
      }

      // 3. Classify the outcome.
      if (finalRow && (finalRow.online || finalRow.status === 'online')) {
        onAdded();
        onClose();
        return;
      }

      const lastError = finalRow?.last_error ? truncate(finalRow.last_error) : '';
      setError(lastError || '部署未成功，主机未上线');
      // The host row exists (registered) — refresh the list so it shows up.
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      stopPolling();
      if (activeRef.current) {
        setRunning(false);
        setPhase('');
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !running && onClose()}>
      <DialogContent
        className="max-w-md p-5"
        onEscapeKeyDown={() => {
          if (!running) onClose();
        }}
        onPointerDownOutside={() => {
          if (!running) onClose();
        }}
      >
        <DialogTitle>添加远程机器</DialogTitle>
        <h2 className="mb-4 text-base font-semibold text-foreground">添加远程机器</h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">名称</label>
            <input
              className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
              value={name}
              placeholder="dev-box"
              disabled={running}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">主机</label>
              <input
                className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                value={host}
                placeholder="10.0.0.7"
                disabled={running}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div className="w-24">
              <label className="mb-1 block text-xs text-muted-foreground">端口</label>
              <input
                type="number"
                className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                value={port}
                placeholder="22"
                disabled={running}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">SSH 用户</label>
            <input
              className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
              value={sshUser}
              placeholder="root"
              disabled={running}
              onChange={(e) => setSshUser(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">认证方式</label>
            <div className="flex gap-4 text-sm text-foreground">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="authType"
                  checked={authType === 'password'}
                  disabled={running}
                  onChange={() => setAuthType('password')}
                />
                密码（一次性注入公钥）
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="authType"
                  checked={authType === 'key'}
                  disabled={running}
                  onChange={() => setAuthType('key')}
                />
                已装 Lovdex 公钥
              </label>
            </div>
          </div>

          {authType === 'password' && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">密码</label>
              <input
                type="password"
                autoComplete="off"
                className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                value={password}
                placeholder="仅用于一次性写入公钥，不会保存"
                disabled={running}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>
              {error ? '关闭' : '取消'}
            </Button>
            <Button size="sm" onClick={() => void run()} disabled={running}>
              {running ? phase || '处理中…' : error ? '重试' : '添加并部署'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
