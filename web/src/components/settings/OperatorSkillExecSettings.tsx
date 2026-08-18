import { useCallback, useEffect, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

/**
 * Operator 技能就地执行（execute_skill / workbench）设置区块：
 * 技能白名单、凭证管理、执行审计。挂在 Operator Agent 设置 Tab 下方。
 * 凭证只写入后端（~/.claw/cred.json 0600），任何接口都不回显明文。
 */

type AllowlistSkill = {
  name: string;
  entry: string;
  runner: string;
  allowed_subcommands: string[];
  readonly_subcommands?: string[];
};

type AllowlistPayload = {
  allowlist: {
    enabled_skills: AllowlistSkill[];
    workbench_write_prefixes: string[];
  };
  source: 'env' | 'database' | 'file' | 'default';
  envOverrideActive: boolean;
};

const SOURCE_LABELS: Record<AllowlistPayload['source'], string> = {
  env: '环境变量（最高优先）',
  database: '设置页保存',
  file: '配置文件',
  default: '内建默认',
};

function AllowlistSection() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [source, setSource] = useState<AllowlistPayload['source']>('default');
  const [envOverrideActive, setEnvOverrideActive] = useState(false);
  const [skillsText, setSkillsText] = useState('[]');
  const [prefixesText, setPrefixesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.operator.getAllowlist();
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as AllowlistPayload;
      setSource(data.source);
      setEnvOverrideActive(data.envOverrideActive);
      setSkillsText(JSON.stringify(data.allowlist.enabled_skills, null, 2));
      setPrefixesText(data.allowlist.workbench_write_prefixes.join('\n'));
      setLoaded(true);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setMessage(null);
    let skills: AllowlistSkill[];
    try {
      skills = JSON.parse(skillsText) as AllowlistSkill[];
      if (!Array.isArray(skills)) throw new Error('not an array');
    } catch {
      setSaving(false);
      setMessage({ kind: 'err', text: '技能列表 JSON 解析失败，请检查格式（应为数组）。' });
      return;
    }
    const body = {
      enabled_skills: skills,
      workbench_write_prefixes: prefixesText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      const res = await api.operator.updateAllowlist(body);
      const data = await res.json().catch(() => null);
      if (res.status === 409) {
        setMessage({ kind: 'err', text: data?.error?.message ?? 'env 覆盖生效中，保存未生效。' });
        return;
      }
      if (!res.ok) {
        setMessage({ kind: 'err', text: data?.error?.message ?? `保存失败（${res.status}）` });
        return;
      }
      setMessage({ kind: 'ok', text: '已保存，立即生效（无需重启）。' });
      await load();
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await api.operator.resetAllowlist();
      if (!res.ok) throw new Error(String(res.status));
      setMessage({ kind: 'ok', text: '已清除设置页保存的配置，回退到配置文件/内建默认。' });
      await load();
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">技能白名单</h2>
        <div className="flex items-center gap-3 py-2">
          <span className="text-sm text-muted-foreground">加载失败</span>
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">技能白名单</h2>
        {loaded && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            生效来源：{SOURCE_LABELS[source]}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        execute_skill 只能跑 enabled_skills 里的技能与子命令；workbench
        写操作只允许落在写前缀内。白名单外的调用一律拒绝并记审计。
      </p>
      {envOverrideActive && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
          环境变量白名单覆盖生效中（LOVDEX_OPERATOR_ALLOWLIST_JSON / _PATH），此处保存不会生效。
        </div>
      )}
      {!loaded ? (
        <div className="py-4 text-center text-sm text-muted-foreground">加载中…</div>
      ) : (
        <>
          <label className="mb-1 block text-xs text-muted-foreground">
            enabled_skills（JSON 数组：name / entry / runner / allowed_subcommands /
            readonly_subcommands）
          </label>
          <textarea
            className="mb-3 min-h-[180px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
            value={skillsText}
            onChange={(e) => setSkillsText(e.target.value)}
            spellCheck={false}
          />
          <label className="mb-1 block text-xs text-muted-foreground">
            workbench 写前缀（每行一个，~ 可用来表示用户目录）
          </label>
          <textarea
            className="mb-3 min-h-[60px] w-full resize-y rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
            value={prefixesText}
            onChange={(e) => setPrefixesText(e.target.value)}
            spellCheck={false}
          />
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void save()} disabled={saving || envOverrideActive}>
              {saving ? '保存中…' : '保存白名单'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void reset()} disabled={saving}>
              重置为配置文件/默认
            </Button>
            {message && (
              <span
                className={`text-xs ${message.kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}
              >
                {message.text}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

type CredentialStatus = {
  source: 'env' | 'file' | 'none';
  fields: { jwt: boolean; agentId: boolean; userId: boolean };
  fileExists: boolean;
  fileMode: string | null;
  filePath: string;
};

function FieldBadge({ label, present }: { label: string; present: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] ${
        present
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
      }`}
    >
      {label} {present ? '✓' : '✗'}
    </span>
  );
}

function CredentialsSection() {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [jwt, setJwt] = useState('');
  const [agentId, setAgentId] = useState('');
  const [userId, setUserId] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.operator.credentialStatus();
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as CredentialStatus);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await api.operator.saveCredentials({ jwt, agentId, userId });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage({ kind: 'err', text: data?.error?.message ?? `保存失败（${res.status}）` });
        return;
      }
      setJwt('');
      setAgentId('');
      setUserId('');
      setMessage({ kind: 'ok', text: '已写入凭证文件（0600），未在任何页面回显。' });
      await load();
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    try {
      const res = await api.operator.testCredentials();
      const data = (await res.json()) as {
        ok?: boolean;
        stdout?: string;
        stderr?: string;
        error?: string;
      };
      if (data.ok) {
        const firstLine = (data.stdout ?? '').split('\n').filter(Boolean)[0] ?? '(无输出)';
        setMessage({ kind: 'ok', text: `连通性正常：${firstLine.slice(0, 120)}` });
      } else {
        const detail = (data.error ?? data.stderr ?? '未知错误').slice(0, 200);
        setMessage({ kind: 'err', text: `测试失败：${detail}` });
      }
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-1 text-sm font-semibold text-foreground">凭证管理（Appia Claw）</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        execute_skill 调用瞬间从环境变量或 {status?.filePath ?? '~/.claw/cred.json'}
        读取凭证，只注入技能子进程，永不落库/落日志。此处保存写入凭证文件（0600），不回显明文。
      </p>

      {status && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            当前来源：
            {status.source === 'env' ? '环境变量' : status.source === 'file' ? '凭证文件' : '未配置'}
          </span>
          <FieldBadge label="JWT" present={status.fields.jwt} />
          <FieldBadge label="agentId" present={status.fields.agentId} />
          <FieldBadge label="userId" present={status.fields.userId} />
          {status.fileExists && status.fileMode && status.fileMode !== '600' && (
            <span className="text-amber-600 dark:text-amber-400">
              凭证文件权限 {status.fileMode} 过宽，建议 600
            </span>
          )}
        </div>
      )}

      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">JWT</label>
          <input
            type="password"
            autoComplete="new-password"
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={jwt}
            onChange={(e) => setJwt(e.target.value)}
            placeholder="CLAW_JWT"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">agentId</label>
          <input
            type="password"
            autoComplete="new-password"
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="APP_AGENT_ID"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">userId</label>
          <input
            type="password"
            autoComplete="new-password"
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="CLAW_USER_ID"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => void save()} disabled={saving || !jwt || !agentId || !userId}>
          {saving ? '保存中…' : '写入凭证文件'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing}>
          {testing ? '测试中…' : '测试连通性（groups）'}
        </Button>
        {message && (
          <span
            className={`text-xs ${message.kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}
          >
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}

type AuditRow = {
  id: number;
  created_at: string;
  tool: string;
  action: string;
  target: string | null;
  decision: 'allow' | 'deny';
  reason: string | null;
  durationMs: number;
  exitCode: number | null;
  resultSummary: string | null;
};

function AuditSection() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [tool, setTool] = useState('');
  const [decision, setDecision] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await api.operator.execAudit({
        tool: tool || undefined,
        decision: decision || undefined,
        limit: 100,
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { rows: AuditRow[] };
      setRows(data.rows);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [tool, decision]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">执行审计</h2>
        <span className="text-xs text-muted-foreground">（execute_skill / workbench 调用记录，已脱敏）</span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
          >
            <option value="">全部工具</option>
            <option value="execute_skill">execute_skill</option>
            <option value="workbench">workbench</option>
          </select>
          <select
            className="h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground"
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
          >
            <option value="">全部判定</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="py-4 text-center text-sm text-muted-foreground">加载审计失败</div>
      ) : rows.length === 0 ? (
        <div className="py-4 text-center text-sm text-muted-foreground">
          {loading ? '加载中…' : '暂无记录'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">时间</th>
                <th className="py-1.5 pr-3 font-medium">工具</th>
                <th className="py-1.5 pr-3 font-medium">动作</th>
                <th className="py-1.5 pr-3 font-medium">判定</th>
                <th className="py-1.5 pr-3 font-medium">耗时</th>
                <th className="py-1.5 font-medium">摘要 / 拒绝原因</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border/50 align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                    {new Date(row.created_at.endsWith('Z') ? row.created_at : `${row.created_at}Z`).toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 font-mono">{row.tool}</td>
                  <td className="max-w-[180px] truncate py-1.5 pr-3 font-mono" title={row.action}>
                    {row.action}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        row.decision === 'allow'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                      }`}
                    >
                      {row.decision}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                    {row.durationMs}ms
                  </td>
                  <td
                    className="max-w-[280px] truncate py-1.5 text-muted-foreground"
                    title={row.reason ?? row.resultSummary ?? ''}
                  >
                    {row.decision === 'deny' ? (row.reason ?? '—') : (row.resultSummary ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function OperatorSkillExecSettings() {
  return (
    <div className="mt-6 flex flex-col gap-6 border-t border-border/60 pt-6">
      <AllowlistSection />
      <CredentialsSection />
      <AuditSection />
    </div>
  );
}
