/**
 * keypress.c — Send keyboard input inside Wine's virtual desktop.
 *
 * Strategy 1: keybd_event() — injects into the system input stream, which
 *   DirectInput's keyboard device buffer reads from. This is the keyboard
 *   equivalent of mouse_event() for mice.
 * Strategy 2: PostMessage WM_KEYDOWN/WM_KEYUP — fallback for games that
 *   process keyboard through the window message queue.
 *
 * Both strategies are tried: keybd_event first (for DirectInput), then
 * PostMessage (for WM-based input).
 *
 * Must be launched inside the same Wine virtual desktop as the game:
 *   wine explorer /desktop=Emperor,1024x768 keypress.exe <vkCode>
 *
 * Virtual key codes: VK_RETURN=13, VK_ESCAPE=27, VK_SPACE=32,
 *   '1'=49, '2'=50, '3'=51, VK_UP=38, VK_DOWN=40
 *
 * Compile: i686-w64-mingw32-gcc -O2 -mwindows -o keypress.exe keypress.c -luser32
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance,
                   LPSTR lpCmdLine, int nCmdShow) {
    int vk = 0;

    if (sscanf(lpCmdLine, "%d", &vk) != 1 || vk < 1 || vk > 255) {
        return 1;
    }

    /* Find the game window and give it focus */
    HWND hwnd = FindWindowA(NULL, "Dune");
    if (!hwnd) {
        return 2;
    }

    /* Set the game window as foreground — needed for keybd_event to route
     * to the correct DirectInput device acquisition context. */
    SetForegroundWindow(hwnd);
    SetFocus(hwnd);
    Sleep(50);

    /* Strategy 1: keybd_event — injects into system input stream.
     * DirectInput reads keyboard state from the input stream, not WM messages. */
    UINT scanCode = MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    keybd_event((BYTE)vk, (BYTE)scanCode, 0, 0);               /* key down */
    Sleep(50);
    keybd_event((BYTE)vk, (BYTE)scanCode, KEYEVENTF_KEYUP, 0); /* key up */
    Sleep(50);

    /* Strategy 2: PostMessage WM_KEYDOWN/WM_KEYUP as fallback.
     * Some games process keyboard through the window procedure. */
    LPARAM lParamDown = 1 | (scanCode << 16);
    LPARAM lParamUp = 1 | (scanCode << 16) | (1 << 30) | (1 << 31);
    PostMessageA(hwnd, WM_KEYDOWN, (WPARAM)vk, lParamDown);
    Sleep(50);
    PostMessageA(hwnd, WM_KEYUP, (WPARAM)vk, lParamUp);

    return 0;
}
