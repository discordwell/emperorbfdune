/**
 * inputctl.c — Command-line tool to send input commands to the game.
 *
 * Usage:
 *   inputctl.exe click <x> <y> [timeout_ms]   Move cursor to (x,y) and click (DInput hook)
 *   inputctl.exe move <x> <y> [timeout_ms]    Move cursor to (x,y) without clicking
 *   inputctl.exe key <dik_code> [timeout_ms]   Press and release a key (DInput hook)
 *   inputctl.exe wmkey <vk_code>               Send key via PostMessage WM_KEYDOWN/UP
 *   inputctl.exe reset                         Force-reset shared memory (clear stuck state)
 *   inputctl.exe status                        Check if hook is active (exit 0 = active)
 *
 * The 'wmkey' command bypasses DirectInput entirely — it sends WM_KEYDOWN/WM_KEYUP
 * via PostMessage to the game window. This works during Bink video playback when
 * DirectInput polling is stopped. Use VK_ codes (e.g., 27 for VK_ESCAPE).
 *
 * On timeout, shared memory is force-reset so subsequent commands work immediately.
 *
 * Build:
 *   i686-w64-mingw32-gcc -O2 -o inputctl.exe inputctl.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dinput-ipc.h"

#define DEFAULT_TIMEOUT_MS 3000

/* ── Window message helpers (for wmkey) ───────────────────────── */

static HWND g_foundHwnd = NULL;

static BOOL CALLBACK findGameWindow(HWND hwnd, LPARAM lParam) {
    char title[256];
    (void)lParam;
    if (GetWindowTextA(hwnd, title, sizeof(title)) > 0) {
        /* Emperor: BfD uses "Dune" as window title in Wine virtual desktop */
        if (strstr(title, "Dune") != NULL || strstr(title, "EMPEROR") != NULL ||
            strstr(title, "Emperor") != NULL) {
            g_foundHwnd = hwnd;
            return FALSE;  /* Stop enumeration */
        }
    }
    return TRUE;  /* Continue */
}

/**
 * Map VK_ code to a Win32 scan code for WM_KEYDOWN lParam.
 * Uses MapVirtualKey for proper translation.
 */
static LPARAM makeKeyLParam(UINT vk, int isUp) {
    UINT scanCode = MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    LPARAM lParam = 1;                    /* repeat count = 1 */
    lParam |= (scanCode & 0xFF) << 16;   /* scan code */
    if (isUp) {
        lParam |= (1 << 30);             /* previous key state = down */
        lParam |= (1 << 31);             /* transition state = releasing */
    }
    return lParam;
}

static InputSharedState *openSharedMemory(void) {
    HANDLE hMap = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, SHM_NAME);
    if (!hMap) {
        fprintf(stderr, "ERROR: Cannot open shared memory '%s' (err %lu)\n"
                        "Is the game running with dinput-hook.dll?\n",
                SHM_NAME, GetLastError());
        return NULL;
    }

    InputSharedState *shm = (InputSharedState *)MapViewOfFile(
        hMap, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(InputSharedState)
    );
    if (!shm) {
        fprintf(stderr, "ERROR: MapViewOfFile failed: %lu\n", GetLastError());
        CloseHandle(hMap);
        return NULL;
    }

    return shm;
}

static int waitForCompletion(InputSharedState *shm, int timeoutMs) {
    int elapsed = 0;
    while (elapsed < timeoutMs) {
        if (InterlockedCompareExchange(&shm->done, 0, 0) == 1) {
            return 0;  /* Success */
        }
        Sleep(16);  /* ~1 frame at 60fps */
        elapsed += 16;
    }
    return 1;  /* Timeout */
}

/** Force-reset shared memory to clean state. Call after timeout to prevent
 *  subsequent commands from seeing stale in-progress state. */
static void forceReset(InputSharedState *shm) {
    InterlockedExchange(&shm->cmdType, CMD_NONE);
    InterlockedExchange(&shm->done, 1);
    InterlockedExchange(&shm->phase, PHASE_IDLE);
    shm->frameCount = 0;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage:\n"
                        "  inputctl.exe click <x> <y> [timeout_ms]\n"
                        "  inputctl.exe move <x> <y> [timeout_ms]\n"
                        "  inputctl.exe key <dik_code> [timeout_ms]\n"
                        "  inputctl.exe wmkey <vk_code>              (PostMessage, works during video)\n"
                        "  inputctl.exe reset\n"
                        "  inputctl.exe status\n");
        return 1;
    }

    /* wmkey/wmclick don't need shared memory — handle before opening SHM */
    if (strcmp(argv[1], "wmkey") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: inputctl.exe wmkey <vk_code>\n"
                            "  VK_ESCAPE=27  VK_RETURN=13  VK_SPACE=32\n");
            return 1;
        }
        int vk = atoi(argv[2]);

        /* Find the game window */
        g_foundHwnd = NULL;
        EnumWindows(findGameWindow, 0);
        if (!g_foundHwnd) {
            fprintf(stderr, "ERROR: Could not find game window (Dune/Emperor)\n");
            return 2;
        }

        /* Send WM_KEYDOWN + WM_KEYUP via PostMessage */
        LPARAM downLP = makeKeyLParam((UINT)vk, 0);
        LPARAM upLP   = makeKeyLParam((UINT)vk, 1);

        PostMessageA(g_foundHwnd, WM_KEYDOWN, (WPARAM)vk, downLP);
        Sleep(50);
        PostMessageA(g_foundHwnd, WM_KEYUP,   (WPARAM)vk, upLP);

        printf("Sent WM_KEY VK=%d to hwnd=%p\n", vk, (void*)g_foundHwnd);
        return 0;
    }

    if (strcmp(argv[1], "wmclick") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Usage: inputctl.exe wmclick <x> <y>\n");
            return 1;
        }
        int x = atoi(argv[2]);
        int y = atoi(argv[3]);

        /* Find the game window */
        g_foundHwnd = NULL;
        EnumWindows(findGameWindow, 0);
        if (!g_foundHwnd) {
            fprintf(stderr, "ERROR: Could not find game window (Dune/Emperor)\n");
            return 2;
        }

        /* Send WM_LBUTTONDOWN + WM_LBUTTONUP via PostMessage */
        LPARAM lParam = MAKELPARAM(x, y);
        PostMessageA(g_foundHwnd, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
        Sleep(50);
        PostMessageA(g_foundHwnd, WM_LBUTTONUP, 0, lParam);

        printf("Sent WM_CLICK (%d,%d) to hwnd=%p\n", x, y, (void*)g_foundHwnd);
        return 0;
    }

    InputSharedState *shm = openSharedMemory();
    if (!shm) return 2;

    if (strcmp(argv[1], "status") == 0) {
        LONG ready = InterlockedCompareExchange(&shm->ready, 0, 0);
        LONG cmd = InterlockedCompareExchange(&shm->cmdType, 0, 0);
        LONG phase = InterlockedCompareExchange(&shm->phase, 0, 0);
        LONG done = InterlockedCompareExchange(&shm->done, 0, 0);
        if (ready == 1) {
            printf("Hook active (cmd=%ld phase=%ld done=%ld)\n", cmd, phase, done);
            return 0;
        } else {
            printf("Hook not ready (ready=%ld)\n", ready);
            return 1;
        }
    }

    if (strcmp(argv[1], "reset") == 0) {
        forceReset(shm);
        printf("Shared memory reset\n");
        return 0;
    }

    /* Verify hook is ready */
    if (InterlockedCompareExchange(&shm->ready, 0, 0) != 1) {
        fprintf(stderr, "ERROR: Hook not ready\n");
        return 2;
    }

    /* Wait for any in-progress command to finish (short timeout) */
    if (InterlockedCompareExchange(&shm->cmdType, 0, 0) != CMD_NONE) {
        printf("Waiting for previous command to finish...\n");
        if (waitForCompletion(shm, 2000)) {
            fprintf(stderr, "WARNING: Previous command stuck — force resetting\n");
            forceReset(shm);
        }
    }

    if (strcmp(argv[1], "click") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Usage: inputctl.exe click <x> <y> [timeout_ms]\n");
            return 1;
        }
        int x = atoi(argv[2]);
        int y = atoi(argv[3]);
        int timeout = (argc >= 5) ? atoi(argv[4]) : DEFAULT_TIMEOUT_MS;

        /* Write command fields first, then set cmdType to trigger */
        shm->targetX = x;
        shm->targetY = y;
        InterlockedExchange(&shm->done, 0);
        InterlockedExchange(&shm->phase, 0);
        shm->frameCount = 0;
        InterlockedExchange(&shm->cmdType, CMD_CLICK);

        printf("Sent click (%d, %d) — waiting %dms...\n", x, y, timeout);
        if (waitForCompletion(shm, timeout)) {
            LONG phase = InterlockedCompareExchange(&shm->phase, 0, 0);
            fprintf(stderr, "WARNING: Click timed out after %dms (phase=%ld)\n", timeout, phase);
            /* Force-reset so next command works. The click's button-down
             * already registered with the game even if the full cycle
             * (hold→up) didn't complete (e.g., video started). */
            forceReset(shm);
            return 3;
        }
        printf("Click complete\n");
        return 0;
    }

    if (strcmp(argv[1], "move") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Usage: inputctl.exe move <x> <y> [timeout_ms]\n");
            return 1;
        }
        int x = atoi(argv[2]);
        int y = atoi(argv[3]);
        int timeout = (argc >= 5) ? atoi(argv[4]) : DEFAULT_TIMEOUT_MS;

        shm->targetX = x;
        shm->targetY = y;
        InterlockedExchange(&shm->done, 0);
        InterlockedExchange(&shm->phase, 0);
        shm->frameCount = 0;
        InterlockedExchange(&shm->cmdType, CMD_MOVE);

        printf("Sent move (%d, %d) — waiting %dms...\n", x, y, timeout);
        if (waitForCompletion(shm, timeout)) {
            fprintf(stderr, "WARNING: Move timed out after %dms\n", timeout);
            forceReset(shm);
            return 3;
        }
        printf("Move complete\n");
        return 0;
    }

    if (strcmp(argv[1], "key") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: inputctl.exe key <dik_code> [timeout_ms]\n");
            return 1;
        }
        int dikCode = atoi(argv[2]);
        int timeout = (argc >= 4) ? atoi(argv[3]) : DEFAULT_TIMEOUT_MS;

        shm->keyCode = dikCode;
        InterlockedExchange(&shm->done, 0);
        InterlockedExchange(&shm->phase, 0);
        shm->frameCount = 0;
        InterlockedExchange(&shm->cmdType, CMD_KEYPRESS);

        printf("Sent key DIK_%d — waiting %dms...\n", dikCode, timeout);
        if (waitForCompletion(shm, timeout)) {
            fprintf(stderr, "WARNING: Key press timed out after %dms\n", timeout);
            forceReset(shm);
            return 3;
        }
        printf("Key press complete\n");
        return 0;
    }

    fprintf(stderr, "Unknown command: %s\n", argv[1]);
    return 1;
}
