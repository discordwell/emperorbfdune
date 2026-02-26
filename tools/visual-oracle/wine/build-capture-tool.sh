#!/bin/bash
# Build the capture-window tool as a signed .app bundle.
# The .app bundle is needed so macOS can properly track Screen Recording
# permission — bare ad-hoc binaries don't show up in System Settings.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/CaptureWindow.app"
MACOS="$APP/Contents/MacOS"
BUNDLE_ID="com.emperorbfdune.capture-window"

mkdir -p "$MACOS"

echo "Compiling capture-window.swift..."
swiftc -O -o "$MACOS/capture-window" "$DIR/capture-window.swift" \
  -framework ScreenCaptureKit \
  -framework CoreGraphics \
  -framework ImageIO \
  -framework AppKit

echo "Signing .app bundle..."
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"

echo "Done: $APP"
echo "If Screen Recording permission is needed, add CaptureWindow.app in:"
echo "  System Settings > Privacy & Security > Screen Recording"
