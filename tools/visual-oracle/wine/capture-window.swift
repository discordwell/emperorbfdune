#!/usr/bin/env swift
// capture-window.swift — Capture Wine D3D window using ScreenCaptureKit.
//
// Wine's D3D rendering via MoltenVK/Metal bypasses macOS window compositing,
// making it invisible to screencapture -l and CGWindowListCreateImage. This tool
// uses ScreenCaptureKit's display-level capture with app filtering to capture
// the actual rendered content.
//
// Wine's D3D surface only renders to the capture buffer when the app is frontmost.
// Focus management via flags:
//   --activate: activate Wine (bring to front) before capture
//   --restore:  restore previously-focused app after capture
//
// Usage:
//   capture-window --batch --activate --restore --windowid <id> --ops capture:/tmp/a.png,wait:1000,capture:/tmp/b.png
//   capture-window --batch --activate --restore --windowid <id> --ops gameclick:404;407,wait:3000,capture:/tmp/after.png
//   capture-window --find-wine
//
// Build: swiftc -O -o capture-window capture-window.swift \
//          -framework ScreenCaptureKit -framework CoreGraphics -framework ImageIO -framework AppKit

import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import AppKit

let _ = NSApplication.shared

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("""
    Usage: \(args[0]) --batch --windowid <id> --ops <ops> [--activate] [--restore]
           \(args[0]) --find-wine

    """, stderr)
    exit(1)
}

func savePNG(_ image: CGImage, to outputPath: String) throws {
    let url = URL(fileURLWithPath: outputPath) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil) else {
        fputs("Error: could not create image destination\n", stderr)
        exit(1)
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else {
        fputs("Error: could not finalize image\n", stderr)
        exit(1)
    }
    let fileSize = try FileManager.default.attributesOfItem(atPath: outputPath)[.size] as? Int ?? 0
    print("Saved to \(outputPath) (\(fileSize) bytes)")
}

/// Send a mouse click at screen coordinates via CGEvent.
func sendClick(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)

    // Move mouse to position
    if let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                mouseCursorPosition: point, mouseButton: .left) {
        moveEvent.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.1)

    // Mouse down
    if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                mouseCursorPosition: point, mouseButton: .left) {
        downEvent.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.05)

    // Mouse up
    if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                              mouseCursorPosition: point, mouseButton: .left) {
        upEvent.post(tap: .cghidEventTap)
    }

    print("Clicked at screen (\(Int(x)), \(Int(y)))")
}

/// Parse --windowid N from args. Returns window ID.
func parseWindowID() -> UInt32? {
    for (i, arg) in args.enumerated() {
        if arg == "--windowid" && i + 1 < args.count {
            return UInt32(args[i + 1])
        }
    }
    return nil
}

/// Activate Wine and wait for D3D to render. Returns the previous app.
@MainActor
func activateWine(wineApp: SCRunningApplication) async throws -> NSRunningApplication? {
    let previousApp = NSWorkspace.shared.frontmostApplication

    let wineNSApp = NSRunningApplication(processIdentifier: wineApp.processID)

    for attempt in 1...5 {
        wineNSApp?.activate(options: [.activateAllWindows])
        try await Task.sleep(nanoseconds: 500_000_000) // 0.5s

        if let frontmost = NSWorkspace.shared.frontmostApplication,
           frontmost.processIdentifier == wineApp.processID {
            print("Wine activated (attempt \(attempt))")
            break
        }

        if attempt < 5 {
            fputs("Activation attempt \(attempt) failed, retrying...\n", stderr)
            if attempt >= 3 {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                task.arguments = ["-e", """
                    tell application "System Events"
                        set wineProcs to every process whose name contains "wine"
                        repeat with p in wineProcs
                            set frontmost of p to true
                        end repeat
                    end tell
                """]
                try? task.run()
                task.waitUntilExit()
            }
        } else {
            fputs("WARNING: Could not activate Wine after 5 attempts\n", stderr)
        }
    }

    // Wait for D3D frame render after activation.
    // D3D's Metal surface needs several seconds to start presenting frames
    // after being in the background. 5s gives reliable results.
    try await Task.sleep(nanoseconds: 5_000_000_000) // 5s
    return previousApp
}

/// Capture a single frame from the Wine window.
@MainActor
func captureFrame(display: SCDisplay, wineApp: SCRunningApplication,
                  window: SCWindow, applications: [SCRunningApplication]) async throws -> CGImage {
    let nonWineApps = applications.filter { $0.processID != wineApp.processID }
    let filter = SCContentFilter(
        display: display,
        excludingApplications: nonWineApps,
        exceptingWindows: []
    )

    let config = SCStreamConfiguration()
    config.width = Int(window.frame.width) * 2
    config.height = Int(window.frame.height) * 2
    config.showsCursor = false
    config.captureResolution = .best
    config.sourceRect = window.frame

    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

@MainActor
func run() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

    // --find-wine: list all wine windows
    if args[1] == "--find-wine" {
        for w in content.windows {
            let app = w.owningApplication?.applicationName ?? ""
            if app.lowercased().contains("wine") || (w.title ?? "").contains("Dune") {
                let onScreen = w.isOnScreen ? "on" : "off"
                print("WID=\(w.windowID) title=\(w.title ?? "(none)") app=\(app) \(onScreen)screen frame=\(w.frame)")
            }
        }
        exit(0)
    }

    // --batch: batch mode. Activate once, execute ops (captures/clicks/waits), restore once.
    // ONE focus steal for the entire session.
    //
    // Operations via --ops (comma-separated):
    //   capture:/path/to/file.png   — take screenshot, save to path
    //   click:x;y                   — send mouse click at screen coords (semicolon separator)
    //   gameclick:gameX;gameY        — click at game-space coords (translated via fresh window bounds)
    //   wait:ms                     — wait N milliseconds
    if args[1] == "--batch" {
        let activate = args.contains("--activate")
        let restore = args.contains("--restore")

        guard let windowID = parseWindowID() else {
            fputs("Error: --batch requires --windowid <id>\n", stderr)
            exit(1)
        }

        guard let window = content.windows.first(where: { $0.windowID == CGWindowID(windowID) }) else {
            fputs("Error: window \(windowID) not found\n", stderr)
            exit(1)
        }

        guard let wineApp = window.owningApplication else {
            fputs("Error: window has no owning application\n", stderr)
            exit(1)
        }

        guard let display = content.displays.first else {
            fputs("Error: no display found\n", stderr)
            exit(1)
        }

        // Parse --ops list
        var ops: [(String, String)] = []  // (type, arg)
        for (i, arg) in args.enumerated() {
            if arg == "--ops" && i + 1 < args.count {
                for opStr in args[i + 1].split(separator: ",") {
                    let parts = opStr.split(separator: ":", maxSplits: 1)
                    if parts.count == 2 {
                        ops.append((String(parts[0]), String(parts[1])))
                    }
                }
            }
        }

        guard !ops.isEmpty else {
            fputs("Error: --batch requires --ops\n", stderr)
            exit(1)
        }

        // Activate Wine once
        var previousApp: NSRunningApplication? = nil
        if activate {
            previousApp = try await activateWine(wineApp: wineApp)
        }

        // Re-query window state AFTER activation.
        // Wine's D3D SetDisplayMode changes the window from 1024x768 → 800x600
        // only when Wine is frontmost. We need the updated frame for captures.
        let freshContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let freshWindow = freshContent.windows.first(where: { $0.windowID == CGWindowID(windowID) }) ?? window
        let freshDisplay = freshContent.displays.first ?? display
        let freshApps = freshContent.applications
        print("Window after activation: \(Int(freshWindow.frame.width))x\(Int(freshWindow.frame.height)) at (\(Int(freshWindow.frame.origin.x)),\(Int(freshWindow.frame.origin.y)))")

        // Execute operations sequentially
        var captureCount = 0
        let totalCaptures = ops.filter { $0.0 == "capture" }.count
        for (opType, opArg) in ops {
            switch opType {
            case "capture":
                captureCount += 1
                let image = try await captureFrame(
                    display: freshDisplay, wineApp: wineApp,
                    window: freshWindow, applications: freshApps
                )
                print("Captured \(captureCount)/\(totalCaptures): \(image.width)x\(image.height)")
                try savePNG(image, to: opArg)

            case "click":
                let parts = opArg.split(separator: ";")
                if parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]) {
                    sendClick(x: x, y: y)
                } else {
                    fputs("Warning: invalid click coords '\(opArg)', expected x;y\n", stderr)
                }

            case "gameclick":
                // Game-space click: translate using fresh window bounds (post-activation)
                let gcParts = opArg.split(separator: ";")
                if gcParts.count == 2, let gx = Double(gcParts[0]), let gy = Double(gcParts[1]) {
                    let screenX = Double(freshWindow.frame.origin.x) + gx
                    let screenY = Double(freshWindow.frame.origin.y) + gy
                    sendClick(x: screenX, y: screenY)
                } else {
                    fputs("Warning: invalid gameclick coords '\(opArg)', expected gameX;gameY\n", stderr)
                }

            case "wait":
                if let ms = UInt64(opArg) {
                    try await Task.sleep(nanoseconds: ms * 1_000_000)
                }

            default:
                fputs("Warning: unknown op '\(opType)'\n", stderr)
            }
        }

        // Restore once
        if restore, let prev = previousApp {
            prev.activate(options: [])
        }

        exit(0)
    }

    fputs("Error: unknown command \(args[1]). Use --batch or --find-wine.\n", stderr)
    exit(1)
}

Task { @MainActor in
    do {
        try await run()
    } catch {
        fputs("Error: \(error)\n", stderr)
        exit(1)
    }
}

RunLoop.main.run()
