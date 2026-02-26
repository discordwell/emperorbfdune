/**
 * click.c — Send mouse click at specified coordinates inside Wine.
 *
 * Uses Windows API (SetCursorPos + mouse_event) which goes through Wine's
 * internal input pipeline — the same path the game uses via DirectInput.
 * This bypasses macOS input handling entirely.
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

    /* Move cursor to target position */
    SetCursorPos(x, y);
    Sleep(100);  /* Let the game's input polling pick up the move */

    /* Click: down then up */
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    Sleep(100);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);

    return 0;
}
