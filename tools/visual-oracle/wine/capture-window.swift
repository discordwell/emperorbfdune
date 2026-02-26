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
// For single captures, pass both: --activate --restore
// For batch captures: first=--activate, middle=neither, last=--restore
//
// Usage:
//   capture-window --wine-only <windowID> <output.png>                          (capture only)
//   capture-window --wine-only --activate --restore <windowID> <output.png>     (full cycle)
//   capture-window --wine-only --activate <windowID> <output.png>               (activate, no restore)
//   capture-window --wine-only --restore <windowID> <output.png>                (restore after capture)
//   capture-window --find-wine                                                   (list wine windows)
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
    Usage: \(args[0]) --wine-only <windowID> <output.png>
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

    // --wine-only: capture display filtered to Wine app, crop to window bounds.
    // Uses excludingApplications (not including:) because Wine has no bundle ID
    // and the including: filter fails with -3811 for unbundled apps.
    // CALLER must ensure Wine is frontmost before invoking — this tool does NOT
    // activate Wine itself.
    if args[1] == "--wine-only" {
        // Parse flags
        let activate = args.contains("--activate")
        let restore = args.contains("--restore")
        let positionalArgs = args.dropFirst(2).filter { !$0.hasPrefix("--") }
        guard positionalArgs.count >= 2,
              let windowID = UInt32(positionalArgs[positionalArgs.startIndex]) else {
            fputs("Error: --wine-only [--activate] [--restore] <windowID> <output.png>\n", stderr)
            exit(1)
        }
        let outputPath = positionalArgs[positionalArgs.startIndex + 1]

        // Find the target window
        guard let window = content.windows.first(where: { $0.windowID == CGWindowID(windowID) }) else {
            fputs("Error: window \(windowID) not found\n", stderr)
            exit(1)
        }

        // Find the Wine app
        guard let wineApp = window.owningApplication else {
            fputs("Error: window has no owning application\n", stderr)
            exit(1)
        }

        guard let display = content.displays.first else {
            fputs("Error: no display found\n", stderr)
            exit(1)
        }

        // Save current app before any activation (needed for --restore)
        let previousApp = NSWorkspace.shared.frontmostApplication

        // If --activate: bring Wine to front and wait for D3D render
        if activate {
            if let wineNSApp = NSRunningApplication(processIdentifier: wineApp.processID) {
                wineNSApp.activate(options: [.activateAllWindows])
            }
            // Wait for activation + D3D frame render.
            // 2s is needed: ~200ms for macOS activation, plus time for Wine's D3D
            // to restart rendering after being in the background. Games often pause
            // their render loop when inactive, so D3D needs to "warm up" again.
            try await Task.sleep(nanoseconds: 2_000_000_000)
        }

        // Exclude all apps except Wine — captures display showing only Wine's content
        let nonWineApps = content.applications.filter { $0.processID != wineApp.processID }
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

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        print("Captured: \(image.width)x\(image.height) (window \(windowID): \(window.title ?? "?"))")
        try savePNG(image, to: outputPath)

        // If --restore: bring back the previously-focused app
        if restore, let prev = previousApp {
            prev.activate(options: [])
        }

        exit(0)
    }

    fputs("Error: unknown command \(args[1]). Use --wine-only or --find-wine.\n", stderr)
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
