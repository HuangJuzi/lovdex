/**
 * Output sanitizer for operator in-place execution.
 *
 * Redacts credentials and identity tokens from anything that flows back to
 * the model, the transcript, or the audit trail: JWTs, Bearer tokens, and
 * JSON/kv values of sensitive keys (jwt/token/authorization/agentId/userId/
 * password/secret). Pure function — no I/O — so it is trivially unit-testable.
 */

const REDACTED = '***REDACTED***';

/** JWTs are three base64url segments starting with eyJ ({"..."). */
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** Authorization: Bearer <token> (header or log echo). */
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/**
 * Sensitive key-value pairs in JSON-ish or shell-ish text:
 *   "agentId": "abc"  |  'user_id': 'abc'  |  token=abc  |  authorization: abc
 * Group 1 = key + separator + opening quote; group 2 = value; group 3 = closing quote.
 */
const SENSITIVE_KV_RE =
  /(["']?(?:jwt|token|authorization|agent_?id|user_?id|password|secret)["']?\s*[:=]\s*["']?)([^"',\s}]+)(["']?)/gi;

/**
 * Redacts sensitive values from `text` and truncates to `maxLen` chars.
 * Truncation appends a marker so the model knows the output was cut.
 */
export function sanitizeOutput(text: string, maxLen = 8000): string {
  if (!text) return '';
  const out = text
    .replace(JWT_RE, `eyJ${REDACTED}`)
    .replace(BEARER_RE, `$1${REDACTED}`)
    .replace(SENSITIVE_KV_RE, (_m, p1: string, _v: string, p3: string) => `${p1}${REDACTED}${p3}`);
  if (out.length > maxLen) {
    return `${out.slice(0, maxLen)}\n…[truncated ${out.length - maxLen} chars]`;
  }
  return out;
}
