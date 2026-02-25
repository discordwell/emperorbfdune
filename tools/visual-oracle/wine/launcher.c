/*
 * launcher.c — Minimal launcher for Emperor: Battle for Dune
 *
 * GAME.EXE requires an IPC handoff from the original EMPEROR.EXE:
 *   1. Launcher creates a mutex (GAME.EXE checks if it already exists)
 *   2. Launcher creates an anonymous file mapping with "UIDATA,3DDATA,MAPS"
 *   3. Launcher starts GAME.EXE with bInheritHandles=TRUE
 *   4. GAME.EXE signals an event when its message loop is ready
 *   5. Launcher posts the mapping handle via PostThreadMessageA(0xBEEF)
 *
 * Based on reverse-engineering by wheybags (wheybags.com/blog/emperor.html)
 * and the EmperorLauncher project (github.com/wheybags/EmperorLauncher).
 *
 * Build: i686-w64-mingw32-gcc -O2 -o launcher.exe launcher.c
 */

#include <windows.h>
#include <string.h>
#include <stdio.h>

#define MUTEX_GUID   "48BC11BD-C4D7-466b-8A31-C6ABBAD47B3E"
#define EVENT_GUID   "D6E7FC97-64F9-4d28-B52C-754EDF721C6F"
#define MSG_BEEF     0xBEEFu
#define PAYLOAD      "UIDATA,3DDATA,MAPS"
#define GAME_DIR     "C:\\Westwood\\Emperor"
#define GAME_EXE     "C:\\Westwood\\Emperor\\GAME.EXE"
#define WAIT_TIMEOUT_MS 300000

int main(int argc, char* argv[]) {
    /* Set working directory to the game directory */
    SetCurrentDirectoryA(GAME_DIR);

    /* Step 1: Create mutex so GAME.EXE detects the launcher is running */
    HANDLE hMutex = CreateMutexA(NULL, FALSE, MUTEX_GUID);
    if (!hMutex) {
        printf("ERROR: CreateMutex failed (%lu)\n", GetLastError());
        return 1;
    }

    /* Step 2: Create inheritable anonymous file mapping */
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    DWORD payloadSize = (DWORD)(strlen(PAYLOAD) + 1);
    HANDLE hMapping = CreateFileMappingA(
        INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, payloadSize, NULL
    );
    if (!hMapping) {
        printf("ERROR: CreateFileMapping failed (%lu)\n", GetLastError());
        CloseHandle(hMutex);
        return 1;
    }

    /* Step 3: Write payload into the mapping */
    void* view = MapViewOfFile(hMapping, FILE_MAP_WRITE, 0, 0, 0);
    if (!view) {
        printf("ERROR: MapViewOfFile failed (%lu)\n", GetLastError());
        CloseHandle(hMapping);
        CloseHandle(hMutex);
        return 1;
    }
    memcpy(view, PAYLOAD, payloadSize);
    UnmapViewOfFile(view);

    /* Step 4: Launch GAME.EXE with handle inheritance */
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    char cmdLine[] = GAME_EXE;
    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, TRUE, 0, NULL, GAME_DIR, &si, &pi)) {
        printf("ERROR: CreateProcess failed (%lu)\n", GetLastError());
        CloseHandle(hMapping);
        CloseHandle(hMutex);
        return 1;
    }
    printf("Launched GAME.EXE (PID=%lu, TID=%lu)\n", pi.dwProcessId, pi.dwThreadId);

    /* Step 5: Create event and wait for GAME.EXE to signal readiness */
    HANDLE hEvent = CreateEventA(NULL, FALSE, FALSE, EVENT_GUID);
    HANDLE waitHandles[2] = { hEvent, pi.hProcess };
    printf("Waiting for game to be ready...\n");
    DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, WAIT_TIMEOUT_MS);

    if (waitResult == WAIT_OBJECT_0) {
        printf("Game signaled ready\n");
    } else if (waitResult == WAIT_OBJECT_0 + 1) {
        printf("Game process exited before signaling ready\n");
        DWORD exitCode;
        GetExitCodeProcess(pi.hProcess, &exitCode);
        printf("Exit code: %lu\n", exitCode);
        CloseHandle(hEvent);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        CloseHandle(hMapping);
        CloseHandle(hMutex);
        return 1;
    } else if (waitResult == WAIT_TIMEOUT) {
        printf("Timeout waiting for game (continuing anyway)\n");
    } else {
        printf("WaitForMultipleObjects failed (%lu)\n", GetLastError());
    }

    /* Step 6: Post the file mapping handle to GAME.EXE's main thread */
    if (!PostThreadMessageA(pi.dwThreadId, MSG_BEEF, 0, (LPARAM)hMapping)) {
        printf("WARNING: PostThreadMessage failed (%lu), retrying after 1s...\n", GetLastError());
        Sleep(1000);
        PostThreadMessageA(pi.dwThreadId, MSG_BEEF, 0, (LPARAM)hMapping);
    }
    printf("Sent 0xBEEF message with mapping handle\n");

    /* Step 7: Wait for GAME.EXE to exit */
    printf("Waiting for game to exit...\n");
    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exitCode;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    printf("Game exited with code %lu\n", exitCode);

    CloseHandle(hEvent);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(hMapping);
    CloseHandle(hMutex);

    return 0;
}
