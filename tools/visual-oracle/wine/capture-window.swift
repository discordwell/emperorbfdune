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
//   capture-window --batch --activate --restore --windowid <id> --ops wineclick:405;420,wait:3000,capture:/tmp/after.png
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

/// Parse --windowid N from args. Returns window ID.
func parseWindowID() -> UInt32? {
    for (i, arg) in args.enumerated() {
        if arg == "--windowid" && i + 1 < args.count {
            return UInt32(args[i + 1])
        }
    }
    return nil
}

/// Parse a named string arg (e.g., --wine-bin /path/to/wine).
func parseStringArg(_ name: String) -> String? {
    for (i, arg) in args.enumerated() {
        if arg == name && i + 1 < args.count {
            return args[i + 1]
        }
    }
    return nil
}

/// Send an input command via Wine's inputctl.exe (DInput hook shared memory IPC).
/// Injects synthetic DirectInput state directly into GAME.EXE's input polling —
/// the only approach that works with DirectInput 7 EXCLUSIVE mode.
/// No macOS focus disruption, no D3D rendering interruption.
///
/// Commands: "click <x> <y>", "move <x> <y>", "key <dikCode>"
func sendInputCtl(command: String, args cmdArgs: [String], wineBin: String, winePrefix: String, inputctlExe: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: wineBin)
    // Launch inside the Emperor desktop (same desktop = same WINEPREFIX session)
    task.arguments = ["explorer", "/desktop=Emperor,1024x768", inputctlExe, command] + cmdArgs
    task.environment = ProcessInfo.processInfo.environment.merging(
        ["WINEPREFIX": winePrefix], uniquingKeysWith: { _, new in new }
    )
    task.standardError = FileHandle.nullDevice
    let pipe = Pipe()
    task.standardOutput = pipe

    do {
        try task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if task.terminationStatus == 0 {
            print("inputctl \(command) \(cmdArgs.joined(separator: " ")) — OK (\(output))")
        } else {
            fputs("Warning: inputctl \(command) exited with status \(task.terminationStatus): \(output)\n", stderr)
        }
    } catch {
        fputs("Warning: inputctl failed: \(error)\n", stderr)
    }
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
    //   capture:/path/to/file.png          — take screenshot, save to path
    //   wineclick:gameX;gameY              — click at game-space coords via DInput hook
    //   winekey:dikCode                    — key press via DInput hook (DIK_ scan code)
    //   verifiedclick:gameX;gameY[;waitMs] — click + verify screen changed (retries 3x)
    //   warmup:maxSeconds                  — poll until D3D renders real content
    //   wait:ms                            — wait N milliseconds
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

        // Parse Wine config for wineclick/winekey ops
        let wineBin = parseStringArg("--wine-bin") ?? "/opt/homebrew/bin/wine"
        let winePrefix = parseStringArg("--wine-prefix") ?? ""
        let inputctlExe = parseStringArg("--inputctl-exe") ?? ""

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
        var freshWindow = freshContent.windows.first(where: { $0.windowID == CGWindowID(windowID) }) ?? window
        var freshDisplay = freshContent.displays.first ?? display
        var freshApps = freshContent.applications
        print("Window after activation: \(Int(freshWindow.frame.width))x\(Int(freshWindow.frame.height)) at (\(Int(freshWindow.frame.origin.x)),\(Int(freshWindow.frame.origin.y)))")

        // Re-query helper: get fresh window/display/apps (display mode may change during warmup)
        func refreshState() async throws -> (SCWindow, SCDisplay, [SCRunningApplication]) {
            let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let w = c.windows.first(where: { $0.windowID == CGWindowID(windowID) }) ?? freshWindow
            let d = c.displays.first ?? freshDisplay
            return (w, d, c.applications)
        }

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

            case "winekey":
                // Send keyboard input via DInput hook's shared memory IPC.
                // inputctl.exe writes key command → hook injects into GetDeviceState.
                // No focus disruption — input goes directly into DirectInput.
                //
                // Format: winekey:<dikCode> (e.g., winekey:28 for DIK_RETURN)
                if let dikCode = Int(opArg) {
                    guard !inputctlExe.isEmpty else {
                        fputs("Warning: winekey requires --inputctl-exe\n", stderr)
                        break
                    }
                    sendInputCtl(command: "key", args: ["\(dikCode)"],
                                 wineBin: wineBin, winePrefix: winePrefix, inputctlExe: inputctlExe)
                    // Brief settle time for game to process the key
                    try await Task.sleep(nanoseconds: 200_000_000) // 200ms
                } else {
                    fputs("Warning: invalid winekey code '\(opArg)', expected integer\n", stderr)
                }

            case "wineclick":
                // Click via DInput hook's shared memory IPC.
                // inputctl.exe writes click command → hook injects mouse deltas + button
                // state across multiple game frames via GetDeviceState.
                // No macOS focus disruption — bypasses OS input entirely.
                //
                // Coordinates stay in game space (0-799, 0-599). The DInput hook
                // handles relative delta translation internally.
                // Format: wineclick:gameX;gameY
                let wcParts = opArg.split(separator: ";")
                if wcParts.count == 2, let gx = Int(wcParts[0]), let gy = Int(wcParts[1]) {
                    guard !inputctlExe.isEmpty else {
                        fputs("Warning: wineclick requires --inputctl-exe\n", stderr)
                        break
                    }
                    print("Click: game (\(gx),\(gy)) via DInput hook")
                    sendInputCtl(command: "click", args: ["\(gx)", "\(gy)"],
                                 wineBin: wineBin, winePrefix: winePrefix, inputctlExe: inputctlExe)
                    // Brief settle time for game to process the click
                    try await Task.sleep(nanoseconds: 300_000_000) // 300ms
                } else {
                    fputs("Warning: invalid wineclick coords '\(opArg)', expected gameX;gameY\n", stderr)
                }

            case "verifiedclick":
                // Game-space click with verification: capture before, click, capture after,
                // retry up to 3 times if captures are identical (click didn't register).
                // Uses DInput hook via inputctl.exe for DirectInput compatibility.
                // Format: verifiedclick:gameX;gameY;waitMs (waitMs = post-click settle time)
                let vcParts = opArg.split(separator: ";")
                if vcParts.count >= 2, let gx = Int(vcParts[0]), let gy = Int(vcParts[1]) {
                    let waitMs: UInt64 = vcParts.count >= 3 ? (UInt64(vcParts[2]) ?? 2000) : 2000

                    // Capture before click
                    let beforeImage = try await captureFrame(
                        display: freshDisplay, wineApp: wineApp,
                        window: freshWindow, applications: freshApps
                    )

                    for clickAttempt in 1...3 {
                        guard !inputctlExe.isEmpty else {
                            fputs("Warning: verifiedclick requires --inputctl-exe\n", stderr)
                            break
                        }
                        sendInputCtl(command: "click", args: ["\(gx)", "\(gy)"],
                                     wineBin: wineBin, winePrefix: winePrefix, inputctlExe: inputctlExe)
                        // No re-activation needed — DInput hook doesn't disrupt focus
                        try await Task.sleep(nanoseconds: waitMs * 1_000_000)

                        // Capture after click
                        let afterImage = try await captureFrame(
                            display: freshDisplay, wineApp: wineApp,
                            window: freshWindow, applications: freshApps
                        )

                        // Compare: different dimensions = definitely changed.
                        // Same dimensions: compare raw pixel data via PNG size heuristic.
                        let beforeSize = beforeImage.width * beforeImage.height
                        let afterSize = afterImage.width * afterImage.height
                        if beforeSize != afterSize {
                            print("Verified click at (\(Int(gx)),\(Int(gy))) — screen changed (attempt \(clickAttempt))")
                            break
                        }

                        // Save both to temp PNGs and compare file sizes
                        let tmpBefore = "/tmp/ebfd-vclick-before.png"
                        let tmpAfter = "/tmp/ebfd-vclick-after.png"
                        try savePNG(beforeImage, to: tmpBefore)
                        try savePNG(afterImage, to: tmpAfter)
                        let sizeBefore = (try? FileManager.default.attributesOfItem(atPath: tmpBefore)[.size] as? Int) ?? 0
                        let sizeAfter = (try? FileManager.default.attributesOfItem(atPath: tmpAfter)[.size] as? Int) ?? 0
                        try? FileManager.default.removeItem(atPath: tmpBefore)
                        try? FileManager.default.removeItem(atPath: tmpAfter)

                        // >5% size difference = screen likely changed
                        let diff = abs(sizeBefore - sizeAfter)
                        let threshold = max(sizeBefore, sizeAfter) / 20 // 5%
                        if diff > threshold {
                            print("Verified click at (\(Int(gx)),\(Int(gy))) — screen changed (attempt \(clickAttempt), delta \(diff) bytes)")
                            break
                        }

                        if clickAttempt < 3 {
                            fputs("Click attempt \(clickAttempt) at (\(Int(gx)),\(Int(gy))) — no screen change, retrying...\n", stderr)
                        } else {
                            fputs("WARNING: Click at (\(Int(gx)),\(Int(gy))) — no screen change after 3 attempts\n", stderr)
                        }
                    }
                } else {
                    fputs("Warning: invalid verifiedclick coords '\(opArg)', expected gameX;gameY[;waitMs]\n", stderr)
                }

            case "warmup":
                // Poll until D3D renders real content. Re-queries window state each attempt
                // because display mode may change (1024x768 → 800x600) during warmup.
                // If display mode reverts (Wine lost focus), re-activates Wine.
                // Format: warmup:maxSeconds (default 60)
                let maxSeconds = Int(opArg) ?? 60
                let warmupDeadline = Date().addingTimeInterval(TimeInterval(maxSeconds))
                var warmupSuccess = false
                var warmupAttempt = 0
                while Date() < warmupDeadline {
                    warmupAttempt += 1
                    try await Task.sleep(nanoseconds: 3_000_000_000) // 3s between probes

                    let (probeWindow, probeDisplay, probeApps) = try await refreshState()
                    let probeSize = "\(Int(probeWindow.frame.width))x\(Int(probeWindow.frame.height))"

                    // If display mode reverted (not 800x600), re-activate Wine.
                    // D3D DDSCL_EXCLUSIVE loses display mode when Wine goes to background.
                    if probeWindow.frame.width > 800 || probeWindow.frame.height > 600 {
                        fputs("Warmup probe \(warmupAttempt): \(probeSize) — re-activating Wine\n", stderr)
                        _ = try await activateWine(wineApp: wineApp)
                        continue
                    }

                    let probeImage = try await captureFrame(
                        display: probeDisplay, wineApp: wineApp,
                        window: probeWindow, applications: probeApps
                    )

                    // Save to temp and check file size
                    let tmpPath = "/tmp/ebfd-warmup-probe.png"
                    try savePNG(probeImage, to: tmpPath)
                    let probeFileSize = (try? FileManager.default.attributesOfItem(atPath: tmpPath)[.size] as? Int) ?? 0
                    try? FileManager.default.removeItem(atPath: tmpPath)

                    print("Warmup probe \(warmupAttempt): \(probeSize), \(probeFileSize) bytes")

                    // >100KB = real D3D content (not blank desktop)
                    if probeFileSize > 100_000 {
                        print("Warmup complete after \(warmupAttempt) probes — D3D rendering confirmed")
                        // Update fresh state for subsequent ops
                        freshWindow = probeWindow
                        freshDisplay = probeDisplay
                        freshApps = probeApps
                        warmupSuccess = true
                        break
                    }
                }
                if !warmupSuccess {
                    fputs("WARNING: Warmup timed out after \(maxSeconds)s — captures may be blank\n", stderr)
                    // Update state anyway in case display mode changed
                    let (w, d, a) = try await refreshState()
                    freshWindow = w
                    freshDisplay = d
                    freshApps = a
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
