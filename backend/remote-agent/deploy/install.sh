#!/usr/bin/env bash
#
# Lovdex remote-lite installer. Idempotent: safe to re-run. Invoked on the
# remote host by the bootstrap service as `bash ~/.lovdex-remote/install.sh`.
#
# Steps:
#   1. cd into ~/.lovdex-remote
#   2. install production deps (npm ci) when a package.json is present; skip when
#      only the bundled dist/lite.mjs was shipped.
#   3. render the systemd --user unit from the template, substituting __USER__.
#   4. reload systemd and enable+start the service.
set -euo pipefail

REMOTE_DIR="${HOME}/.lovdex-remote"
UNIT_NAME="lovdex-agent.service"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
TEMPLATE="${REMOTE_DIR}/lovdex-agent.service"

cd "${REMOTE_DIR}"

# 1. Dependencies — only when a package.json is present (source install). A
#    prebuilt dist/lite.mjs bundle needs no install step.
if [ -f "${REMOTE_DIR}/package.json" ]; then
  echo "[install] running npm ci --omit=dev"
  npm ci --omit=dev
elif [ -f "${REMOTE_DIR}/dist/lite.mjs" ]; then
  echo "[install] prebuilt dist/lite.mjs present — skipping npm ci"
else
  echo "[install] warning: no package.json and no dist/lite.mjs found" >&2
fi

# 2. Render + install the systemd --user unit. The bootstrap pushes the raw
#    template to ${TEMPLATE}; substitute __USER__ and drop it into the user unit
#    directory. If the template is absent (already rendered on a prior run), keep
#    whatever is installed.
mkdir -p "${SYSTEMD_USER_DIR}"
if [ -f "${TEMPLATE}" ]; then
  echo "[install] rendering ${UNIT_NAME} for user ${USER}"
  sed 's/__USER__/'"${USER}"'/g' "${TEMPLATE}" > "${SYSTEMD_USER_DIR}/${UNIT_NAME}"
fi

# 3. Reload + enable+start. --now enables and starts in one step; re-running is
#    a no-op beyond a restart, so the install stays idempotent.
systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}"

echo "[install] ${UNIT_NAME} enabled and started"
