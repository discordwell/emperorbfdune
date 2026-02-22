#!/usr/bin/env bash
# Serve the Emperor: Battle for Dune web game locally.
# Usage: bash tools/serve.sh [port]
#
# Builds a production bundle with esbuild, then serves the project root
# on localhost using Python's built-in HTTP server (port 8080 by default).

set -e
cd "$(dirname "$0")/.."

PORT="${1:-8080}"

echo "Building game..."
npm run build --silent 2>&1

echo ""
echo "==================================="
echo " Emperor: Battle for Dune"
echo " http://localhost:${PORT}"
echo "==================================="
echo ""

# Use Python's built-in HTTP server (no extra deps needed)
python3 -m http.server "$PORT" --bind 127.0.0.1
