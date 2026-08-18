import React, { memo, useMemo, useState } from 'react';

/**
 * Structured renderer for the operator's in-place execution tools
 * (mcp__lovdex-operator__execute_skill / __workbench).
 *
 * The tool result content is a JSON string produced by the backend service:
 *   execute_skill → { ok, skill, subcommand, exitCode, durationMs, stdout, stderr, error? }
 *   workbench     → { ok, command, durationMs, ...per-command payload, error?, hint? }
 *
 * Rendering contract (spec §5.4): exit-code badge, collapsed stdout/stderr,
 * denied calls highlighted with the deny reason + dispatch hint. Everything
 * shown here is already redacted server-side (credentials never leave the
 * child process env).
 */

type Props = {
  content: string;
};

type ParsedResult = {
  ok?: boolean;
  skill?: string;
  subcommand?: string;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  hint?: string;
  // workbench payloads
  path?: string;
  entries?: Array<{ name: string; type: string; size: number | null }>;
  content?: string;
  truncated?: boolean;
  src?: string;
  dst?: string;
  script?: string;
};

function Badge({ tone, children }: { tone: 'green' | 'red' | 'gray' | 'amber'; children: React.ReactNode }) {
  const cls = {
    green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    gray: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

function OutputBlock({ label, text, defaultOpen }: { label: string; text: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!text) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        {label}（{text.length} 字符）
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded border border-border bg-muted p-2 font-mono text-xs text-foreground">
          {text}
        </pre>
      )}
    </div>
  );
}

export const SkillExecResult: React.FC<Props> = memo(({ content }) => {
  const parsed = useMemo<ParsedResult | null>(() => {
    try {
      const p = JSON.parse(content) as ParsedResult;
      return p && typeof p === 'object' ? p : null;
    } catch {
      return null;
    }
  }, [content]);

  // Not our JSON shape (older sessions / unexpected payload) — plain text.
  if (!parsed || (parsed.ok === undefined && parsed.error === undefined)) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-border bg-muted p-2 font-mono text-xs text-foreground">
        {content}
      </pre>
    );
  }

  const title =
    parsed.skill != null
      ? `${parsed.skill}${parsed.subcommand ? `:${parsed.subcommand}` : ''}`
      : `workbench ${parsed.command ?? ''}`.trim();
  const denied = parsed.ok === false && Boolean(parsed.error);
  const failed = parsed.ok === false && !parsed.error;

  return (
    <div
      className={`mt-2 rounded border p-2.5 ${
        denied
          ? 'border-red-200/60 bg-red-50/50 dark:border-red-800/40 dark:bg-red-950/10'
          : 'border-border bg-card'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-foreground">{title}</span>
        {parsed.ok === true && <Badge tone="green">成功</Badge>}
        {denied && <Badge tone="red">已拒绝</Badge>}
        {failed && <Badge tone="red">失败</Badge>}
        {parsed.exitCode !== undefined && parsed.exitCode !== null && (
          <Badge tone={parsed.exitCode === 0 ? 'gray' : 'amber'}>exit {parsed.exitCode}</Badge>
        )}
        {typeof parsed.durationMs === 'number' && <Badge tone="gray">{parsed.durationMs}ms</Badge>}
      </div>

      {parsed.error && (
        <div className="mt-1.5 text-xs text-red-700 dark:text-red-300">{parsed.error}</div>
      )}
      {parsed.hint && (
        <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">💡 {parsed.hint}</div>
      )}

      {/* workbench payloads */}
      {parsed.command === 'list' && Array.isArray(parsed.entries) && (
        <div className="mt-1.5 overflow-x-auto">
          <div className="mb-0.5 font-mono text-[11px] text-muted-foreground">{parsed.path}</div>
          <table className="text-xs">
            <tbody>
              {parsed.entries.map((e) => (
                <tr key={e.name}>
                  <td className="pr-2 text-muted-foreground">{e.type === 'dir' ? '📁' : '📄'}</td>
                  <td className="pr-3 font-mono text-foreground">{e.name}</td>
                  <td className="text-right text-muted-foreground">
                    {e.size != null ? `${e.size}B` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {parsed.command === 'read' && typeof parsed.content === 'string' && (
        <div className="mt-1.5">
          <div className="mb-0.5 font-mono text-[11px] text-muted-foreground">
            {parsed.path}
            {parsed.truncated ? '（已截断）' : ''}
          </div>
          <pre className="max-h-64 overflow-auto rounded border border-border bg-muted p-2 font-mono text-xs text-foreground">
            {parsed.content}
          </pre>
        </div>
      )}
      {parsed.command === 'copy' && parsed.src && parsed.dst && (
        <div className="mt-1.5 font-mono text-xs text-muted-foreground">
          {parsed.src} → {parsed.dst}
        </div>
      )}
      {parsed.script && (
        <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">{parsed.script}</div>
      )}

      {/* process output (execute_skill / run-script) */}
      <OutputBlock label="stdout" text={parsed.stdout ?? ''} defaultOpen={false} />
      <OutputBlock label="stderr" text={parsed.stderr ?? ''} defaultOpen={Boolean(failed)} />
    </div>
  );
});

SkillExecResult.displayName = 'SkillExecResult';
