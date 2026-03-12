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
 * Build: i686-w64-mingw32-gcc -O2 -o launcher.exe launcher.c -luser32
 */

#include <windows.h>
#include <string.h>
#include <stdio.h>

#define MUTEX_GUID   "48BC11BD-C4D7-466b-8A31-C6ABBAD47B3E"
#define EVENT_GUID   "D6E7FC97-64F9-4d28-B52C-754EDF721C6F"
#define MSG_BEEF     0xBEEFu
#define PAYLOAD      "UIDATA,3DDATA,MAPS"
#define WAIT_TIMEOUT_MS 300000

/* ASFW_ANY: allow any process to set foreground */
#ifndef ASFW_ANY
#define ASFW_ANY ((DWORD)-1)
#endif

/* Log to both console and file */
static FILE* logFile = NULL;
#define LOG(fmt, ...) do { \
    if (logFile) { fprintf(logFile, fmt "\n", ##__VA_ARGS__); fflush(logFile); } \
    printf(fmt "\n", ##__VA_ARGS__); fflush(stdout); \
} while(0)

int main(int argc, char* argv[]) {
    logFile = fopen("C:\\launcher-log.txt", "w");

    /* Auto-detect game directory from launcher's own location */
    char gameDir[MAX_PATH];
    GetModuleFileNameA(NULL, gameDir, MAX_PATH);
    char* lastSlash = gameDir;
    for (char* p = gameDir; *p; p++) {
        if (*p == '\\' || *p == '/') lastSlash = p;
    }
    *lastSlash = '\0';

    char gameExe[MAX_PATH];
    lstrcpyA(gameExe, gameDir);
    lstrcatA(gameExe, "\\GAME.EXE");

    LOG("Game dir: %s", gameDir);
    LOG("Game exe: %s", gameExe);
    SetCurrentDirectoryA(gameDir);

    /* Step 1: Create mutex */
    HANDLE hMutex = CreateMutexA(NULL, FALSE, MUTEX_GUID);
    if (!hMutex) { LOG("ERROR: CreateMutex failed (%lu)", GetLastError()); return 1; }

    /* Step 2: Create inheritable file mapping */
    SECURITY_ATTRIBUTES sa = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
    DWORD payloadSize = (DWORD)(strlen(PAYLOAD) + 1);
    HANDLE hMapping = CreateFileMappingA(
        INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, payloadSize, NULL);
    if (!hMapping) { LOG("ERROR: CreateFileMapping failed"); CloseHandle(hMutex); return 1; }

    /* Step 3: Write payload */
    void* view = MapViewOfFile(hMapping, FILE_MAP_WRITE, 0, 0, 0);
    if (!view) { LOG("ERROR: MapViewOfFile failed"); CloseHandle(hMapping); CloseHandle(hMutex); return 1; }
    memcpy(view, PAYLOAD, payloadSize);
    UnmapViewOfFile(view);

    /* CRITICAL: Grant foreground permission BEFORE launching the game.
     *
     * The game uses DirectInput7 with DISCL_EXCLUSIVE | DISCL_FOREGROUND.
     * DInput::Acquire() only succeeds when the game's window is foreground.
     * The game calls SetCooperativeLevel + Acquire at startup — if it's not
     * foreground at that exact moment, mouse input will NEVER work (the game
     * does NOT re-acquire on WM_ACTIVATEAPP).
     *
     * AllowSetForegroundWindow(ASFW_ANY) lets ANY process call
     * SetForegroundWindow. When the game's DirectDraw SetCooperativeLevel
     * internally calls SetForegroundWindow, it will succeed because we
     * pre-authorized it.
     *
     * We also hide the console window so it doesn't visually compete.
     */
    LOG("Pre-authorizing foreground for game (ASFW_ANY)");
    AllowSetForegroundWindow(ASFW_ANY);

    /* Hide console window so game's D3D window is the only visible window */
    HWND hConsole = GetConsoleWindow();
    if (hConsole) {
        ShowWindow(hConsole, SW_HIDE);
        LOG("Console window hidden");
    }

    /* Step 4: Launch GAME.EXE with handle inheritance */
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    char cmdLine[MAX_PATH];
    lstrcpyA(cmdLine, gameExe);
    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, TRUE, 0, NULL, gameDir, &si, &pi)) {
        LOG("ERROR: CreateProcess failed (%lu)", GetLastError());
        CloseHandle(hMapping); CloseHandle(hMutex); return 1;
    }
    LOG("Launched GAME.EXE (PID=%lu, TID=%lu)", pi.dwProcessId, pi.dwThreadId);

    /* Also grant the specific game PID foreground rights */
    AllowSetForegroundWindow(pi.dwProcessId);

    /* Step 5: Wait for GAME.EXE to signal readiness */
    HANDLE hEvent = CreateEventA(NULL, FALSE, FALSE, EVENT_GUID);
    HANDLE waitHandles[2] = { hEvent, pi.hProcess };
    LOG("Waiting for game to be ready...");
    DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, WAIT_TIMEOUT_MS);

    if (waitResult == WAIT_OBJECT_0) {
        LOG("Game signaled ready");
    } else if (waitResult == WAIT_OBJECT_0 + 1) {
        DWORD exitCode; GetExitCodeProcess(pi.hProcess, &exitCode);
        LOG("Game exited before signaling ready (code=%lu)", exitCode);
        CloseHandle(hEvent); CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
        CloseHandle(hMapping); CloseHandle(hMutex); return 1;
    } else if (waitResult == WAIT_TIMEOUT) {
        LOG("Timeout waiting for game (continuing anyway)");
    } else {
        LOG("WaitForMultipleObjects failed (%lu)", GetLastError());
    }

    /* Step 6: Post the file mapping handle to GAME.EXE's main thread */
    if (!PostThreadMessageA(pi.dwThreadId, MSG_BEEF, 0, (LPARAM)hMapping)) {
        LOG("PostThreadMessage failed (%lu), retrying...", GetLastError());
        Sleep(1000);
        PostThreadMessageA(pi.dwThreadId, MSG_BEEF, 0, (LPARAM)hMapping);
    }
    LOG("Sent 0xBEEF message with mapping handle");

    /* Step 7: Detach from console so it can never interfere with game focus */
    LOG("Detaching console");
    FreeConsole();

    /* Step 8: Wait for GAME.EXE to exit */
    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exitCode; GetExitCodeProcess(pi.hProcess, &exitCode);
    if (logFile) fprintf(logFile, "Game exited with code %lu\n", exitCode);

    CloseHandle(hEvent); CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    CloseHandle(hMapping); CloseHandle(hMutex);
    if (logFile) fclose(logFile);
    return 0;
}
