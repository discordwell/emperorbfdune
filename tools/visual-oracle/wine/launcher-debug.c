/*
 * launcher-debug.c — Debug launcher for Emperor: Battle for Dune
 * Uses Win32 Debug API to catch ACCESS_VIOLATION and report crash address.
 * No CRT dependency — pure Win32 API only, compatible with Windows XP.
 *
 * Build: i686-w64-mingw32-gcc -O2 -nostdlib -o launcher-debug.exe launcher-debug.c -lkernel32 -luser32 -Wl,-e,_entry
 */

#include <windows.h>
#include <tlhelp32.h>

/* GCC may emit calls to memcpy/memset for struct assignments */
void* __cdecl memcpy(void* dst, const void* src, unsigned int n) {
    char* d = (char*)dst;
    const char* s = (const char*)src;
    while (n--) *d++ = *s++;
    return dst;
}
void* __cdecl memset(void* dst, int c, unsigned int n) {
    char* d = (char*)dst;
    while (n--) *d++ = (char)c;
    return dst;
}

#define MUTEX_GUID   "48BC11BD-C4D7-466b-8A31-C6ABBAD47B3E"
#define EVENT_GUID   "D6E7FC97-64F9-4d28-B52C-754EDF721C6F"
#define MSG_BEEF     0xBEEFu
#define PAYLOAD      "UIDATA,3DDATA,MAPS"
#define GAME_DIR     "C:\\Westwood\\Emperor"
#define GAME_EXE     "C:\\Westwood\\Emperor\\GAME.EXE"

static HANDLE hLogFile = INVALID_HANDLE_VALUE;

static void print(const char* msg) {
    DWORD written;
    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
    if (hOut != INVALID_HANDLE_VALUE)
        WriteFile(hOut, msg, lstrlenA(msg), &written, NULL);
    if (hLogFile != INVALID_HANDLE_VALUE)
        WriteFile(hLogFile, msg, lstrlenA(msg), &written, NULL);
}

static void printHex(DWORD num) {
    char buf[12];
    int i;
    buf[0] = '0';
    buf[1] = 'x';
    for (i = 0; i < 8; i++) {
        int nibble = (num >> (28 - i * 4)) & 0xF;
        buf[2 + i] = nibble < 10 ? '0' + nibble : 'A' + nibble - 10;
    }
    buf[10] = 0;
    print(buf);
}

static void printNum(DWORD num) {
    char buf[12];
    int i = 11;
    buf[i] = 0;
    if (num == 0) { buf[--i] = '0'; }
    else {
        while (num > 0) {
            buf[--i] = '0' + (num % 10);
            num /= 10;
        }
    }
    print(&buf[i]);
}

void __cdecl entry(void) {
    SetCurrentDirectoryA(GAME_DIR);

    /* Open log file */
    hLogFile = CreateFileA("crash.log", GENERIC_WRITE, FILE_SHARE_READ, NULL,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);

    /* Step 1: Create mutex */
    HANDLE hMutex = CreateMutexA(NULL, FALSE, MUTEX_GUID);
    if (!hMutex) {
        print("ERROR: CreateMutex failed\r\n");
        ExitProcess(1);
    }

    /* Step 2: Create inheritable anonymous file mapping */
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    DWORD payloadSize = (DWORD)(lstrlenA(PAYLOAD) + 1);
    HANDLE hMapping = CreateFileMappingA(
        INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, payloadSize, NULL
    );
    if (!hMapping) {
        print("ERROR: CreateFileMapping failed\r\n");
        ExitProcess(1);
    }

    /* Step 3: Write payload */
    void* view = MapViewOfFile(hMapping, FILE_MAP_WRITE, 0, 0, 0);
    if (!view) {
        print("ERROR: MapViewOfFile failed\r\n");
        ExitProcess(1);
    }
    CopyMemory(view, PAYLOAD, payloadSize);
    UnmapViewOfFile(view);

    /* Step 4: Launch GAME.EXE as debuggee */
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    char cmdLine[] = GAME_EXE;
    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, TRUE,
                        DEBUG_PROCESS | DEBUG_ONLY_THIS_PROCESS,
                        NULL, GAME_DIR, &si, &pi)) {
        print("ERROR: CreateProcess failed (");
        printNum(GetLastError());
        print(")\r\n");
        ExitProcess(1);
    }
    print("Launched GAME.EXE (DEBUG) PID=");
    printNum(pi.dwProcessId);
    print(" TID=");
    printNum(pi.dwThreadId);
    print("\r\n");

    /* Step 5: Wait for GAME.EXE ready event */
    HANDLE hEvent = CreateEventA(NULL, FALSE, FALSE, EVENT_GUID);
    int eventSignaled = 0;
    int beefSent = 0;
    int gameExited = 0;
    DWORD gameExitCode = 0;

    /* Debug loop — handle debug events while also watching for the ready event */
    print("Entering debug loop...\r\n");

    while (!gameExited) {
        DEBUG_EVENT dbgEvent;
        if (!WaitForDebugEvent(&dbgEvent, 100)) {
            /* Timeout — check if event was signaled */
            if (!eventSignaled) {
                DWORD wr = WaitForSingleObject(hEvent, 0);
                if (wr == WAIT_OBJECT_0) {
                    eventSignaled = 1;
                    print("Game signaled ready\r\n");
                }
            }

            /* Send 0xBEEF once event is signaled */
            if (eventSignaled && !beefSent) {
                if (PostThreadMessageA(pi.dwThreadId, MSG_BEEF, 0, (LPARAM)hMapping)) {
                    beefSent = 1;
                    print("Sent 0xBEEF\r\n");
                }
            }
            continue;
        }

        DWORD continueStatus = DBG_CONTINUE;

        switch (dbgEvent.dwDebugEventCode) {
        case EXCEPTION_DEBUG_EVENT: {
            EXCEPTION_RECORD* er = &dbgEvent.u.Exception.ExceptionRecord;

            if (er->ExceptionCode == EXCEPTION_BREAKPOINT) {
                /* Initial breakpoint — continue */
                print("Initial breakpoint hit\r\n");
            } else if (dbgEvent.u.Exception.dwFirstChance) {
                /* First chance exception */
                if (er->ExceptionCode == 0xC0000005) {
                    print("\r\n=== ACCESS VIOLATION (first chance) ===\r\n");
                    print("Address: ");
                    printHex((DWORD)er->ExceptionAddress);
                    print("\r\n");

                    if (er->NumberParameters >= 2) {
                        if (er->ExceptionInformation[0] == 0) {
                            print("Type: READ from ");
                        } else {
                            print("Type: WRITE to ");
                        }
                        printHex((DWORD)er->ExceptionInformation[1]);
                        print("\r\n");
                    }

                    /* Get thread context for registers */
                    HANDLE hThread = OpenThread(THREAD_ALL_ACCESS, FALSE, dbgEvent.dwThreadId);
                    if (hThread) {
                        CONTEXT ctx;
                        ctx.ContextFlags = CONTEXT_FULL;
                        if (GetThreadContext(hThread, &ctx)) {
                            print("EAX="); printHex(ctx.Eax);
                            print(" EBX="); printHex(ctx.Ebx);
                            print(" ECX="); printHex(ctx.Ecx);
                            print(" EDX="); printHex(ctx.Edx);
                            print("\r\n");
                            print("ESI="); printHex(ctx.Esi);
                            print(" EDI="); printHex(ctx.Edi);
                            print(" EBP="); printHex(ctx.Ebp);
                            print(" ESP="); printHex(ctx.Esp);
                            print("\r\n");
                            print("EIP="); printHex(ctx.Eip);
                            print("\r\n");

                            /* Walk stack (simple: read return addresses from stack) */
                            print("Stack trace (return addresses):\r\n");
                            DWORD* sp = (DWORD*)(DWORD_PTR)ctx.Esp;
                            DWORD stackBuf[32];
                            SIZE_T bytesRead;
                            if (ReadProcessMemory(pi.hProcess, sp, stackBuf, sizeof(stackBuf), &bytesRead)) {
                                int count = bytesRead / 4;
                                if (count > 32) count = 32;
                                int shown = 0;
                                for (int j = 0; j < count && shown < 16; j++) {
                                    /* Heuristic: likely code addresses are 0x00400000-0x7FFFFFFF */
                                    if (stackBuf[j] >= 0x00400000 && stackBuf[j] < 0x80000000) {
                                        print("  [ESP+");
                                        printHex(j * 4);
                                        print("] = ");
                                        printHex(stackBuf[j]);
                                        print("\r\n");
                                        shown++;
                                    }
                                }
                            }
                        }
                        CloseHandle(hThread);
                    }

                    /* Enumerate loaded modules */
                    print("\r\nLoaded modules:\r\n");
                    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pi.dwProcessId);
                    if (hSnap != INVALID_HANDLE_VALUE) {
                        MODULEENTRY32 me;
                        me.dwSize = sizeof(MODULEENTRY32);
                        if (Module32First(hSnap, &me)) {
                            do {
                                print("  ");
                                printHex((DWORD)(DWORD_PTR)me.modBaseAddr);
                                print("-");
                                printHex((DWORD)(DWORD_PTR)me.modBaseAddr + me.modBaseSize);
                                print(" ");
                                print(me.szModule);
                                print("\r\n");
                            } while (Module32Next(hSnap, &me));
                        }
                        CloseHandle(hSnap);
                    }

                    /* Let the exception pass through (don't handle it) */
                    continueStatus = DBG_EXCEPTION_NOT_HANDLED;
                } else {
                    /* Other first-chance exceptions — pass through */
                    continueStatus = DBG_EXCEPTION_NOT_HANDLED;
                }
            } else {
                /* Second chance (unhandled) exception */
                print("\r\n=== UNHANDLED EXCEPTION ===\r\n");
                print("Code: ");
                printHex(er->ExceptionCode);
                print(" at ");
                printHex((DWORD)er->ExceptionAddress);
                print("\r\n");

                /* Terminate the process */
                TerminateProcess(pi.hProcess, er->ExceptionCode);
                gameExited = 1;
                gameExitCode = er->ExceptionCode;
            }
            break;
        }

        case CREATE_THREAD_DEBUG_EVENT:
            break;
        case EXIT_THREAD_DEBUG_EVENT:
            break;
        case CREATE_PROCESS_DEBUG_EVENT:
            /* Close the file handle we're given */
            if (dbgEvent.u.CreateProcessInfo.hFile)
                CloseHandle(dbgEvent.u.CreateProcessInfo.hFile);
            break;
        case LOAD_DLL_DEBUG_EVENT:
            if (dbgEvent.u.LoadDll.hFile)
                CloseHandle(dbgEvent.u.LoadDll.hFile);
            break;
        case UNLOAD_DLL_DEBUG_EVENT:
            break;
        case OUTPUT_DEBUG_STRING_EVENT: {
            /* Read the debug string from the process */
            DWORD len = dbgEvent.u.DebugString.nDebugStringLength;
            if (len > 0 && len < 1024) {
                char buf[1024];
                SIZE_T bytesRead;
                if (ReadProcessMemory(pi.hProcess,
                        dbgEvent.u.DebugString.lpDebugStringData,
                        buf, len, &bytesRead)) {
                    buf[bytesRead] = 0;
                    print("DBG: ");
                    print(buf);
                    print("\r\n");
                }
            }
            break;
        }
        case EXIT_PROCESS_DEBUG_EVENT:
            gameExitCode = dbgEvent.u.ExitProcess.dwExitCode;
            gameExited = 1;
            print("Game exited code=");
            printNum(gameExitCode);
            print("\r\n");
            break;
        }

        /* Check for ready event between debug events */
        if (!eventSignaled) {
            DWORD wr = WaitForSingleObject(hEvent, 0);
            if (wr == WAIT_OBJECT_0) {
                eventSignaled = 1;
                print("Game signaled ready\r\n");
            }
        }
        if (eventSignaled && !beefSent) {
            if (PostThreadMessageA(pi.dwThreadId, MSG_BEEF, 0, (LPARAM)hMapping)) {
                beefSent = 1;
                print("Sent 0xBEEF\r\n");
            }
        }

        if (!gameExited)
            ContinueDebugEvent(dbgEvent.dwProcessId, dbgEvent.dwThreadId, continueStatus);
    }

    CloseHandle(hEvent);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(hMapping);
    CloseHandle(hMutex);
    if (hLogFile != INVALID_HANDLE_VALUE)
        CloseHandle(hLogFile);

    ExitProcess(gameExitCode != 0 ? 1 : 0);
}
