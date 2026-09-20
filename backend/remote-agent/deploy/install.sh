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
#   5. activate the agent: on a systemd host, enable linger then reload/enable/
#      restart the --user service; on a non-systemd host (container, PID 1 !=
#      systemd), fall back to launching the lite as a plain background process.
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

# systemd --user talks to the per-user manager, which only exists when PID 1 is
# systemd (systemd-as-init). Containers frequently run the app as PID 1 (e.g.
# bash) with no /run/systemd/system; on those hosts loginctl and systemctl
# --user cannot work, so detect that up front and fall back to a plain
# background process instead of failing. Either signal suffices: /run/systemd/
# system is a PID-1-systemd artifact, and /proc/1/comm backs it up.
have_systemd() {
  [ -d /run/systemd/system ] \
    || [ "$(cat /proc/1/comm 2>/dev/null || true)" = "systemd" ]
}

if have_systemd; then
  # 4. Linger keeps the per-user manager alive without an active login session —
  #    required for a --user service to survive the bootstrap ssh session
  #    closing. Some hosts lack loginctl (containers); warn instead of aborting.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "${USER_NAME}" >/dev/null 2>&1 \
      || echo "[install] warning: loginctl enable-linger failed — ${USER_NAME} needs to run systemctl --user" >&2
  else
    echo "[install] warning: loginctl not available — ${USER_NAME} must be able to run systemctl --user" >&2
  fi

  # 5. Reload + enable + RESTART. A plain `enable --now` would be a no-op when
  #    the service is already running — a redeploy that pushed a NEW bundle
  #    would leave the OLD process in memory (the updated dist/lite.mjs never
  #    takes effect). Always restart so an install always runs the freshest
  #    artifact.
  systemctl --user daemon-reload
  systemctl --user enable "${UNIT_NAME}"
  systemctl --user restart "${UNIT_NAME}"

  echo "[install] ${UNIT_NAME} enabled and restarted"
else
  echo "[install] warning: not a systemd host (PID 1 is not systemd) — starting ${UNIT_NAME} as a background process" >&2

  # Stop the lite left by a previous install BEFORE starting the new one. The
  # systemd branch gets this for free from `systemctl --user restart`; here
  # nothing else reaps the old process, so a redeploy would leave the PREVIOUS
  # bundle running — and both instances race for the lite's LLM-forwarder port,
  # so the NEW one comes up half-broken (EADDRINUSE) while the STALE one keeps
  # serving. That is the same "redeploy didn't take effect" failure the systemd
  # branch's restart guards against.
  #
  # /proc is scanned instead of using pgrep/pkill because this branch exists for
  # minimal containers, where procps is frequently absent (debian-slim has no
  # pgrep). Matching the ABSOLUTE bundle path keeps unrelated node processes and
  # other users' lites untouched.
  LITE_ENTRY="${REMOTE_DIR}/dist/lite.mjs"
  lite_pids() {
    local p cmd
    for p in /proc/[0-9]*; do
      [ -r "${p}/cmdline" ] || continue
      cmd="$(tr '\0' ' ' < "${p}/cmdline" 2>/dev/null || true)"
      case "${cmd}" in
        *"${LITE_ENTRY}"*) printf '%s\n' "${p#/proc/}" ;;
      esac
    done
  }

  OLD_PIDS="$(lite_pids)"
  if [ -n "${OLD_PIDS}" ]; then
    echo "[install] stopping previous lite (pid: $(printf '%s' "${OLD_PIDS}" | tr '\n' ' '))"
    # SIGTERM first: the daemon halts its claude sessions and closes the ws on
    # SIGTERM, so give it a grace period to do that before escalating.
    # shellcheck disable=SC2086  # intentional word splitting: one pid per line
    kill -TERM ${OLD_PIDS} 2>/dev/null || true
    i=0
    while [ "${i}" -lt 20 ]; do
      if [ -z "$(lite_pids)" ]; then break; fi
      sleep 0.5
      i=$((i + 1))
    done
    REMAIN="$(lite_pids)"
    if [ -n "${REMAIN}" ]; then
      echo "[install] warning: previous lite ignored SIGTERM — sending SIGKILL to $(printf '%s' "${REMAIN}" | tr '\n' ' ')" >&2
      # shellcheck disable=SC2086
      kill -KILL ${REMAIN} 2>/dev/null || true
    fi
  fi

  # The lite inherits ANTHROPIC_API_KEY from its environment; systemd supplied
  # it via `EnvironmentFile=-%h/.lovdex-remote/.env`. Reproduce that here by
  # exporting each KEY=VALUE line VERBATIM (no shell interpretation), matching
  # systemd's EnvironmentFile semantics. Tolerate absence — the bootstrap only
  # writes .env when an API key is provisioned.
  ENV_FILE="${REMOTE_DIR}/.env"
  if [ -f "${ENV_FILE}" ]; then
    while IFS= read -r env_line || [ -n "${env_line}" ]; do
      case "${env_line}" in
        ''|'#'*) continue ;;
        *=*)
          env_key="${env_line%%=*}"
          env_val="${env_line#*=}"
          export "${env_key}=${env_val}"
          ;;
      esac
    done < "${ENV_FILE}"
  fi

  # Detached start so the lite survives the bootstrap ssh session closing:
  # nohup ignores SIGHUP, stdio is redirected away from the ssh channel, and
  # `&` + $! capture the node PID (nohup execs node, so the PID is stable).
  # Log to agent.log so startup failures are diagnosable.
  AGENT_LOG="${REMOTE_DIR}/agent.log"
  nohup "${NODE_BIN}" "${REMOTE_DIR}/dist/lite.mjs" </dev/null >>"${AGENT_LOG}" 2>&1 &
  AGENT_PID=$!
  echo "[install] ${UNIT_NAME} started as background process (pid ${AGENT_PID}, log ${AGENT_LOG})"

  # Confirm it actually came up. The bootstrap reports `online` purely on this
  # script's exit code (bootstrap.service.ts step 9), so a lite that dies
  # immediately — bad bundle, missing binary, unreadable config — would
  # otherwise be reported as a healthy deploy. The systemd branch gets the same
  # protection from Restart=on-failure plus a fail-fast unit.
  sleep 2
  if ! kill -0 "${AGENT_PID}" 2>/dev/null; then
    echo "[install] error: lite exited within 2s of start — last log lines:" >&2
    tail -n 20 "${AGENT_LOG}" >&2 || true
    exit 1
  fi
  echo "[install] ${UNIT_NAME} is up"
fi