/**
 * Minimal HS256 JWT sign/verify built on node:crypto — no jsonwebtoken dep.
 *
 * The frontend holds the token in localStorage and sends it as
 * `Authorization: Bearer` (or `?token=` for EventSource/SSE, which cannot set
 * headers). Stateless: verification only needs the shared secret, never a DB
 * lookup.
 */

import crypto from 'node:crypto';

import { authConfig } from './auth.config.js';

export type AuthTokenPayload = {
  sub: number | string;
  username: string;
  iat: number;
  exp: number;
};

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

export function signToken(
  payload: Pick<AuthTokenPayload, 'sub' | 'username'> & { iat?: number; exp?: number }
): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = payload.iat ?? now;
  const exp = payload.exp ?? iat + authConfig.expiresInSeconds;
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ sub: payload.sub, username: payload.username, iat, exp }));
  const signature = crypto
    .createHmac('sha256', authConfig.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string): AuthTokenPayload | null {
  if (typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, body, signature] = parts;
  const expected = crypto
    .createHmac('sha256', authConfig.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthTokenPayload;
    if (typeof payload.sub !== 'number' && typeof payload.sub !== 'string') {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Reads the bearer token from an HTTP request. EventSource/SSE requests cannot
 * set headers, so the frontend passes `?token=` as a fallback.
 */
export function extractTokenFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}): string | null {
  const authHeader = req.headers['authorization'];
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  return bearer ?? queryToken;
}
