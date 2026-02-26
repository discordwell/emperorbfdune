/**
 * inputctl.c — Command-line tool to send input commands to the DInput hook via shared memory.
 *
 * Usage:
 *   inputctl.exe click <x> <y>     Move cursor to (x,y) and click
 *   inputctl.exe move <x> <y>      Move cursor to (x,y) without clicking
 *   inputctl.exe key <dik_code>    Press and release a key (DIK_ code)
 *   inputctl.exe status            Check if hook is active (exit 0 = active)
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

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage:\n"
                        "  inputctl.exe click <x> <y>\n"
                        "  inputctl.exe move <x> <y>\n"
                        "  inputctl.exe key <dik_code>\n"
                        "  inputctl.exe status\n");
        return 1;
    }

    InputSharedState *shm = openSharedMemory();
    if (!shm) return 2;

    if (strcmp(argv[1], "status") == 0) {
        LONG ready = InterlockedCompareExchange(&shm->ready, 0, 0);
        if (ready == 1) {
            printf("Hook active\n");
            return 0;
        } else {
            printf("Hook not ready (ready=%ld)\n", ready);
            return 1;
        }
    }

    /* Verify hook is ready */
    if (InterlockedCompareExchange(&shm->ready, 0, 0) != 1) {
        fprintf(stderr, "ERROR: Hook not ready\n");
        return 2;
    }

    /* Wait for any in-progress command to finish */
    if (InterlockedCompareExchange(&shm->cmdType, 0, 0) != CMD_NONE) {
        printf("Waiting for previous command to finish...\n");
        if (waitForCompletion(shm, 5000)) {
            fprintf(stderr, "ERROR: Previous command timed out\n");
            return 3;
        }
    }

    if (strcmp(argv[1], "click") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Usage: inputctl.exe click <x> <y>\n");
            return 1;
        }
        int x = atoi(argv[2]);
        int y = atoi(argv[3]);

        /* Write command fields first, then set cmdType to trigger */
        shm->targetX = x;
        shm->targetY = y;
        InterlockedExchange(&shm->done, 0);
        InterlockedExchange(&shm->phase, 0);
        shm->frameCount = 0;
        InterlockedExchange(&shm->cmdType, CMD_CLICK);

        printf("Sent click (%d, %d) — waiting...\n", x, y);
        if (waitForCompletion(shm, 10000)) {
            fprintf(stderr, "WARNING: Click timed out after 10s\n");
            return 3;
        }
        printf("Click complete\n");
        return 0;
    }

    if (strcmp(argv[1], "move") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Usage: inputctl.exe move <x> <y>\n");
            return 1;
        }
        int x = atoi(argv[2]);
        int y = atoi(argv[3]);

        shm->targetX = x;
        shm->targetY = y;
        InterlockedExchange(&shm->done, 0);
        InterlockedExchange(&shm->phase, 0);
        shm->frameCount = 0;
        InterlockedExchange(&shm->cmdType, CMD_MOVE);

        printf("Sent move (%d, %d) — waiting...\n", x, y);
        if (waitForCompletion(shm, 10000)) {
            fprintf(stderr, "WARNING: Move timed out after 10s\n");
            return 3;
        }
        printf("Move complete\n");
        return 0;
    }

    if (strcmp(argv[1], "key") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: inputctl.exe key <dik_code>\n");
            return 1;
        }
        int dikCode = atoi(argv[2]);

        shm->keyCode = dikCode;
        InterlockedExchange(&shm->done, 0);
        InterlockedExchange(&shm->phase, 0);
        shm->frameCount = 0;
        InterlockedExchange(&shm->cmdType, CMD_KEYPRESS);

        printf("Sent key DIK_%d — waiting...\n", dikCode);
        if (waitForCompletion(shm, 10000)) {
            fprintf(stderr, "WARNING: Key press timed out after 10s\n");
            return 3;
        }
        printf("Key press complete\n");
        return 0;
    }

    fprintf(stderr, "Unknown command: %s\n", argv[1]);
    return 1;
}
