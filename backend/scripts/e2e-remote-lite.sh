#!/usr/bin/env bash
#
# e2e-remote-lite.sh — scripted end-to-end verification of the remote-projects
# feature against a REAL remote host. NOT part of CI; run by hand when you want
# to prove the whole chain in one shot:
#
#   pubkey authorize -> register host -> deploy lite -> wait for online ->
#   create a remote project (-> optional manual chat smoke, documented below).
#
# ── Prerequisites ────────────────────────────────────────────────────────────
#   * A running Lovdex backend with AUTH enabled (the default). Its REST API is
#     reachable at $API_BASE (default http://127.0.0.1:3188/api).
#   * $LOVDEX_TOKEN — a valid JWT for the backend. Every /api call is sent with
#     `Authorization: Bearer $LOVDEX_TOKEN`. (There is no script/API-key auth
#     convention in this repo; the middleware only accepts a bearer JWT — see
#     backend/server/modules/auth/jwt.ts.) Grab one by logging in through the
#     web app / auth route and copying the token.
#   * `jq` and `curl` on this machine.
#   * An ssh target reachable at $SSH_USER@$HOST_IP with key-based access (this
#     script appends the Lovdex pubkey to authorized_keys for you, but the FIRST
#     ssh in must already succeed — i.e. you can ssh in with your own key/agent).
#   * On the TARGET: node >= 20 and the `claude` CLI already installed and on the
#     login-shell PATH. The bootstrap deploys the lite agent, NOT the toolchain.
#   * The Lovdex pubkey must be visible at GET /api/remote-agents/pubkey (the
#     backend generated an ed25519 identity). This script reads it from there.
#
# ── Configuration (env vars, with defaults) ──────────────────────────────────
#   HOST_IP            target host/IP        (default 127.0.0.1 — loopback works;
#                                             the Lovdex host may be its own target)
#   SSH_USER           ssh login user        (default $(whoami))
#   API_BASE           backend REST base     (default http://127.0.0.1:3188/api — the
#                                             DEFAULT_APP_CONFIG.server.port)
#   REMOTE_PROJECT_DIR project dir on target (default $HOME/e2e-remote-src)
#   LOVDEX_TOKEN       bearer JWT            (required)
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#   export LOVDEX_TOKEN=eyJ...            # required
#   HOST_IP=10.0.0.5 SSH_USER=deploy ./backend/scripts/e2e-remote-lite.sh
#
# ── Cleanup (NOT auto-run — do it yourself when finished) ─────────────────────
#   Remove the host row + tear the socket down:
#     curl -fsS -X DELETE "$API_BASE/remote-agents/$HOST_ID" \
#       -H "Authorization: Bearer $LOVDEX_TOKEN"
#   Stop + disable the lite service on the target:
#     ssh "$SSH_USER@$HOST_IP" \
#       'systemctl --user disable --now lovdex-agent.service'
#   (The script prints the exact commands with the resolved $HOST_ID at the end.)
#
# ── Optional manual chat smoke (documented, not scripted) ─────────────────────
#   After PASS, open the created remote project in the Lovdex web UI, start a
#   chat session against it, and send a trivial prompt (e.g. "list files in this
#   directory"). A streamed response proves the spawn/approval path end to end.
#   This is left manual because it needs the interactive UI + a model turn.
#
# shellcheck disable=SC2016  # single-quoted ssh remote commands are intentional:
#                            # $VARS in them expand on the TARGET, not locally.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
HOST_IP="${HOST_IP:-127.0.0.1}"
SSH_USER="${SSH_USER:-$(whoami)}"
API_BASE="${API_BASE:-http://127.0.0.1:3188/api}"
REMOTE_PROJECT_DIR="${REMOTE_PROJECT_DIR:-$HOME/e2e-remote-src}"

SSH_TARGET="${SSH_USER}@${HOST_IP}"
# BatchMode: never hang on a password prompt — fail loudly instead. Accept a
# new host key so a first-contact loopback run does not wedge on the prompt.
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# ── Helpers ───────────────────────────────────────────────────────────────────
die() {
  echo "" >&2
  echo "FAIL: $*" >&2
  exit 1
}

info() { echo "[e2e] $*"; }

# Authenticated curl. Fails loudly on any non-2xx (curl -f) so a step never
# silently proceeds on an error body.
api() {
  # usage: api METHOD PATH [curl args...]
  local method="$1" path="$2"
  shift 2
  curl -fsS -X "$method" "${API_BASE}${path}" \
    -H "Authorization: Bearer ${LOVDEX_TOKEN}" \
    "$@"
}

for bin in curl jq ssh; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is required but not on PATH."
done

# ── Step a. Auth precondition ─────────────────────────────────────────────────
if [ -z "${LOVDEX_TOKEN:-}" ]; then
  die "\$LOVDEX_TOKEN is not set. Export a valid backend JWT first, e.g.
       export LOVDEX_TOKEN=eyJ...   (see the header comment for how to obtain one)."
fi

info "Config: HOST_IP=${HOST_IP} SSH_USER=${SSH_USER} API_BASE=${API_BASE}"
info "        REMOTE_PROJECT_DIR=${REMOTE_PROJECT_DIR}"

# ── Step b. Fetch pubkey + authorize it on the target ─────────────────────────
info "Fetching Lovdex public key from ${API_BASE}/remote-agents/pubkey ..."
PUBKEY_JSON="$(api GET /remote-agents/pubkey)" \
  || die "pubkey request failed — is the backend up and \$LOVDEX_TOKEN valid?"
PUBKEY="$(printf '%s' "$PUBKEY_JSON" | jq -r '.data.publicKey // ""')"
[ -n "$PUBKEY" ] || die "pubkey response had no .data.publicKey: ${PUBKEY_JSON}"
info "Public key: ${PUBKEY:0:40}..."

info "Ensuring the pubkey is in ${SSH_TARGET}:~/.ssh/authorized_keys (idempotent) ..."
# Pass the key on stdin so no shell-quoting of the key material is needed. The
# remote block is idempotent: grep -qF, then append only if missing.
printf '%s\n' "$PUBKEY" | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" '
  set -eu
  umask 077
  mkdir -p "$HOME/.ssh"
  touch "$HOME/.ssh/authorized_keys"
  chmod 700 "$HOME/.ssh"
  chmod 600 "$HOME/.ssh/authorized_keys"
  key="$(cat)"
  if grep -qF "$key" "$HOME/.ssh/authorized_keys"; then
    echo "[remote] pubkey already present"
  else
    printf "%s\n" "$key" >> "$HOME/.ssh/authorized_keys"
    echo "[remote] pubkey appended"
  fi
' || die "failed to authorize the pubkey on ${SSH_TARGET} (can you ssh in with your own key?)."

# ── Step c. Register the host ─────────────────────────────────────────────────
info "Registering host 'e2e' (${SSH_USER}@${HOST_IP}) ..."
REGISTER_JSON="$(api POST /remote-agents \
  -H 'Content-Type: application/json' \
  --data "$(jq -n \
    --arg name 'e2e' \
    --arg host "$HOST_IP" \
    --arg sshUser "$SSH_USER" \
    '{name: $name, host: $host, sshUser: $sshUser}')")" \
  || die "host registration request failed."
HOST_ID="$(printf '%s' "$REGISTER_JSON" | jq -r '.data.hostId // ""')"
[ -n "$HOST_ID" ] || die "registration response had no .data.hostId: ${REGISTER_JSON}"
info "Registered hostId=${HOST_ID}"

# ── Step d. Deploy the lite + poll until online ───────────────────────────────
info "Deploying lite agent to host ${HOST_ID} (blocking ssh+scp, may take 10-30s) ..."
# Capture the body + http code WITHOUT curl -f (curl 7.68 has no
# --fail-with-body): check the code ourselves so the bootstrap error body
# survives into die(). AppError bodies are { success:false, error:{message} }.
DEPLOY_BODY="$(mktemp)" || die "mktemp failed"
DEPLOY_CODE="$(curl -sS -o "$DEPLOY_BODY" -w '%{http_code}' -X POST \
  "${API_BASE}/remote-agents/${HOST_ID}/deploy" \
  -H "Authorization: Bearer ${LOVDEX_TOKEN}" \
  -H 'Content-Type: application/json' --data '{}')" \
  || { rm -f "$DEPLOY_BODY"; die "deploy curl did not connect — is the backend up? (no HTTP response was received)"; }
DEPLOY_JSON="$(cat "$DEPLOY_BODY")"
rm -f "$DEPLOY_BODY"
if [ "${DEPLOY_CODE:-000}" -lt 200 ] || [ "${DEPLOY_CODE:-000}" -ge 300 ]; then
  DEPLOY_ERR="$(printf '%s' "$DEPLOY_JSON" | jq -r '.error.message // .message // .data.message // .data // ""')"
  die "deploy request failed (HTTP ${DEPLOY_CODE}). ${DEPLOY_ERR}
       Check the backend logs and the target's node/claude PATH.
       Cleanup: curl -X DELETE ${API_BASE}/remote-agents/${HOST_ID} -H 'Authorization: Bearer \$LOVDEX_TOKEN'"
fi
DEPLOY_STATUS="$(printf '%s' "$DEPLOY_JSON" | jq -r '.data.status // ""')"
DEPLOY_MSG="$(printf '%s' "$DEPLOY_JSON" | jq -r '.data.message // ""')"
info "Deploy returned status='${DEPLOY_STATUS}' message='${DEPLOY_MSG}'"

info "Polling GET /remote-agents until host is online (up to ~90s) ..."
ONLINE=0
DEADLINE=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  LIST_JSON="$(api GET /remote-agents)" || die "host list request failed while polling."
  # Read this host's row; default missing fields to "" so jq -r never explodes.
  ROW="$(printf '%s' "$LIST_JSON" \
    | jq -c --arg id "$HOST_ID" '.data.hosts[]? | select(.host_id == $id)')"
  STATUS="$(printf '%s' "$ROW" | jq -r '.status // ""')"
  IS_ONLINE="$(printf '%s' "$ROW" | jq -r 'if .online == true then "1" else "0" end')"
  LAST_ERROR="$(printf '%s' "$ROW" | jq -r '.last_error // ""')"

  # Break ONLY on the live registry flag: stored 'online' status can precede
  # the lite's actual hello, and create-remote-project 409s on a not-yet-live
  # host. The stored STATUS stays informational for messages.
  if [ "$IS_ONLINE" = "1" ]; then
    ONLINE=1
    info "Host is live in the registry (stored status='${STATUS:-unknown}')."
    break
  fi
  if [ "$STATUS" = "error" ]; then
    die "host entered 'error' status. last_error: ${LAST_ERROR:-<none>}
       Cleanup: curl -X DELETE ${API_BASE}/remote-agents/${HOST_ID} -H 'Authorization: Bearer \$LOVDEX_TOKEN'"
  fi
  info "  ...status='${STATUS:-unknown}', not online yet; retrying in 3s."
  sleep 3
done

[ "$ONLINE" = "1" ] || die "host did not come online within ~90s (last status='${STATUS:-unknown}').
       Cleanup: curl -X DELETE ${API_BASE}/remote-agents/${HOST_ID} -H 'Authorization: Bearer \$LOVDEX_TOKEN'"

# ── Step e. Ensure the remote project dir exists on the target ────────────────
info "Ensuring ${REMOTE_PROJECT_DIR} exists on ${SSH_TARGET} ..."
# Pass the path over stdin (consistent with the pubkey step) so no shell
# quoting of the path is needed; `--` guards dash-leading paths.
printf '%s\n' "$REMOTE_PROJECT_DIR" | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" '
  set -eu
  path="$(cat)"
  mkdir -p -- "$path"
' || die "failed to create ${REMOTE_PROJECT_DIR} on ${SSH_TARGET}."

# ── Step f. Create the remote project ─────────────────────────────────────────
info "Creating remote project at ${REMOTE_PROJECT_DIR} (hostId=${HOST_ID}) ..."
PROJECT_JSON="$(api POST /projects/create-remote-project \
  -H 'Content-Type: application/json' \
  --data "$(jq -n \
    --arg path "$REMOTE_PROJECT_DIR" \
    --arg remoteHostId "$HOST_ID" \
    '{path: $path, remoteHostId: $remoteHostId}')")" \
  || die "create-remote-project request failed."
# This route returns { success, project, message } unwrapped (not the data
# envelope), and project is a ProjectApiView keyed by `projectId`.
PROJECT_ID="$(printf '%s' "$PROJECT_JSON" | jq -r '.project.projectId // ""')"
PROJECT_OK="$(printf '%s' "$PROJECT_JSON" | jq -r 'if .project then "1" else "0" end')"
[ "$PROJECT_OK" = "1" ] || die "response had no 'project': ${PROJECT_JSON}"
info "Remote project created (projectId='${PROJECT_ID:-<unknown>}')."

# ── Step g. Summary + PASS ────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════"
echo " PASS — remote-projects E2E chain verified"
echo "════════════════════════════════════════════════════════════════════"
echo "  host          : ${SSH_USER}@${HOST_IP}"
echo "  hostId        : ${HOST_ID}"
echo "  deploy status : ${DEPLOY_STATUS}"
echo "  project dir   : ${REMOTE_PROJECT_DIR}"
echo "  project id    : ${PROJECT_ID:-<unknown>}"
echo ""
echo "  Optional manual smoke: open the project in the Lovdex UI, start a chat,"
echo "  and send a trivial prompt to exercise the spawn/approval path."
echo ""
echo "  Cleanup when done (NOT auto-run):"
echo "    curl -fsS -X DELETE \"${API_BASE}/remote-agents/${HOST_ID}\" \\"
echo "      -H \"Authorization: Bearer \$LOVDEX_TOKEN\""
echo "    ssh ${SSH_TARGET} 'systemctl --user disable --now lovdex-agent.service'"
echo "════════════════════════════════════════════════════════════════════"
