#!/usr/bin/env bash
#
# Remote-lite dependency prep: ensure node >= 18 and the claude CLI exist on the
# target, installing them when missing. Idempotent — a no-op when both are
# already present. Runs as `bash ~/.lovdex-remote/prepare-remote.sh` from the
# bootstrap (a non-login shell), so `command -v` must find the binaries on the
# default PATH (the same shell the lite's systemd unit will use).
#
#   - node:   official Linux x64 tarball extracted to /usr/local (no apt repo).
#   - claude: `npm i -g @anthropic-ai/claude-code`.
# Auto-install only proceeds under passwordless sudo (`sudo -n true`); otherwise
# this prints the exact manual commands and exits 1 (bootstrap surfaces them).
set -euo pipefail

NODE_VERSION="22.14.0"
NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

log() { echo "[prepare] $*"; }

has_passwordless_sudo() {
  sudo -n true >/dev/null 2>&1
}

# True when node is present AND its major version is >= 18 (matches the lite's
# claude-agent-sdk / codex-sdk `engines.node` floor, not an arbitrary higher bar).
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v 2>/dev/null | LC_ALL=C sed 's/^[vV]//' | cut -d. -f1)"
  [ -n "${major}" ] && [ "${major}" -ge 18 ] 2>/dev/null
}

if ! node_ok; then
  log "node missing or <18 — installing Node ${NODE_VERSION} to /usr/local"
  if ! has_passwordless_sudo; then
    echo "[prepare] error: node >=18 required, and passwordless sudo is unavailable." >&2
    echo "  Install Node >=18 manually, e.g.:" >&2
    echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
    exit 1
  fi
  sudo curl -fsSL "${NODE_URL}" -o "/tmp/${NODE_TARBALL}"
  sudo tar -xJf "/tmp/${NODE_TARBALL}" -C /usr/local --strip-components=1
  sudo rm -f "/tmp/${NODE_TARBALL}"
  node_ok || { echo "[prepare] error: node install completed but node -v still failing" >&2; exit 1; }
fi

if ! command -v claude >/dev/null 2>&1; then
  log "claude missing — installing @anthropic-ai/claude-code globally"
  if ! has_passwordless_sudo; then
    echo "[prepare] error: claude required, and passwordless sudo is unavailable." >&2
    echo "  Install claude manually: sudo npm i -g @anthropic-ai/claude-code" >&2
    exit 1
  fi
  sudo npm i -g @anthropic-ai/claude-code
  command -v claude >/dev/null 2>&1 || { echo "[prepare] error: claude install failed" >&2; exit 1; }
fi

echo "[prepare] ready: node $(node -v), claude $(claude -v)"