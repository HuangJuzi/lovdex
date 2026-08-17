import express from 'express';

import { authenticateToken } from '../../middleware/auth.js';
import {
  authConfig,
  isAuthEnabled,
  MAX_CODE_LENGTH,
  MIN_CODE_LENGTH,
  updateAuthCode,
} from './auth.config.js';
import { extractTokenFromRequest, signToken, verifyToken } from './jwt.js';

const router = express.Router();

const USER = Object.freeze({ id: 1, username: authConfig.email });

// Public login: fixed email + fixed verification code → JWT. No DB writes.
router.post('/login', (req, res) => {
  const { email, code } = (req.body ?? {}) as { email?: unknown; code?: unknown };
  if (
    typeof email !== 'string' ||
    typeof code !== 'string' ||
    email !== authConfig.email ||
    code !== authConfig.code
  ) {
    return res.status(401).json({ error: '邮箱或验证码不正确' });
  }
  const token = signToken({ sub: USER.id, username: USER.username });
  res.json({ token, user: USER });
});

// Public token validation — the frontend boot-checks a stored token here.
router.get('/me', (req, res) => {
  const token = extractTokenFromRequest(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  res.json({ user: { id: payload.sub, username: payload.username } });
});

// Authenticated password change: verifies the current code, then persists the
// new one to auth.config.json and hot-updates memory (takes effect immediately).
router.post('/change-password', authenticateToken, (req, res) => {
  if (!isAuthEnabled()) {
    // Open / platform mode has no password gate — nothing to change.
    return res.status(404).json({ error: '登录未开启，无法修改密码' });
  }
  const { currentCode, newCode } = (req.body ?? {}) as {
    currentCode?: unknown;
    newCode?: unknown;
  };
  const current = typeof currentCode === 'string' ? currentCode.trim() : '';
  const next = typeof newCode === 'string' ? newCode.trim() : '';
  if (!current || current !== authConfig.code) {
    return res.status(401).json({ error: '当前验证码不正确' });
  }
  if (next.length < MIN_CODE_LENGTH || next.length > MAX_CODE_LENGTH) {
    return res.status(400).json({ error: '新验证码长度需在 4-64 位之间' });
  }
  if (!updateAuthCode(next)) {
    return res.status(500).json({ error: '修改失败，请检查服务端配置文件权限' });
  }
  res.json({ ok: true });
});

export default router;
