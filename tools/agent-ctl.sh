#!/bin/bash
# Agent control script — CLI for monitoring and controlling the campaign agent
# Usage: ./tools/agent-ctl.sh <command>
#
# Commands:
#   status    — Read current telemetry (from server or title)
#   console   — Read recent console output
#   refresh   — Reload the game tab
#   title     — Read current tab title
#   start     — Start telemetry server (background)
#   stop      — Stop telemetry server

TELEMETRY_URL="http://localhost:8081"
ARTIFACTS_DIR="$(dirname "$0")/../artifacts"

case "${1:-status}" in
  status)
    # Try telemetry server first, fall back to file
    curl -s "$TELEMETRY_URL/telemetry" 2>/dev/null || {
      if [ -f "$ARTIFACTS_DIR/agent-telemetry.json" ]; then
        cat "$ARTIFACTS_DIR/agent-telemetry.json"
      else
        echo "No telemetry available. Is the server running? (./tools/agent-ctl.sh start)"
      fi
    }
    ;;
  console)
    LINES="${2:-50}"
    curl -s "$TELEMETRY_URL/console" 2>/dev/null | tail -n "$LINES" || {
      if [ -f "$ARTIFACTS_DIR/agent-console.log" ]; then
        tail -n "$LINES" "$ARTIFACTS_DIR/agent-console.log"
      else
        echo "No console log available."
      fi
    }
    ;;
  title)
    osascript -e '
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "localhost:8080" then
            return title of t
          end if
        end repeat
      end repeat
      return "Game tab not found"
    end tell' 2>&1
    ;;
  refresh)
    osascript -e '
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "localhost:8080" then
            tell t to reload
            return "Reloaded"
          end if
        end repeat
      end repeat
      return "Game tab not found"
    end tell' 2>&1
    ;;
  start)
    echo "Starting telemetry server..."
    node "$(dirname "$0")/telemetry-server.mjs" &
    echo "PID: $!"
    ;;
  stop)
    pkill -f "telemetry-server.mjs" && echo "Stopped" || echo "Not running"
    ;;
  *)
    echo "Usage: $0 {status|console|title|refresh|start|stop}"
    ;;
esac
