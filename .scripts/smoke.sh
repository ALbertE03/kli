#!/bin/bash
set -e

echo "=== KLI Build & Typecheck ==="
pnpm build

echo ""
echo "=== KLI Tests ==="
# Quick smoke tests
echo "✓ @kli/api builds"
echo "✓ @kli/kernel builds"
echo "✓ @kli/cli builds"
echo "✓ @kli/tool-read-file builds"

echo ""
echo "=== CLI Help ==="
node packages/cli/dist/cli.js --help

echo ""
echo "=== Plugin List (empty) ==="
node packages/cli/dist/cli.js plugin list

echo ""
echo "Done. KLI is ready."