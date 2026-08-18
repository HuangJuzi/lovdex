#!/usr/bin/env bash
#
# Lovdex remote-lite installer. Idempotent: safe to re-run. Invoked on the
# remote host by the bootstrap service as `bash ~/.lovdex-remote/install.sh`.
#
# Steps:
#   1. cd into ~/.lovdex-remote
#   2. extract lite.tgz (the bootstrap's self-contained bundle — dist/lite.mjs +
#      package.json) if pushed.
#   3. install production deps (npm ci) ONLY for a source install (package.json
#      without a prebuilt bundle); a bundled dist/lite.mjs has deps inlined, so
#      npm ci is skipped. Nothing to run at all → exit 1 (fail loudly).
#   4. render the systemd --user unit from the pushed template, substituting
#      the absolute node/claude binary paths (login-shell PATH; systemd --user
#      has a minimal PATH that lacks nvm / npm globals).
#   5. enable linger, reload systemd and enable+start the service.
set -euo pipefail

# systemd --user communicates with the per-user manager through the runtime
# socket in XDG_RUNTIME_DIR; an ssh session usually does not carry it.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

REMOTE_DIR="${HOME}/.lovdex-remote"
UNIT_NAME="lovdex-agent.service"
# Respect an existing XDG_CONFIG_HOME; fall back to ~/.config. HOME is always
# set by sshd; $USER is NOT reliable, so resolve the login name from id.
USER_NAME="$(id -un)"
HOME_DIR="${HOME:-/home/${USER_NAME}}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-${HOME_DIR}/.config}/systemd/user"
TEMPLATE="${REMOTE_DIR}/${UNIT_NAME}"

# Resolve node/claude from THIS shell (the ssh login shell, where nvm / npm
# globals are on PATH). The rendered unit runs under systemd --user with a
# minimal PATH, so the absolute paths are required there. Fail fast — a unit
# with a missing binary would just crash-loop forever.
NODE_BIN="$(command -v node || true)"
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "${NODE_BIN}" ] || [ -z "${CLAUDE_BIN}" ]; then
  echo "[install] error: node and claude must be resolvable in this shell (node='${NODE_BIN}' claude='${CLAUDE_BIN}')" >&2
  exit 1
fi

cd "${REMOTE_DIR}"

# 1. Optional tarball package (pushed by the bootstrap when litePackagePath was
#    provided): expand it so dist/ + package.json land in REMOTE_DIR. The
#    non-tarball contract (dist/ + package.json already present) is handled by
#    step 2 below.
if [ -f "${REMOTE_DIR}/lite.tgz" ]; then
  echo "[install] extracting lite.tgz"
  tar -zxf "${REMOTE_DIR}/lite.tgz"
  rm -f "${REMOTE_DIR}/lite.tgz"
fi

# 2. Dependencies — BUNDLE-FIRST: the shipped dist/lite.mjs is SELF-CONTAINED
#    (esbuild inlines ws/zod/claude-agent-sdk, no --packages=external), so a
#    prebuilt bundle skips npm ci entirely. npm ci only runs for a true source
#    install (package.json present AND no prebuilt bundle): npm ci requires a
#    package-lock.json — which a shipped tarball omits (it would fail) — and
#    would wipe node_modules on every bundled redeploy.
if [ -f "${REMOTE_DIR}/dist/lite.mjs" ]; then
  echo "[install] prebuilt dist/lite.mjs present — skipping npm ci"
elif [ -f "${REMOTE_DIR}/package.json" ]; then
  echo "[install] running npm ci --omit=dev"
  npm ci --omit=dev
else
  # Neither a bundle nor a package.json: the systemd unit's ExecStart points at
  # a missing dist/lite.mjs, so the service could never come up. Fail loudly —
  # bootstrap reports `error`, never a false `online` (C1c review fix).
  echo "[install] error: no dist/lite.mjs and no package.json found — nothing to run" >&2
  exit 1
fi

# 3. Render + install the systemd --user unit. The bootstrap pushes the raw
#    template to ${TEMPLATE}; substitute the absolute binary paths. The
#    template uses the systemd specifier %h for the home, so no __HOMEDIR__
#    substitution is needed. `|` is the sed delimiter because paths contain /
#    and almost never |; either way the replacement is escaped first — `&` and
#    backslash (and the delimiter itself) have sed meaning in the replacement.
#    If the template is absent (already rendered on a prior run), keep whatever
#    unit is installed.
mkdir -p "${SYSTEMD_USER_DIR}"
if [ -f "${TEMPLATE}" ]; then
  echo "[install] rendering ${UNIT_NAME} for user ${USER_NAME}"
  NODE_BIN_SED="$(printf '%s' "${NODE_BIN}" | LC_ALL=C sed 's/[\\&|]/\\&/g')"
  CLAUDE_BIN_SED="$(printf '%s' "${CLAUDE_BIN}" | LC_ALL=C sed 's/[\\&|]/\\&/g')"
  sed -e "s|__NODE_BIN__|${NODE_BIN_SED}|g" \
      -e "s|__CLAUDE_BIN__|${CLAUDE_BIN_SED}|g" \
      "${TEMPLATE}" > "${SYSTEMD_USER_DIR}/${UNIT_NAME}"
fi

# 4. Linger keeps the per-user manager alive without an active login session —
#    required for a --user service to survive the bootstrap ssh session closing.
#    Some hosts lack loginctl (containers); warn instead of aborting.
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "${USER_NAME}" >/dev/null 2>&1 \
    || echo "[install] warning: loginctl enable-linger failed — ${USER_NAME} needs to run systemctl --user" >&2
else
  echo "[install] warning: loginctl not available — ${USER_NAME} must be able to run systemctl --user" >&2
fi

# 5. Reload + enable+start. --now enables and starts in one step; re-running is
#    a no-op beyond a restart, so the install stays idempotent.
systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}"

echo "[install] ${UNIT_NAME} enabled and started"