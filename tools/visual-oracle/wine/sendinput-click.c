/*
 * sendinput-click.c — Use SendInput to click in the game window
 *
 * SendInput injects events into the system input queue, the SAME path that
 * real keyboard/mouse hardware uses. Unlike PostMessage (which goes directly
 * to a window's message queue), SendInput goes through the raw input pipeline
 * that DirectInput reads from.
 *
 * Polls for the game window, waits for it to be ready, then sends clicks.
 *
 * Usage: sendinput-click.exe [x y [delay_seconds]]
 *
 * Build: i686-w64-mingw32-gcc -O2 -o sendinput-click.exe sendinput-click.c -luser32
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

static FILE* logf = NULL;
#define LOG(fmt, ...) do { \
    if (logf) { fprintf(logf, fmt "\n", ##__VA_ARGS__); fflush(logf); } \
} while(0)

int main(int argc, char* argv[]) {
    int targetX = 400, targetY = 385;
    int extraDelay = 45;
    if (argc >= 3) { targetX = atoi(argv[1]); targetY = atoi(argv[2]); }
    if (argc >= 4) { extraDelay = atoi(argv[3]); }

    logf = fopen("C:\\sendinput-log.txt", "w");
    LOG("sendinput-click started: target=(%d,%d) delay=%ds", targetX, targetY, extraDelay);

    /* Poll for game window */
    HWND hwnd = NULL;
    int attempts = 0;
    while (!hwnd && attempts < 300) {
        hwnd = FindWindowA("Dune!!!", NULL);
        if (!hwnd) {
            HWND iter = NULL;
            while ((iter = FindWindowExA(NULL, iter, NULL, NULL)) != NULL) {
                char cls[128];
                GetClassNameA(iter, cls, sizeof(cls));
                if (strstr(cls, "Dune") || strstr(cls, "dune")) {
                    hwnd = iter;
                    break;
                }
            }
        }
        if (!hwnd) {
            attempts++;
            if (attempts % 15 == 0)
                LOG("Waiting for game window (attempt %d/300)...", attempts);
            Sleep(2000);
        }
    }

    if (!hwnd) {
        LOG("TIMEOUT: game window not found");
        if (logf) fclose(logf);
        return 1;
    }

    char cls[128];
    GetClassNameA(hwnd, cls, sizeof(cls));
    LOG("Found game window: HWND=%p class=\"%s\"", hwnd, cls);

    /* Report current foreground */
    HWND fg = GetForegroundWindow();
    char fgCls[128];
    GetClassNameA(fg, fgCls, sizeof(fgCls));
    LOG("Current foreground: HWND=%p class=\"%s\" (game=%s)", fg, fgCls,
        (fg == hwnd) ? "YES" : "NO");

    /* Wait for title screen to render */
    LOG("Waiting %d seconds for title screen...", extraDelay);
    Sleep(extraDelay * 1000);

    /* Check foreground again */
    fg = GetForegroundWindow();
    GetClassNameA(fg, fgCls, sizeof(fgCls));
    LOG("Foreground now: HWND=%p class=\"%s\" (game=%s)", fg, fgCls,
        (fg == hwnd) ? "YES" : "NO");

    /* Get screen dimensions for absolute coordinates */
    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    LOG("Screen: %dx%d", screenW, screenH);

    /* Convert game coordinates to absolute (0-65535 range) */
    int absX = (targetX * 65535) / screenW;
    int absY = (targetY * 65535) / screenH;
    LOG("Absolute coords: (%d, %d) -> (%d, %d)", targetX, targetY, absX, absY);

    /* === Method 1: SendInput with absolute mouse move + click === */
    LOG("=== Method 1: SendInput absolute move + click ===");
    {
        INPUT inputs[4];
        ZeroMemory(inputs, sizeof(inputs));

        /* Move mouse to position (absolute) */
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi.dx = absX;
        inputs[0].mi.dy = absY;
        inputs[0].mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;

        UINT sent = SendInput(1, &inputs[0], sizeof(INPUT));
        LOG("Move sent: %u events", sent);
        Sleep(1000);

        /* Click down */
        inputs[1].type = INPUT_MOUSE;
        inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        sent = SendInput(1, &inputs[1], sizeof(INPUT));
        LOG("Click down sent: %u events", sent);
        Sleep(200);

        /* Click up */
        inputs[2].type = INPUT_MOUSE;
        inputs[2].mi.dwFlags = MOUSEEVENTF_LEFTUP;
        sent = SendInput(1, &inputs[2], sizeof(INPUT));
        LOG("Click up sent: %u events", sent);
        Sleep(2000);
    }

    /* === Method 2: mouse_event (older API, might reach DInput differently) === */
    LOG("=== Method 2: mouse_event ===");
    {
        mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE, absX, absY, 0, 0);
        Sleep(500);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        Sleep(200);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        LOG("mouse_event done");
        Sleep(2000);
    }

    /* === Method 3: SetCursorPos + SendInput click === */
    LOG("=== Method 3: SetCursorPos + SendInput click ===");
    {
        BOOL scpResult = SetCursorPos(targetX, targetY);
        LOG("SetCursorPos(%d,%d): %s", targetX, targetY, scpResult ? "OK" : "FAILED");
        Sleep(500);

        INPUT click[2];
        ZeroMemory(click, sizeof(click));
        click[0].type = INPUT_MOUSE;
        click[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        click[1].type = INPUT_MOUSE;
        click[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
        UINT sent = SendInput(2, click, sizeof(INPUT));
        LOG("Click sent: %u events", sent);
        Sleep(2000);
    }

    /* === Method 4: SendInput keyboard (Enter key) === */
    LOG("=== Method 4: SendInput keyboard Enter ===");
    {
        INPUT key[2];
        ZeroMemory(key, sizeof(key));
        key[0].type = INPUT_KEYBOARD;
        key[0].ki.wVk = VK_RETURN;
        key[1].type = INPUT_KEYBOARD;
        key[1].ki.wVk = VK_RETURN;
        key[1].ki.dwFlags = KEYEVENTF_KEYUP;
        UINT sent = SendInput(2, key, sizeof(INPUT));
        LOG("Enter key sent: %u events", sent);
        Sleep(2000);
    }

    /* === Method 5: SendInput keyboard Escape === */
    LOG("=== Method 5: SendInput keyboard Escape ===");
    {
        INPUT key[2];
        ZeroMemory(key, sizeof(key));
        key[0].type = INPUT_KEYBOARD;
        key[0].ki.wVk = VK_ESCAPE;
        key[1].type = INPUT_KEYBOARD;
        key[1].ki.wVk = VK_ESCAPE;
        key[1].ki.dwFlags = KEYEVENTF_KEYUP;
        UINT sent = SendInput(2, key, sizeof(INPUT));
        LOG("Escape key sent: %u events", sent);
    }

    LOG("All methods completed. Check game for response.");
    if (logf) fclose(logf);
    return 0;
}
