// OSS self-hosted build: authentication is enforced by default. Requests must
// carry a JWT issued by POST /api/auth/login — as `Authorization: Bearer`, or
// `?token=` for EventSource/SSE which cannot set headers. Set AUTH_ENABLED=false
// to restore the open internal-only mode (every request is a synthetic local
// user). Platform mode keeps its own auth flow and is exempt.

import { authConfig, isAuthEnabled } from '@/modules/auth/auth.config.js';
import { extractTokenFromRequest, signToken, verifyToken } from '@/modules/auth/jwt.js';

const LOCAL_USER = Object.freeze({ id: 1, username: 'local' });

// Optional API key middleware (still honored when API_KEY env is set).
const validateApiKey = (req, res, next) => {
  if (!process.env.API_KEY) {
    return next();
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  req.apiKeyValidated = true;
  next();
};

// Sliding refresh: when the token still has <= refreshWindowSeconds left, issue
// a fresh one in X-Refreshed-Token (the frontend stores it automatically).
const maybeRefreshToken = (res, payload) => {
  const now = Math.floor(Date.now() / 1000);
  const remaining = payload.exp - now;
  if (remaining > 0 && remaining <= authConfig.refreshWindowSeconds) {
    res.set('X-Refreshed-Token', signToken({ sub: payload.sub, username: payload.username }));
  }
};

const authenticateToken = async (req, res, next) => {
  if (!isAuthEnabled() || req.apiKeyValidated) {
    req.user = LOCAL_USER;
    return next();
  }
  const token = extractTokenFromRequest(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.user = { id: payload.sub, username: payload.username };
  maybeRefreshToken(res, payload);
  next();
};

// WebSocket auth: verify ?token= or Authorization header; null rejects the upgrade.
const authenticateWebSocket = (token) => {
  if (!isAuthEnabled()) {
    return { id: 1, userId: 1, username: 'local' };
  }
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return null;
  }
  return { id: payload.sub, userId: payload.sub, username: payload.username };
};

export { validateApiKey, authenticateToken, authenticateWebSocket };
