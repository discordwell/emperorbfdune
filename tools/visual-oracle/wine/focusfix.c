/*
 * focusfix.c — Give the game window foreground focus
 *
 * DirectInput7 in DISCL_FOREGROUND | DISCL_EXCLUSIVE mode requires the
 * game's window to be the foreground window. After launcher.exe hides
 * the console, the game window may still not be foreground.
 *
 * This tool enumerates all windows, finds the game's D3D window, and
 * calls SetForegroundWindow + friends to give it focus.
 *
 * Build: i686-w64-mingw32-gcc -O2 -o focusfix.exe focusfix.c -luser32
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>

static HWND g_gameHwnd = NULL;
static DWORD g_gamePid = 0;

BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
    DWORD pid;
    DWORD tid = GetWindowThreadProcessId(hwnd, &pid);

    char title[256] = {0};
    GetWindowTextA(hwnd, title, sizeof(title));

    char className[256] = {0};
    GetClassNameA(hwnd, className, sizeof(className));

    LONG style = GetWindowLongA(hwnd, GWL_STYLE);
    LONG exStyle = GetWindowLongA(hwnd, GWL_EXSTYLE);

    RECT rect;
    GetWindowRect(hwnd, &rect);
    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;

    /* Report all visible windows */
    if (IsWindowVisible(hwnd)) {
        printf("  HWND=%08X PID=%lu TID=%lu %dx%d style=%08lX ex=%08lX class=\"%s\" title=\"%s\"\n",
               (unsigned)(UINT_PTR)hwnd, pid, tid, w, h, style, exStyle, className, title);
    }

    /* Look for the game window:
     * - DirectDraw fullscreen windows often have WS_POPUP style
     * - The window might have no title or a title like "Emperor"
     * - It should be 800x600 (the game's resolution)
     * - Class is often something like "WineD3DClass" or "DirectDrawDeviceWnd"
     */
    if (IsWindowVisible(hwnd) && w >= 640 && h >= 480) {
        /* Prefer the largest visible window that isn't a desktop/shell window */
        if (strcmp(className, "Progman") != 0 &&
            strcmp(className, "Shell_TrayWnd") != 0 &&
            strcmp(className, "ConsoleWindowClass") != 0 &&
            strcmp(className, "IME") != 0 &&
            strcmp(className, "#32770") != 0) {
            printf("  >>> Candidate game window: HWND=%08X class=\"%s\" %dx%d\n",
                   (unsigned)(UINT_PTR)hwnd, className, w, h);
            g_gameHwnd = hwnd;
            g_gamePid = pid;
        }
    }

    return TRUE;
}

int main(int argc, char* argv[]) {
    /* Report current foreground window */
    HWND fg = GetForegroundWindow();
    char fgTitle[256] = {0};
    char fgClass[256] = {0};
    if (fg) {
        GetWindowTextA(fg, fgTitle, sizeof(fgTitle));
        GetClassNameA(fg, fgClass, sizeof(fgClass));
    }
    printf("Current foreground: HWND=%08X class=\"%s\" title=\"%s\"\n\n",
           (unsigned)(UINT_PTR)fg, fgClass, fgTitle);

    printf("Enumerating visible windows:\n");
    EnumWindows(EnumWindowsProc, 0);
    printf("\n");

    if (!g_gameHwnd) {
        printf("ERROR: No game window found!\n");
        return 1;
    }

    printf("Setting focus to game window HWND=%08X (PID=%lu)...\n",
           (unsigned)(UINT_PTR)g_gameHwnd, g_gamePid);

    /* Use AttachThreadInput trick to bypass SetForegroundWindow restrictions */
    DWORD myTid = GetCurrentThreadId();
    DWORD gameTid = GetWindowThreadProcessId(g_gameHwnd, NULL);
    DWORD fgTid = GetWindowThreadProcessId(fg, NULL);

    printf("  My TID=%lu, Game TID=%lu, FG TID=%lu\n", myTid, gameTid, fgTid);

    /* Attach our input queue to the foreground window's thread */
    BOOL attached1 = AttachThreadInput(myTid, fgTid, TRUE);
    BOOL attached2 = AttachThreadInput(myTid, gameTid, TRUE);
    printf("  Attached to FG: %d, Attached to Game: %d\n", attached1, attached2);

    /* Now we should be able to set foreground */
    BOOL r1 = SetForegroundWindow(g_gameHwnd);
    printf("  SetForegroundWindow: %d\n", r1);

    BringWindowToTop(g_gameHwnd);
    SetActiveWindow(g_gameHwnd);
    SetFocus(g_gameHwnd);

    /* Also send WM_ACTIVATE to make sure the game processes it */
    SendMessage(g_gameHwnd, WM_ACTIVATE, WA_ACTIVE, 0);
    SendMessage(g_gameHwnd, WM_SETFOCUS, 0, 0);

    /* Detach */
    if (attached1) AttachThreadInput(myTid, fgTid, FALSE);
    if (attached2) AttachThreadInput(myTid, gameTid, FALSE);

    /* Verify */
    Sleep(500);
    HWND newFg = GetForegroundWindow();
    char newTitle[256] = {0};
    GetWindowTextA(newFg, newTitle, sizeof(newTitle));
    printf("\nNew foreground: HWND=%08X title=\"%s\" (game=%s)\n",
           (unsigned)(UINT_PTR)newFg, newTitle,
           (newFg == g_gameHwnd) ? "YES" : "NO");

    return (newFg == g_gameHwnd) ? 0 : 1;
}
