/*
 * clickwindow.c — Wait for game window then send WM_LBUTTONDOWN
 *
 * Polls every 2 seconds for a window with class "Dune!!!", then sends
 * WM_MOUSEMOVE + WM_LBUTTONDOWN + WM_LBUTTONUP at the specified coords.
 * Designed to run in background BEFORE the game starts.
 *
 * Usage: clickwindow.exe [x y [delay_seconds]]
 * Default: x=400 y=385 delay=30
 *
 * Build: i686-w64-mingw32-gcc -O2 -o clickwindow.exe clickwindow.c -luser32
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char* argv[]) {
    int x = 400, y = 385;
    int extraDelay = 30;  /* seconds to wait after finding window */
    if (argc >= 3) {
        x = atoi(argv[1]);
        y = atoi(argv[2]);
    }
    if (argc >= 4) {
        extraDelay = atoi(argv[3]);
    }

    FILE* log = fopen("C:\\clickwindow-log.txt", "w");
    if (log) fprintf(log, "clickwindow started: target=(%d,%d) delay=%ds\n", x, y, extraDelay);

    /* Poll for game window */
    HWND hwnd = NULL;
    int attempts = 0;
    while (!hwnd && attempts < 300) {
        hwnd = FindWindowA("Dune!!!", NULL);
        if (!hwnd) {
            /* Also try by iterating windows with the game's PID characteristics */
            HWND iter = NULL;
            while ((iter = FindWindowExA(NULL, iter, NULL, NULL)) != NULL) {
                char cls[128];
                GetClassNameA(iter, cls, sizeof(cls));
                /* Match any window class containing "Dune" */
                if (strstr(cls, "Dune") || strstr(cls, "dune")) {
                    hwnd = iter;
                    break;
                }
            }
        }
        if (!hwnd) {
            attempts++;
            if (log && (attempts % 30 == 0))
                fprintf(log, "Waiting for game window (attempt %d/300)...\n", attempts);
            Sleep(2000);
        }
    }

    if (!hwnd) {
        if (log) { fprintf(log, "TIMEOUT: game window not found after 600s\n"); fclose(log); }
        return 1;
    }

    char cls[128];
    GetClassNameA(hwnd, cls, sizeof(cls));
    if (log) fprintf(log, "Found game window: HWND=%p class=\"%s\"\n", hwnd, cls);

    /* Wait extra time for the game to fully render the title screen */
    if (log) fprintf(log, "Waiting %d seconds for title screen render...\n", extraDelay);
    fflush(log);
    Sleep(extraDelay * 1000);

    LPARAM coords = MAKELPARAM(x, y);

    /* Send mouse messages */
    if (log) fprintf(log, "Sending WM_MOUSEMOVE at (%d,%d)...\n", x, y);
    PostMessageA(hwnd, WM_MOUSEMOVE, 0, coords);
    Sleep(1000);
    PostMessageA(hwnd, WM_MOUSEMOVE, 0, coords);
    Sleep(500);

    if (log) fprintf(log, "Sending WM_LBUTTONDOWN...\n");
    PostMessageA(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, coords);
    Sleep(500);

    if (log) fprintf(log, "Sending WM_LBUTTONUP...\n");
    PostMessageA(hwnd, WM_LBUTTONUP, 0, coords);
    Sleep(500);

    /* Try SendMessage as well */
    if (log) fprintf(log, "Sending via SendMessage...\n");
    SendMessageA(hwnd, WM_MOUSEMOVE, 0, coords);
    Sleep(200);
    SendMessageA(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, coords);
    Sleep(200);
    SendMessageA(hwnd, WM_LBUTTONUP, 0, coords);

    /* Also try WM_NCHITTEST + WM_SETCURSOR chain (some apps need this) */
    if (log) fprintf(log, "Sending WM_SETCURSOR + WM_NCHITTEST...\n");
    SendMessageA(hwnd, WM_SETCURSOR, (WPARAM)hwnd, MAKELPARAM(HTCLIENT, WM_LBUTTONDOWN));
    SendMessageA(hwnd, WM_MOUSEMOVE, 0, coords);
    Sleep(200);
    SendMessageA(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, coords);
    Sleep(200);
    SendMessageA(hwnd, WM_LBUTTONUP, 0, coords);

    if (log) { fprintf(log, "All messages sent. Done!\n"); fclose(log); }
    return 0;
}
