/**
 * click.c — Send mouse click at specified coordinates inside Wine.
 *
 * Uses PostMessage WM_LBUTTONDOWN/WM_LBUTTONUP to the game window.
 * PostMessage enqueues to the window proc without affecting system
 * input state — no DDSCL_EXCLUSIVE disruption, no D3D mode change.
 * Coordinates are game client-relative (800x600 space).
 *
 * mouse_event()/SendInput() disrupt D3D exclusive mode on Wine/macOS,
 * causing blank captures after clicks. PostMessage avoids this.
 *
 * Must be launched inside the same Wine virtual desktop as the game:
 *   wine explorer /desktop=Emperor,1024x768 click.exe 405 420
 *
 * Built as a GUI app (WinMain, -mwindows) to avoid creating a console window.
 *
 * Usage: click.exe <x> <y>
 * Compile: i686-w64-mingw32-gcc -O2 -mwindows -o click.exe click.c -luser32
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance,
                   LPSTR lpCmdLine, int nCmdShow) {
    int x = 0, y = 0;

    /* Parse "x y" from command line */
    if (sscanf(lpCmdLine, "%d %d", &x, &y) != 2) {
        return 1;
    }

    /* Find the game window */
    HWND hwnd = FindWindowA(NULL, "Dune");
    if (!hwnd) {
        return 2;
    }

    /* Move the cursor FIRST — game likely uses GetCursorPos for hit testing,
     * not the coordinates in WM_LBUTTONDOWN.
     * Then PostMessage the click — enqueues to window proc without
     * disrupting D3D exclusive mode (unlike mouse_event). */
    SetCursorPos(x, y);
    Sleep(50);
    LPARAM lParam = MAKELPARAM(x, y);
    PostMessageA(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
    Sleep(100);
    PostMessageA(hwnd, WM_LBUTTONUP, 0, lParam);

    return 0;
}
