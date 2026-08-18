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
type DeployResponse = { data?: { status?: string; message?: string } };

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

  // HostId minted by a SUCCESSFUL register. Once set, a retry skips register
  // (and never re-demands a password) and only re-runs deploy — re-registering
  // on retry would leak a duplicate row per attempt.
  const [registeredHostId, setRegisteredHostId] = useState<string | null>(null);

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
    setRegisteredHostId(null);
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

  // Poll GET / until the host reaches a TERMINAL status (online or error).
  // The row defaults to 'offline' before the deploy handler flips it to
  // 'deploying', so a non-terminal status must NEVER settle the poll — a stale
  // 'offline' snapshot would misclassify a successful deploy as failed.
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
            const terminal =
              !!row && (row.online === true || row.status === 'online' || row.status === 'error');
            if (terminal) {
              stopPolling();
              resolve(row);
            }
            // Row missing / still 'deploying' / still 'offline' → keep polling.
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
    const portNum = Number.parseInt(port, 10);
    const portValue = Number.isInteger(portNum) && portNum > 0 ? portNum : 22;

    setRunning(true);
    setError(null);
    try {
      // 1. Register — only when the row was never minted. A retry after a
      //    successful register reuses the stored hostId so it just re-deploys
      //    (no duplicate row, no password re-entry).
      let hostId = registeredHostId;
      if (!hostId) {
        if (authType === 'password' && !password) {
          setError('密码认证需要填写密码');
          return;
        }
        // Password mode injects the Lovdex pubkey server-side first.
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
        hostId = registerBody.data?.hostId ?? null;
        if (!hostId) {
          setError('服务端未返回 hostId');
          return;
        }
        // Register succeeded → this hostId is reused by retries. The one-time
        // password is consumed; drop it from state so it never lingers in memory.
        setRegisteredHostId(hostId);
        setPassword('');
      }

      // 2. Deploy (blocking ssh/scp). Await the response FIRST so the server's
      //    'deploying' → terminal flip is already committed when the poll starts;
      //    the deploy response carries the authoritative classification.
      setPhase('部署中…');
      const deployRes = await api.post(`/remote-agents/${encodeURIComponent(hostId)}/deploy`, {});
      if (!deployRes.ok) {
        setError(await readErrorMessage(deployRes, '部署失败'));
        return;
      }
      const deployBody = (await deployRes.json()) as DeployResponse;
      const deployStatus = deployBody.data?.status;
      const deployMessage = deployBody.data?.message;

      // Safety-net poll: confirm the list reflects a TERMINAL status (it settled
      // instantly here since deploy already flipped the row).
      setPhase('检测中…');
      const terminalRow = await pollUntilSettled(hostId);
      if (!activeRef.current) return;

      // 3. Classify. 'online' from the deploy response is authoritative; the
      //    polled row corroborates it and carries the persisted last_error.
      if (deployStatus === 'online' || terminalRow?.online || terminalRow?.status === 'online') {
        onAdded();
        onClose();
        return;
      }

      const lastError = terminalRow?.last_error ? truncate(terminalRow.last_error) : deployMessage ?? '';
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
        aria-labelledby="add-remote-host-dialog-title"
        onEscapeKeyDown={() => {
          if (!running) onClose();
        }}
        onPointerDownOutside={() => {
          if (!running) onClose();
        }}
      >
        <DialogTitle>添加远程机器</DialogTitle>
        <h2
          id="add-remote-host-dialog-title"
          className="mb-4 text-base font-semibold text-foreground"
        >
          添加远程机器
        </h2>

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
