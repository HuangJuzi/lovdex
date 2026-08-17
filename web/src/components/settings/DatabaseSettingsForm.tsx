import { useEffect, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

type DatabaseConfig = { database?: { path?: string } };

/**
 * 数据库路径设置。后端 `GET /api/config` 读 `database.path`、`PUT /api/config`
 * 写。数据库连接在 boot 时建立，保存后需重启后端才生效（与端口/host 同等待遇）。
 */
export function DatabaseSettingsForm() {
  const [path, setPath] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/config')
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const cfg = (await res.json()) as DatabaseConfig;
        if (!cancelled) {
          setPath(cfg.database?.path ?? '');
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    try {
      const res = await api.put('/config', { database: { path: path.trim() } });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error?.message ?? err?.error ?? `保存失败（${res.status}）`);
        return;
      }
      setSavedMsg('已保存。数据库路径修改需重启后端生效。');
    } catch (err) {
      setSaveError((err as Error).message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <div className="text-sm text-muted-foreground">加载配置失败</div>
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
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">数据库路径</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          后端 SQLite 数据库文件位置。保存后需重启后端生效。
        </p>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            数据库路径 (database.path)
          </label>
          <input
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={path}
            placeholder="~/.lovdex/data/auth.db"
            onChange={(e) => {
              setSavedMsg(null);
              setPath(e.target.value);
            }}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {savedMsg && !saveError && (
          <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>
        )}
        {saveError && <span className="text-xs text-red-500">{saveError}</span>}
      </div>
    </div>
  );
}
