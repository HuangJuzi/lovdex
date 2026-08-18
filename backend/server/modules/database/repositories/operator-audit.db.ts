/**
 * Operator execution audit repository.
 *
 * One row per execute_skill / workbench call — including DENIED calls, so a
 * rejected attempt is as visible as an allowed one. Contents are already
 * sanitized by the caller (operator-exec.service); this layer additionally
 * truncates as defense in depth. Write failures warn instead of throwing:
 * audit must never break the tool path.
 */

import { getConnection } from '@/modules/database/connection.js';
import type { OperatorAuditEntry } from '@/modules/operators/operator-exec.service.js';

export type OperatorAuditRow = OperatorAuditEntry & {
  id: number;
  created_at: string;
};

function clip(value: string | null, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export const operatorAuditDb = {
  /** Inserts one audit record. Swallows errors (warn-only) by contract. */
  insert(entry: OperatorAuditEntry): void {
    try {
      const db = getConnection();
      db.prepare(
        `INSERT INTO operator_exec_audit
           (caller, tool, action, target, decision, reason, duration_ms, exit_code, result_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        clip(entry.caller, 64),
        clip(entry.tool, 32),
        clip(entry.action, 255),
        clip(entry.target, 512),
        clip(entry.decision, 16),
        clip(entry.reason, 512),
        Math.round(entry.durationMs),
        entry.exitCode,
        clip(entry.resultSummary, 500),
      );
    } catch (e) {
      console.warn('[operator-audit] insert failed:', e instanceof Error ? e.message : String(e));
    }
  },

  /** Newest-first audit listing (phase-2 audit viewer API will use this). */
  list(filter: { tool?: string; decision?: string; limit?: number } = {}): OperatorAuditRow[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.tool) {
      clauses.push('tool = ?');
      params.push(filter.tool);
    }
    if (filter.decision) {
      clauses.push('decision = ?');
      params.push(filter.decision);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? filter.limit! : 100;
    return db
      .prepare(
        `SELECT id, created_at, caller, tool, action, target, decision, reason,
                duration_ms AS durationMs, exit_code AS exitCode, result_summary AS resultSummary
         FROM operator_exec_audit ${where}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as OperatorAuditRow[];
  },
};
