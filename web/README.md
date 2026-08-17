<div align="center">
 <img src="public/logo.svg" alt="Lovdex CLI" width="64" height="64">
 <h1>Lovdex CLI — Frontend</h1>
 <p>Web UI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> and <a href="https://developers.openai.com/codex">Codex</a> conversations.<br>Frontend-only package that talks to the standalone <code>lovdex-backend</code> service over HTTP + WebSocket.</p>
</div>

---

## What this is

This repository is the **frontend** of the Lovdex CLI split. It contains the React + Vite SPA
(project explorer, chat interface, file/git browsers, session management). It does **not** ship a
server — all `/api/*` requests and the `/ws` WebSocket are served by the standalone backend
package [`lovdex-backend`](../lovdex-backend).

```
lovdex-cli/        ← you are here (frontend SPA)
lovdex-backend/    ← Express + WebSocket API service
```

See [`docs/api-contract.html`](docs/api-contract.html) for the full frontend↔backend interface
contract, and [`docs/streaming-api.md`](docs/streaming-api.md) for the WebSocket streaming protocol.

## Features

- **Responsive Design** — desktop, tablet, and mobile
- **Interactive Chat Interface** — streaming conversations with Claude Code / Codex
- **File Explorer** — file tree with syntax highlighting and live editing
- **Git Explorer** — view, stage, commit, switch branches
- **Session Management** — resume conversations, manage multiple sessions, track history
- **Provider Switching** — Claude Code and Codex, model selection at runtime
- **MCP / Skills Management** — configured via the backend, surfaced in the UI

## Prerequisites

- **Node.js v22+**
- A running `lovdex-backend` instance (see its README for setup)

## Quick start

```bash
npm install
npm run dev        # Vite dev server (default http://localhost:5187)
```

Build for production:

```bash
npm run build      # -> dist/
npm run preview    # serve the built dist/ locally
```

Other scripts:

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src/
```

## Connecting to the backend

The frontend resolves the backend via the `VITE_API_BASE_URL` env var.

**Same-origin / dev proxy (default).** Leave `VITE_API_BASE_URL` empty. In dev, Vite proxies
`/api` and `/ws` to `http://<HOST>:<SERVER_PORT>` (see `vite.config.js`). In production, put the
frontend and backend behind the same origin (e.g. a reverse proxy).

**Cross-origin (backend deployed separately).** Set `VITE_API_BASE_URL` to the backend origin:

```bash
VITE_API_BASE_URL=http://localhost:3001 npm run dev
# or for a production build, bake it in at build time:
VITE_API_BASE_URL=https://api.example.com npm run build
```

Then make sure the backend's `CORS_ORIGIN` includes the frontend's origin.

## Configuration (env)

Copy `.env.example` to `.env` and adjust. Relevant variables:

| Var | Default | Purpose |
|---|---|---|
| `VITE_PORT` | `5187` | Vite dev server port |
| `HOST` | `0.0.0.0` | dev server bind host |
| `SERVER_PORT` | `3001` | backend port — used by the Vite dev proxy (`/api`, `/ws`); must match the backend's `SERVER_PORT` |
| `VITE_API_BASE_URL` | _(empty)_ | backend base URL; empty = same-origin (dev proxy / reverse proxy) |
| `VITE_IS_PLATFORM` | `false` | platform mode flag (skips sending `Authorization` header when `true`) |
| `VITE_CONTEXT_WINDOW` | `160000` | context window size shown in the UI |

> Auth token is kept in `localStorage` under `auth-token` and sent as
> `Authorization: Bearer <token>`. The backend refreshes it via the `X-Refreshed-Token`
> response header. In platform mode (`VITE_IS_PLATFORM=true`) the header is omitted.

## Project structure

```
lovdex-cli/
  src/                 React SPA (components, hooks, stores, contexts, i18n)
  public/              static assets (logo, favicon, manifest, service worker)
  shared/networkHosts.js   small host-normalization util shared with vite.config.js
  docs/                API contract + architecture + streaming protocol docs
  dist/                build output (vite build)
  vite.config.js       dev server + /api & /ws proxy to backend
  package.json
```

## Tech stack

- [React](https://react.dev/) + [Vite](https://vitejs.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [react-router-dom](https://reactrouter.com/) · [i18next](https://www.i18next.com/)
- [react-markdown](https://github.com/remarkjs/react-markdown) + KaTeX for rich message rendering

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE).
