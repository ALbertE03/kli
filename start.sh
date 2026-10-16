#!/usr/bin/env bash
# Boots the KLI harness server and the Studio dev server together.
set -e

# Harness server (background, port 4317 by default).
node packages/server/dist/serve.js --port 4317 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# KLI Studio (foreground dev server on http://localhost:5173)
cd packages/studio && pnpm dev
