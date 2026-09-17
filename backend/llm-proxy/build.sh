#!/usr/bin/env bash
# Builds the llm-proxy sidecar binary into backend/llm-proxy/llm-proxy.
set -euo pipefail
cd "$(dirname "$0")"
go build -o llm-proxy .
echo "built llm-proxy -> $(pwd)/llm-proxy"
