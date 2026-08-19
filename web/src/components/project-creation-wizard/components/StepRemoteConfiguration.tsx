import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Folder, Loader2, RefreshCw } from 'lucide-react';

import { browseRemoteDirs, fetchOnlineRemoteHosts } from '../data/workspaceApi';
import type { RemoteDirEntry, RemoteHostOption } from '../types';

type StepRemoteConfigurationProps = {
  remoteHostId: string;
  workspacePath: string;
  isCreating: boolean;
  onRemoteHostChange: (hostId: string, hostName: string) => void;
  onWorkspacePathChange: (path: string) => void;
};

// Joins a parent dir with a child name into a POSIX absolute path.
function joinRemotePath(parent: string, name: string): string {
  if (!parent || parent === '/') return `/${name}`;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

/**
 * 远程建项目配置：选择在线远程主机 + 通过 GET /:hostId/dirs 逐级浏览远程目录，
 * 或直接输入绝对路径。选中的目录写入 workspacePath。
 */
export default function StepRemoteConfiguration({
  remoteHostId,
  workspacePath,
  isCreating,
  onRemoteHostChange,
  onWorkspacePathChange,
}: StepRemoteConfigurationProps) {
  const [hosts, setHosts] = useState<RemoteHostOption[]>([]);
  const [hostsLoading, setHostsLoading] = useState(true);
  const [hostsError, setHostsError] = useState<string | null>(null);

  const [browsePath, setBrowsePath] = useState('~');
  const [dirs, setDirs] = useState<RemoteDirEntry[]>([]);
  const [dirsLoading, setDirsLoading] = useState(false);
  const [dirsError, setDirsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHostsLoading(true);
    fetchOnlineRemoteHosts()
      .then((list) => {
        if (cancelled) return;
        setHosts(list);
        setHostsError(null);
        // Auto-select the only online host to save a click.
        if (!remoteHostId && list.length === 1) {
          onRemoteHostChange(list[0].hostId, list[0].name);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHostsError(err instanceof Error ? err.message : '加载远程主机失败');
      })
      .finally(() => {
        if (!cancelled) setHostsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [remoteHostId, onRemoteHostChange]);

  const loadDirs = useCallback(
    (hostId: string, targetPath: string) => {
      if (!hostId) return;
      setDirsLoading(true);
      setDirsError(null);
      browseRemoteDirs(hostId, targetPath)
        .then(({ path, dirs }) => {
          setDirs(dirs.filter((entry) => entry.type === 'dir' || entry.type === 'directory'));
          // The lite resolves '~' server-side; adopt the REAL absolute path so
          // subsequent drill/up joins never lose the /home/<user> prefix.
          setBrowsePath(path || targetPath);
        })
        .catch((err: unknown) => {
          setDirsError(err instanceof Error ? err.message : '浏览目录失败');
        })
        .finally(() => setDirsLoading(false));
    },
    [],
  );

  // Reset + load the browser root whenever the selected host changes.
  useEffect(() => {
    if (!remoteHostId) {
      setDirs([]);
      return;
    }
    loadDirs(remoteHostId, '~');
  }, [remoteHostId, loadDirs]);

  const drillInto = (name: string) => {
    const next = joinRemotePath(browsePath === '~' ? '' : browsePath, name);
    // Selecting a folder both drills in AND stages it as the project path.
    onWorkspacePathChange(next);
    loadDirs(remoteHostId, next);
  };

  const goUp = () => {
    if (browsePath === '~' || browsePath === '/' || browsePath === '') return;
    const trimmed = browsePath.replace(/\/+$/, '');
    const parent = trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
    loadDirs(remoteHostId, parent);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          远程主机
        </label>
        {hostsLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : hostsError ? (
          <p className="text-sm text-red-500">{hostsError}</p>
        ) : hosts.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            暂无在线远程主机，请先在「设置 → 远程机器」中添加并部署。
          </p>
        ) : (
          <select
            className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            value={remoteHostId}
            disabled={isCreating}
            onChange={(e) => {
              const selected = hosts.find((host) => host.hostId === e.target.value);
              onRemoteHostChange(e.target.value, selected?.name ?? '');
            }}
          >
            <option value="">请选择主机…</option>
            {hosts.map((host) => (
              <option key={host.hostId} value={host.hostId}>
                {host.name}（{host.host}:{host.port}）
              </option>
            ))}
          </select>
        )}
      </div>

      {remoteHostId && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              远程路径
            </label>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              onClick={() => loadDirs(remoteHostId, browsePath)}
              disabled={dirsLoading}
              title="刷新"
            >
              <RefreshCw className={`h-3 w-3 ${dirsLoading ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>

          <input
            className="mb-2 h-9 w-full rounded-md border border-gray-300 bg-white px-2 font-mono text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            value={workspacePath}
            placeholder="/home/user/project 或从下方选择"
            disabled={isCreating}
            onChange={(e) => onWorkspacePathChange(e.target.value)}
          />

          <div className="rounded-md border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between border-b border-gray-200 px-2 py-1.5 dark:border-gray-700">
              <span className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                {browsePath}
              </span>
              <button
                type="button"
                className="text-xs text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
                onClick={goUp}
                disabled={dirsLoading || browsePath === '~' || browsePath === '/'}
              >
                上一级
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {dirsLoading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-gray-500 dark:text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  加载中…
                </div>
              ) : dirsError ? (
                <p className="px-2 py-3 text-sm text-red-500">{dirsError}</p>
              ) : dirs.length === 0 ? (
                <p className="px-2 py-3 text-sm text-gray-500 dark:text-gray-400">（无子目录）</p>
              ) : (
                dirs.map((dir) => (
                  <button
                    key={dir.name}
                    type="button"
                    className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                    onClick={() => drillInto(dir.name)}
                    disabled={isCreating}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Folder className="h-4 w-4 flex-shrink-0 text-blue-500" />
                      {dir.name}
                    </span>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400" />
                  </button>
                ))
              )}
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            点击目录可进入并选中为项目路径，或直接在上方输入绝对路径。
          </p>
        </div>
      )}
    </div>
  );
}
