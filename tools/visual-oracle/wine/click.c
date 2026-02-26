/**
 * click.c — Send mouse click at specified coordinates inside Wine.
 *
 * Finds the game window ("Dune") and posts WM_LBUTTONDOWN/UP via PostMessage.
 * This enqueues directly to the window's message queue without affecting system
 * input state — no focus change, no DDSCL_EXCLUSIVE disruption.
 *
 * Falls back to mouse_event if FindWindow fails (e.g., wrong desktop).
 *
 * Built as a GUI app (WinMain, -mwindows) to avoid creating a console window
 * that would steal focus from the D3D game within Wine's virtual desktop.
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

    LPARAM lParam = MAKELPARAM(x, y);

    /* Try to find the game window and send directly to it */
    HWND hwnd = FindWindowA(NULL, "Dune");
    if (!hwnd) {
        /* Try DirectDraw window class */
        hwnd = FindWindowA("DirectDrawDeviceWnd", NULL);
    }

    if (hwnd) {
        /* PostMessage: enqueues to window proc, non-blocking.
         * Avoids disrupting DDSCL_EXCLUSIVE mode (no focus change).
         * Coordinates are client-relative — in Wine virtual desktop at 800x600,
         * the game window fills the desktop so client == screen coords. */
        PostMessageA(hwnd, WM_MOUSEMOVE, 0, lParam);
        Sleep(50);
        PostMessageA(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
        Sleep(50);
        PostMessageA(hwnd, WM_LBUTTONUP, 0, lParam);
        return 0;
    }

    /* Last resort: mouse_event. Uses screen-absolute coords which may differ
     * from game client coords if the window isn't at (0,0). Also disrupts
     * DDSCL_EXCLUSIVE mode. Only reached if FindWindow fails entirely. */
    SetCursorPos(x, y);
    Sleep(100);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    Sleep(100);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);

    return 2; /* fallback used */
}
