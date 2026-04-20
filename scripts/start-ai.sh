#!/usr/bin/env bash
# Start the Docusaurus dev server with Ask-AI env vars loaded from .env.local.
# Usage: ./scripts/start-ai.sh [--port 3001]
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    echo ".env.local not found. Copy .env.example to .env.local and fill it in." >&2
    echo "  cp .env.example .env.local" >&2
  else
    echo ".env.local not found and .env.example is missing." >&2
  fi
  exit 1
fi

# Export every non-comment KEY=VALUE pair from .env.local
set -a
# shellcheck disable=SC1091
source .env.local
set +a

if [ -z "${ASK_AI_MOCK:-}" ] && { [ -z "${ASK_AI_SERVICE_URL:-}" ] || [ -z "${ASK_AI_MODEL:-}" ]; }; then
  echo "Missing ASK_AI_SERVICE_URL / ASK_AI_MODEL in .env.local." >&2
  echo "ASK_AI_API_KEY is only required when calling a 0G provider directly (not when using the local proxy)." >&2
  echo "Or set ASK_AI_MOCK=1 to run without 0G Compute." >&2
  exit 1
fi

PORT_ARG="${*:---port 3001}"
exec yarn start $PORT_ARG
