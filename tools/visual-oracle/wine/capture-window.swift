#!/usr/bin/env swift
// capture-window.swift — Capture Wine D3D window using ScreenCaptureKit.
//
// Wine's D3D rendering via MoltenVK/Metal bypasses macOS window compositing,
// making it invisible to screencapture -l and CGWindowListCreateImage. This tool
// uses ScreenCaptureKit's display-level capture with app filtering to capture
// the actual rendered content.
//
// Wine's D3D surface only renders to the capture buffer when the app is frontmost,
// so this tool briefly activates Wine before each capture. The activation is
// minimal (~0.5s) and the tool re-activates the previously-focused app afterward.
//
// Usage:
//   capture-window --wine-only <windowID> <output.png>  (capture with brief activation)
//   capture-window --find-wine                           (list wine windows)
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
    // Briefly activates Wine so D3D renders to the capture buffer, then restores
    // the previously-focused app.
    if args[1] == "--wine-only" {
        guard args.count >= 4,
              let windowID = UInt32(args[2]) else {
            fputs("Error: --wine-only <windowID> <output.png>\n", stderr)
            exit(1)
        }
        let outputPath = args[3]

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

        // Remember current foreground app so we can restore it after capture
        let previousApp = NSWorkspace.shared.frontmostApplication

        // Activate Wine so D3D surface renders to the capture buffer
        if let wineNSApp = NSRunningApplication(processIdentifier: wineApp.processID) {
            wineNSApp.activate(options: [.activateAllWindows])
        }
        // Wait for activation and D3D frame render
        try await Task.sleep(nanoseconds: 500_000_000)

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

        // Restore the previously-focused app
        if let prev = previousApp {
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
