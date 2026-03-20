/**
 * dinput-hook.c — Proxy DLL that intercepts DirectInput7 to inject synthetic input.
 *
 * Emperor: Battle for Dune uses DirectInput 7 in EXCLUSIVE mode for mouse input.
 * Every external input method fails (Win32 APIs, CGEvent, AppleScript mouse) because
 * DirectInput bypasses the OS input subsystem entirely.
 *
 * This proxy replaces dinput.dll in the game directory. Wine's WINEDLLOVERRIDES="dinput=n"
 * forces the native DLL search order, loading our proxy first. We then load the real
 * Wine dinput implementation from C:\windows\system32\dinput_real.dll (a renamed copy).
 *
 * COM vtable hooking:
 *   - IDirectInput7A::CreateDevice (vtable[3]) → intercept device creation
 *   - IDirectInput7A::CreateDeviceEx (vtable[9]) → intercept device creation (DInput7 API)
 *   - IDirectInputDevice7A::GetDeviceState (vtable[9]) → inject synthetic input
 *   - IDirectInputDevice7A::GetDeviceData (vtable[10]) → inject buffered input events
 *
 * IPC via named shared memory "Emperor_DInput_Hook":
 *   - inputctl.exe writes commands (click, move, keypress)
 *   - GetDeviceState hook reads commands and injects synthetic state across game frames
 *
 * Build:
 *   i686-w64-mingw32-gcc -shared -O2 -o dinput.dll dinput-hook.c dinput.def \
 *       -ldxguid -luser32 -lole32
 */

#define CINTERFACE
#define COBJMACROS
#define INITGUID

#include <winsock2.h>
#include <windows.h>
#include <dinput.h>
#include <stdio.h>

#include "dinput-ipc.h"

/* --- Globals --- */

static HMODULE g_realDInput = NULL;
static InputSharedState *g_shm = NULL;
static HANDLE g_shmHandle = NULL;

/* Forward declaration of logging function */
static void hookLog(const char *fmt, ...);

/* --- Win32 API hooks (GetAsyncKeyState, GetKeyState, GetCursorPos) ---
 *
 * The game's title screen menu ignores ALL synthetic mouse button input:
 * DInput GetDeviceState/GetDeviceData, SendInput, mouse_event, PostMessage,
 * SendMessage — none register as clicks on menu buttons.
 *
 * Hypothesis: the menu code uses GetAsyncKeyState(VK_LBUTTON) or
 * GetKeyState(VK_LBUTTON) to poll button state, and GetCursorPos() for
 * hit-testing. These Win32 APIs read hardware state that QEMU virtual
 * hardware may not update from QMP-injected events.
 *
 * Solution: IAT-hook these functions in the game's import table so we
 * return controlled values during click injection phases.
 * If IAT hook fails (game doesn't import them directly), use inline
 * (trampoline) hooks on the actual user32.dll functions.
 */
typedef SHORT (WINAPI *GetAsyncKeyState_t)(int vKey);
typedef SHORT (WINAPI *GetKeyState_t)(int nVirtKey);
typedef BOOL  (WINAPI *GetCursorPos_t)(LPPOINT lpPoint);

static GetAsyncKeyState_t g_origGetAsyncKeyState = NULL;
static GetKeyState_t      g_origGetKeyState = NULL;
static GetCursorPos_t     g_origGetCursorPos = NULL;

/* Inline hook trampolines — executable buffers that hold saved preamble bytes
 * plus a JMP back to original+N. Used when IAT hooks fail. */
static BYTE g_gasTrampoline[32] __attribute__((aligned(16)));
static BYTE g_gksTrampoline[32] __attribute__((aligned(16)));
static BYTE g_gcpTrampoline[32] __attribute__((aligned(16)));

/* Install a 5-byte inline (detour) hook on a function.
 * Overwrites the first 5 bytes with JMP rel32 to hookFunc.
 * Builds a trampoline in trampolineBuf that executes the saved 5 bytes
 * then jumps back to target+5.
 * Returns the trampoline address (callable as the original function).
 * WARNING: assumes the first 5 bytes are a clean instruction boundary. */
static FARPROC installInlineHook(FARPROC target, FARPROC hookFunc,
                                  BYTE *trampolineBuf, int trampolineSize) {
    if (!target || !hookFunc || !trampolineBuf || trampolineSize < 16)
        return NULL;

    /* Make trampoline buffer executable */
    DWORD oldProt;
    VirtualProtect(trampolineBuf, trampolineSize, PAGE_EXECUTE_READWRITE, &oldProt);

    /* Copy first 5 bytes of target to trampoline */
    memcpy(trampolineBuf, (void *)target, 5);

    /* Append JMP rel32 back to target+5 */
    trampolineBuf[5] = 0xE9; /* JMP rel32 */
    DWORD jmpBack = (DWORD)((BYTE *)target + 5) - (DWORD)(trampolineBuf + 10);
    memcpy(trampolineBuf + 6, &jmpBack, 4);

    /* Overwrite target's first 5 bytes with JMP to hookFunc */
    VirtualProtect((void *)target, 5, PAGE_EXECUTE_READWRITE, &oldProt);
    ((BYTE *)target)[0] = 0xE9; /* JMP rel32 */
    DWORD jmpHook = (DWORD)hookFunc - (DWORD)((BYTE *)target + 5);
    memcpy((BYTE *)target + 1, &jmpHook, 4);
    VirtualProtect((void *)target, 5, oldProt, &oldProt);

    hookLog("Inline hook: target=%p -> hook=%p, trampoline=%p",
            (void *)target, (void *)hookFunc, (void *)trampolineBuf);

    return (FARPROC)trampolineBuf;
}

/* Saved device pointers for identifying mouse vs keyboard in GetDeviceState */
static LPDIRECTINPUTDEVICEA g_mouseDevice = NULL;
static LPDIRECTINPUTDEVICEA g_keyboardDevice = NULL;

/* Capture game's hwnd for direct message injection */
static HWND g_gameHwnd = NULL;

/* Keyboard cooperative level hook */
typedef HRESULT (WINAPI *SetCooperativeLevel_t)(LPDIRECTINPUTDEVICEA, HWND, DWORD);
static SetCooperativeLevel_t g_origKbdSetCooperativeLevel = NULL;

/* Background wake thread */
static HANDLE g_wakeThread = NULL;
static volatile LONG g_wakeThreadStop = 0;

/* Original vtable function pointers */
typedef HRESULT (WINAPI *CreateDevice_t)(LPDIRECTINPUTA, REFGUID, LPDIRECTINPUTDEVICEA*, LPUNKNOWN);
static CreateDevice_t g_origCreateDevice = NULL;

/* CreateDeviceEx — IDirectInput7A vtable[9]. Same as CreateDevice but with REFIID param.
 * Emperor: BfD calls this instead of CreateDevice since it uses DirectInput 7. */
typedef HRESULT (WINAPI *CreateDeviceEx_t)(LPDIRECTINPUTA, REFGUID, REFIID, LPVOID*, LPUNKNOWN);
static CreateDeviceEx_t g_origCreateDeviceEx = NULL;

typedef HRESULT (WINAPI *GetDeviceState_t)(LPDIRECTINPUTDEVICEA, DWORD, LPVOID);
static GetDeviceState_t g_origMouseGetDeviceState = NULL;
static GetDeviceState_t g_origKeyboardGetDeviceState = NULL;

typedef HRESULT (WINAPI *GetDeviceData_t)(LPDIRECTINPUTDEVICEA, DWORD, LPDIDEVICEOBJECTDATA, LPDWORD, DWORD);
static GetDeviceData_t g_origMouseGetDeviceData = NULL;

/* SetEventNotification hook — captures the event handle for waking the game */
typedef HRESULT (WINAPI *SetEventNotification_t)(LPDIRECTINPUTDEVICEA, HANDLE);
static SetEventNotification_t g_origMouseSetEventNotification = NULL;
static HANDLE g_mouseEventHandle = NULL;
static HANDLE g_privateMouseEventHandle = NULL;

/* SetDataFormat hook — logs the mouse data format the game uses */
typedef HRESULT (WINAPI *SetDataFormat_t)(LPDIRECTINPUTDEVICEA, LPCDIDATAFORMAT);
static SetDataFormat_t g_origMouseSetDataFormat = NULL;

/* SetProperty hook — logs buffer size and other properties */
typedef HRESULT (WINAPI *SetProperty_t)(LPDIRECTINPUTDEVICEA, REFGUID, LPCDIPROPHEADER);
static SetProperty_t g_origMouseSetProperty = NULL;

/* Acquire hook — logs and ensures mouse device acquisition succeeds */
typedef HRESULT (WINAPI *Acquire_t)(LPDIRECTINPUTDEVICEA);
static Acquire_t g_origMouseAcquire = NULL;

/* SetCooperativeLevel hook — logs cooperative level flags */
typedef HRESULT (WINAPI *SetCooperativeLevel_t)(LPDIRECTINPUTDEVICEA, HWND, DWORD);
static SetCooperativeLevel_t g_origMouseSetCooperativeLevel = NULL;

/* Debug logging to file (OutputDebugString unreliable in Wine) */
static FILE *g_logFile = NULL;
static volatile LONG g_logValidated = 0; /* 0=not validated since snapshot restore */

static void hookLog(const char *fmt, ...) {
    /* After QEMU snapshot restore, g_logFile is a stale FILE* (valid pointer
     * but invalid fd). Detect this by attempting a write and checking ferror.
     * Re-open the file if stale. Only validate once per session. */
    if (!g_logFile) {
        g_logFile = fopen("dinput-hook.log", "a");
        if (!g_logFile) return;
        g_logValidated = 1;
    } else if (!g_logValidated) {
        /* First call after snapshot restore: test if the FILE* is still valid */
        if (fprintf(g_logFile, "") < 0 || fflush(g_logFile) == EOF || ferror(g_logFile)) {
            fclose(g_logFile);
            g_logFile = fopen("dinput-hook.log", "a");
            if (!g_logFile) return;
        }
        g_logValidated = 1;
    }
    va_list args;
    va_start(args, fmt);
    vfprintf(g_logFile, fmt, args);
    va_end(args);
    fprintf(g_logFile, "\n");
    fflush(g_logFile);
}

/* --- IAT (Import Address Table) hooking ---
 *
 * Walk the PE import table of the given module, find the import for
 * dllName!funcName, and replace its address with hookFunc.
 * Returns the original function address, or NULL if not found.
 */
static FARPROC hookIAT(HMODULE module, const char *dllName,
                       const char *funcName, FARPROC hookFunc) {
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return NULL;

    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((BYTE *)module + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return NULL;

    DWORD importRVA = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (!importRVA) return NULL;

    IMAGE_IMPORT_DESCRIPTOR *imports = (IMAGE_IMPORT_DESCRIPTOR *)((BYTE *)module + importRVA);

    for (; imports->Name; imports++) {
        const char *name = (const char *)((BYTE *)module + imports->Name);
        if (_stricmp(name, dllName) != 0) continue;

        IMAGE_THUNK_DATA *origThunk = (IMAGE_THUNK_DATA *)((BYTE *)module + imports->OriginalFirstThunk);
        IMAGE_THUNK_DATA *thunk = (IMAGE_THUNK_DATA *)((BYTE *)module + imports->FirstThunk);

        for (; origThunk->u1.AddressOfData; origThunk++, thunk++) {
            if (origThunk->u1.Ordinal & IMAGE_ORDINAL_FLAG) continue;
            IMAGE_IMPORT_BY_NAME *imp = (IMAGE_IMPORT_BY_NAME *)
                ((BYTE *)module + origThunk->u1.AddressOfData);
            if (strcmp((const char *)imp->Name, funcName) == 0) {
                FARPROC orig = (FARPROC)thunk->u1.Function;
                DWORD oldProt;
                VirtualProtect(&thunk->u1.Function, sizeof(FARPROC),
                               PAGE_EXECUTE_READWRITE, &oldProt);
                thunk->u1.Function = (DWORD_PTR)hookFunc;
                VirtualProtect(&thunk->u1.Function, sizeof(FARPROC),
                               oldProt, &oldProt);
                hookLog("IAT hook: %s!%s replaced (orig=%p, hook=%p)",
                        dllName, funcName, (void*)orig, (void*)hookFunc);
                return orig;
            }
        }
    }
    hookLog("IAT hook: %s!%s NOT FOUND in module %p", dllName, funcName, (void*)module);
    return NULL;
}

/* --- Injection state machine ---
 * Shared between GetDeviceState (primary, called every frame) and
 * GetDeviceData (secondary, called infrequently). */
typedef enum {
    INJ_IDLE = 0,
    INJ_RESET,      /* Send large negative deltas to clamp cursor to (0,0) */
    INJ_MOVE,       /* Send exact delta to target position */
    INJ_SETTLE,     /* Wait frames for game to process hover */
    INJ_BTN_DOWN,   /* Button 0 down event */
    INJ_BTN_HOLD,   /* Hold button for a few frames */
    INJ_BTN_UP,     /* Button 0 up event */
    INJ_COMPLETE,   /* Injection done, ready for next command */
    INJ_BTN_ONLY,   /* Button-only: no position change, just btn down/up */
    INJ_ALLCLICK,    /* All-in-one: reset+move+btn_down+btn_up in single GDD call */
    INJ_DIRECTCLICK, /* Direct: move+btn_down+btn_up, NO reset — use when cursor starts at (0,0) */
    INJ_CLICK2_DOWN, /* click2: reset+move+btn_down in call 1 */
    INJ_CLICK2_UP,   /* click2: btn_up in call 2 */
    INJ_MOVECLICK_SETTLE, /* moveclick: settle after move, then button inject */
    INJ_MOVECLICK_BTN     /* moveclick: inject btn_down+btn_up via DInput buffer */
} InjectState;

static volatile InjectState g_injState = INJ_IDLE;
static volatile int g_injTargetX = 0;   /* DInput delta (raw, pre-sensitivity) */
static volatile int g_injTargetY = 0;
static volatile int g_injScreenX = 0;   /* Actual screen position (post-sensitivity) */
static volatile int g_injScreenY = 0;   /* Used by GetCursorPos override */
static volatile int g_injFrame = 0;
static volatile int g_injClickRequested = 1;  /* 1=click after move, 0=move only */

/* Force-override flag: makes GetCursorPos return (g_forceX, g_forceY) and
 * GetAsyncKeyState(VK_LBUTTON) return pressed, regardless of injection state.
 * Used for title screen clicks where we don't know which API the game checks.
 * Counts down per GetAsyncKeyState/GetCursorPos call; 0 = inactive. */
static volatile int g_forceClickFrames = 0;
static volatile int g_forceX = 0;
static volatile int g_forceY = 0;

/* --- Hooked GetAsyncKeyState ---
 * Returns VK_LBUTTON as pressed during injection BTN_DOWN/BTN_HOLD phases. */
static volatile LONG g_gasCallCount = 0;

/* VK code diagnostics: track which VK codes the game polls */
#define GAS_VK_SLOTS 16
static volatile int g_gasVkCodes[GAS_VK_SLOTS];
static volatile LONG g_gasVkCounts[GAS_VK_SLOTS];
static volatile LONG g_gasVkSlotCount = 0;

static void gasTrackVk(int vKey) {
    LONG slots = g_gasVkSlotCount;
    for (LONG i = 0; i < slots && i < GAS_VK_SLOTS; i++) {
        if (g_gasVkCodes[i] == vKey) {
            InterlockedIncrement(&g_gasVkCounts[i]);
            return;
        }
    }
    if (slots < GAS_VK_SLOTS) {
        LONG idx = InterlockedIncrement(&g_gasVkSlotCount) - 1;
        if (idx < GAS_VK_SLOTS) {
            g_gasVkCodes[idx] = vKey;
            g_gasVkCounts[idx] = 1;
        }
    }
}

static SHORT WINAPI hookedGetAsyncKeyState(int vKey) {
    LONG c = InterlockedIncrement(&g_gasCallCount);
    gasTrackVk(vKey);

    /* Log first few unique VK codes seen */
    if (c <= 10) {
        hookLog("GetAsyncKeyState(vKey=0x%02X/%d) call#%ld", vKey, vKey, c);
    }

    if (vKey == VK_LBUTTON) {
        /* Force-click override (highest priority) */
        if (g_forceClickFrames > 0) {
            hookLog("GetAsyncKeyState(VK_LBUTTON) -> 0x8001 (FORCED, frames=%d, call#%ld)",
                    g_forceClickFrames, c);
            InterlockedDecrement((volatile LONG *)&g_forceClickFrames);
            return (SHORT)0x8001;
        }
        if (g_injState == INJ_BTN_DOWN || g_injState == INJ_BTN_HOLD) {
            hookLog("GetAsyncKeyState(VK_LBUTTON) -> 0x8001 (INJECTED, state=%d, call#%ld)",
                    (int)g_injState, c);
            /* bit 15 = currently pressed, bit 0 = pressed since last call */
            return (SHORT)0x8001;
        }
        /* Log VK_LBUTTON polls periodically to confirm game IS calling this */
        if (c <= 5 || (c % 5000 == 0)) {
            SHORT real = g_origGetAsyncKeyState(vKey);
            hookLog("GetAsyncKeyState(VK_LBUTTON) -> 0x%04X (real, call#%ld)", (unsigned short)real, c);
            return real;
        }
    }
    return g_origGetAsyncKeyState(vKey);
}

/* --- Hooked GetKeyState ---
 * Returns VK_LBUTTON as pressed during injection BTN_DOWN/BTN_HOLD phases. */
static SHORT WINAPI hookedGetKeyState(int nVirtKey) {
    if (nVirtKey == VK_LBUTTON) {
        if (g_forceClickFrames > 0) {
            return (SHORT)0x8080;
        }
        if (g_injState == INJ_BTN_DOWN || g_injState == INJ_BTN_HOLD) {
            return (SHORT)0x8080; /* high bit = toggled, bit 15 = pressed */
        }
    }
    return g_origGetKeyState(nVirtKey);
}

/* --- Hooked GetCursorPos ---
 * During injection settle/click phases, return the exact target position.
 * This ensures hit-testing works even if cursor position is off. */
static volatile LONG g_gcpCallCount = 0;

static BOOL WINAPI hookedGetCursorPos(LPPOINT lpPoint) {
    BOOL result = g_origGetCursorPos(lpPoint);
    LONG c = InterlockedIncrement(&g_gcpCallCount);
    /* Force-click override (highest priority) */
    if (g_forceClickFrames > 0) {
        LONG origX = lpPoint ? lpPoint->x : -1;
        LONG origY = lpPoint ? lpPoint->y : -1;
        if (lpPoint) {
            lpPoint->x = g_forceX;
            lpPoint->y = g_forceY;
        }
        hookLog("GetCursorPos -> (%d,%d) FORCED (was %ld,%ld, frames=%d, call#%ld)",
                g_forceX, g_forceY, origX, origY, g_forceClickFrames, c);
        return result;
    }
    if (g_injState >= INJ_SETTLE && g_injState <= INJ_BTN_UP) {
        LONG origX = lpPoint ? lpPoint->x : -1;
        LONG origY = lpPoint ? lpPoint->y : -1;
        if (lpPoint) {
            lpPoint->x = g_injScreenX;
            lpPoint->y = g_injScreenY;
        }
        hookLog("GetCursorPos -> (%d,%d) OVERRIDDEN (was %ld,%ld, state=%d, call#%ld)",
                g_injScreenX, g_injScreenY, origX, origY, (int)g_injState, c);
    } else if (c <= 3 || (c % 5000 == 0)) {
        hookLog("GetCursorPos -> (%ld,%ld) (real, state=%d, call#%ld)",
                lpPoint ? lpPoint->x : -1, lpPoint ? lpPoint->y : -1,
                (int)g_injState, c);
    }
    return result;
}

/* --- Hooked PeekMessageA ---
 * Detects if the game reads mouse button messages via PeekMessage
 * (which removes them from the queue before WndProc ever sees them). */
typedef BOOL (WINAPI *PeekMessageA_t)(LPMSG, HWND, UINT, UINT, UINT);
static PeekMessageA_t g_origPeekMessageA = NULL;
static volatile LONG g_peekMsgCount = 0;
static volatile LONG g_peekMouseBtnCount = 0;

static BOOL WINAPI hookedPeekMessageA(LPMSG lpMsg, HWND hWnd,
                                       UINT wMsgFilterMin, UINT wMsgFilterMax,
                                       UINT wRemoveMsg) {
    BOOL result = g_origPeekMessageA(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg);
    LONG c = InterlockedIncrement(&g_peekMsgCount);

    if (result && lpMsg) {
        UINT msg = lpMsg->message;
        if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP ||
            msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP) {
            InterlockedIncrement(&g_peekMouseBtnCount);
            int x = (short)LOWORD(lpMsg->lParam);
            int y = (short)HIWORD(lpMsg->lParam);
            hookLog("PeekMessageA: msg=0x%04X (%s) x=%d y=%d remove=%s [call#%ld btn#%ld]",
                    msg,
                    msg == WM_LBUTTONDOWN ? "LBUTTONDOWN" :
                    msg == WM_LBUTTONUP ? "LBUTTONUP" :
                    msg == WM_RBUTTONDOWN ? "RBUTTONDOWN" : "RBUTTONUP",
                    x, y,
                    (wRemoveMsg & PM_REMOVE) ? "YES" : "NO",
                    c, (long)g_peekMouseBtnCount);
        }
    }
    return result;
}

/* Install Win32 API IAT hooks on the game EXE module */
static volatile LONG g_win32HooksInstalled = 0;

static void installWin32Hooks(void) {
    if (InterlockedCompareExchange(&g_win32HooksInstalled, 1, 0) != 0) return;

    HMODULE gameModule = GetModuleHandleA(NULL); /* main EXE */
    if (!gameModule) {
        hookLog("WARNING: GetModuleHandle(NULL) returned NULL");
        InterlockedExchange(&g_win32HooksInstalled, 0);
        return;
    }

    hookLog("Installing Win32 API hooks on game module %p", (void*)gameModule);

    g_origGetAsyncKeyState = (GetAsyncKeyState_t)hookIAT(
        gameModule, "user32.dll", "GetAsyncKeyState",
        (FARPROC)hookedGetAsyncKeyState);

    g_origGetKeyState = (GetKeyState_t)hookIAT(
        gameModule, "user32.dll", "GetKeyState",
        (FARPROC)hookedGetKeyState);

    g_origGetCursorPos = (GetCursorPos_t)hookIAT(
        gameModule, "user32.dll", "GetCursorPos",
        (FARPROC)hookedGetCursorPos);

    /* Fallback: if IAT hook didn't find the import (game uses GetProcAddress
     * or imports from a different DLL name), use INLINE (trampoline) hooks
     * on the actual user32.dll functions. This catches ALL callers. */
    HMODULE user32 = GetModuleHandleA("user32.dll");

    if (!g_origGetAsyncKeyState && user32) {
        FARPROC target = GetProcAddress(user32, "GetAsyncKeyState");
        if (target) {
            FARPROC tramp = installInlineHook(target,
                (FARPROC)hookedGetAsyncKeyState, g_gasTrampoline, sizeof(g_gasTrampoline));
            if (tramp) {
                g_origGetAsyncKeyState = (GetAsyncKeyState_t)tramp;
                hookLog("GetAsyncKeyState INLINE hooked at %p, trampoline=%p", (void*)target, (void*)tramp);
            } else {
                g_origGetAsyncKeyState = (GetAsyncKeyState_t)target;
                hookLog("GetAsyncKeyState inline hook FAILED, using raw ptr: %p", (void*)target);
            }
        }
    }
    if (!g_origGetKeyState && user32) {
        FARPROC target = GetProcAddress(user32, "GetKeyState");
        if (target) {
            FARPROC tramp = installInlineHook(target,
                (FARPROC)hookedGetKeyState, g_gksTrampoline, sizeof(g_gksTrampoline));
            if (tramp) {
                g_origGetKeyState = (GetKeyState_t)tramp;
                hookLog("GetKeyState INLINE hooked at %p, trampoline=%p", (void*)target, (void*)tramp);
            } else {
                g_origGetKeyState = (GetKeyState_t)target;
                hookLog("GetKeyState inline hook FAILED, using raw ptr: %p", (void*)target);
            }
        }
    }
    if (!g_origGetCursorPos && user32) {
        FARPROC target = GetProcAddress(user32, "GetCursorPos");
        if (target) {
            FARPROC tramp = installInlineHook(target,
                (FARPROC)hookedGetCursorPos, g_gcpTrampoline, sizeof(g_gcpTrampoline));
            if (tramp) {
                g_origGetCursorPos = (GetCursorPos_t)tramp;
                hookLog("GetCursorPos INLINE hooked at %p, trampoline=%p", (void*)target, (void*)tramp);
            } else {
                g_origGetCursorPos = (GetCursorPos_t)target;
                hookLog("GetCursorPos inline hook FAILED, using raw ptr: %p", (void*)target);
            }
        }
    }

    /* Hook PeekMessageA to detect if game reads WM_LBUTTONDOWN via PeekMessage
     * rather than WndProc dispatch. Many D3D games from this era use PeekMessage
     * with PM_REMOVE to process input directly in the game loop. */
    g_origPeekMessageA = (PeekMessageA_t)hookIAT(
        gameModule, "user32.dll", "PeekMessageA",
        (FARPROC)hookedPeekMessageA);

    hookLog("Win32 API hooks installed (GetAsyncKeyState=%s, GetKeyState=%s, GetCursorPos=%s, PeekMessageA=%s)",
            g_origGetAsyncKeyState ? "YES(hooked)" : "NO",
            g_origGetKeyState ? "YES(hooked)" : "NO",
            g_origGetCursorPos ? "YES" : "NO",
            g_origPeekMessageA ? "YES" : "NO");
}

/* --- Shared memory setup --- */

static void setupSharedMemory(void) {
    g_shmHandle = CreateFileMappingA(
        INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE,
        0, sizeof(InputSharedState), SHM_NAME
    );
    if (!g_shmHandle) {
        hookLog("ERROR: CreateFileMapping failed: %lu", GetLastError());
        return;
    }

    g_shm = (InputSharedState *)MapViewOfFile(
        g_shmHandle, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(InputSharedState)
    );
    if (!g_shm) {
        hookLog("ERROR: MapViewOfFile failed: %lu", GetLastError());
        CloseHandle(g_shmHandle);
        g_shmHandle = NULL;
        return;
    }

    /* Initialize state */
    ZeroMemory((void *)g_shm, sizeof(InputSharedState));
    InterlockedExchange(&g_shm->ready, 1);
    hookLog("Shared memory '%s' ready (%d bytes)", SHM_NAME, (int)sizeof(InputSharedState));
}

/* --- Hooked GetDeviceState for MOUSE --- */

static volatile LONG g_getDeviceStateCallCount = 0;
static volatile LONG g_lastLoggedCallCount = 0;

static HRESULT WINAPI hookedMouseGetDeviceState(
    LPDIRECTINPUTDEVICEA self, DWORD cbData, LPVOID lpvData
) {
    HRESULT hr = g_origMouseGetDeviceState(self, cbData, lpvData);

    LONG count = InterlockedIncrement(&g_getDeviceStateCallCount);

    /* Log mouse state with actual values — helps diagnose whether
     * QMP events are reaching the game through GetDeviceState. */
    if (hr == DI_OK && cbData >= sizeof(DIMOUSESTATE) && lpvData) {
        DIMOUSESTATE *ms = (DIMOUSESTATE *)lpvData;
        int hasDelta = (ms->lX != 0 || ms->lY != 0);
        int hasButton = (ms->rgbButtons[0] & 0x80) || (ms->rgbButtons[1] & 0x80);

        if (count == 1 || (count % 2000 == 0) || hasDelta || hasButton) {
            hookLog("Mouse GetDeviceState (count=%ld): dX=%ld dY=%ld btn0=%d btn1=%d hr=0x%08X",
                    count, ms->lX, ms->lY, ms->rgbButtons[0], ms->rgbButtons[1], (unsigned)hr);
        }
    } else if (count == 1 || (count % 2000 == 0)) {
        hookLog("Mouse GetDeviceState (count=%ld, cbData=%lu, hr=0x%08X)",
                count, (unsigned long)cbData, (unsigned)hr);
    }

    /* --- Direct injection via GetDeviceState ---
     * GetDeviceState is called every game frame (~30fps), unlike GetDeviceData
     * which is called only ~1/6s (event-driven). Inject relative deltas and
     * button state directly into the DIMOUSESTATE struct. */
    if (g_injState != INJ_IDLE && g_injState != INJ_COMPLETE) {
        if (cbData >= sizeof(DIMOUSESTATE) && lpvData) {
            DIMOUSESTATE *ms = (DIMOUSESTATE *)lpvData;

            switch (g_injState) {
            case INJ_RESET:
                /* Large negative deltas to slam game cursor to (0,0) */
                ms->lX = -800;
                ms->lY = -600;
                ms->rgbButtons[0] = 0;
                g_injFrame++;
                if (g_injFrame >= 3) {
                    g_injState = INJ_MOVE;
                    g_injFrame = 0;
                    hookLog("INJ/GDS: reset done (3 frames), moving to (%d,%d)",
                            g_injTargetX, g_injTargetY);
                }
                break;

            case INJ_MOVE:
                /* Exact delta from (0,0) to target */
                ms->lX = g_injTargetX;
                ms->lY = g_injTargetY;
                ms->rgbButtons[0] = 0;
                g_injState = INJ_SETTLE;
                g_injFrame = 0;
                hookLog("INJ/GDS: move injected (dx=%d, dy=%d)", g_injTargetX, g_injTargetY);
                break;

            case INJ_SETTLE:
                /* No movement — let game detect hover */
                ms->lX = 0;
                ms->lY = 0;
                ms->rgbButtons[0] = 0;
                g_injFrame++;
                if (g_injFrame >= 8) {
                    if (g_injClickRequested) {
                        g_injState = INJ_BTN_DOWN;
                    } else {
                        g_injState = INJ_COMPLETE;
                    }
                    g_injFrame = 0;
                    hookLog("INJ/GDS: settle done (8 frames)");
                }
                break;

            case INJ_BTN_DOWN:
                ms->lX = 0;
                ms->lY = 0;
                ms->rgbButtons[0] = 0x80;
                g_injState = INJ_BTN_HOLD;
                g_injFrame = 0;
                hookLog("INJ/GDS: button DOWN (DInput rgbButtons[0]=0x80)");

                /* ALSO post WM_LBUTTONDOWN from the main thread.
                 * We're inside GetDeviceState which runs on the game's main thread.
                 * This covers games that use the message pump for click detection. */
                if (g_gameHwnd) {
                    LPARAM lp = MAKELPARAM(g_injTargetX, g_injTargetY);
                    PostMessageA(g_gameHwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp);
                    hookLog("INJ/GDS: also PostMessage WM_LBUTTONDOWN at (%d,%d)",
                            g_injTargetX, g_injTargetY);
                }
                break;

            case INJ_BTN_HOLD:
                ms->lX = 0;
                ms->lY = 0;
                ms->rgbButtons[0] = 0x80;
                g_injFrame++;
                if (g_injFrame >= 4) {
                    g_injState = INJ_BTN_UP;
                    g_injFrame = 0;
                }
                break;

            case INJ_BTN_UP:
                ms->lX = 0;
                ms->lY = 0;
                ms->rgbButtons[0] = 0;
                g_injState = INJ_COMPLETE;
                hookLog("INJ/GDS: button UP — click COMPLETE");

                /* Post WM_LBUTTONUP to match the WM_LBUTTONDOWN sent in BTN_DOWN */
                if (g_gameHwnd) {
                    LPARAM lp = MAKELPARAM(g_injTargetX, g_injTargetY);
                    PostMessageA(g_gameHwnd, WM_LBUTTONUP, 0, lp);
                }
                break;

            default:
                break;
            }

            hr = DI_OK;
        }
    }

    return hr;
}

/* --- Hooked SetCooperativeLevel for KEYBOARD --- */

static HRESULT WINAPI hookedKbdSetCooperativeLevel(
    LPDIRECTINPUTDEVICEA self, HWND hwnd, DWORD dwFlags
) {
    DWORD origFlags = dwFlags;
    /* Force NONEXCLUSIVE + BACKGROUND for keyboard too.
     * FOREGROUND mode drops keyboard events when game window isn't foreground.
     * After launching from CMD, the game window may not have foreground status. */
    dwFlags = DISCL_NONEXCLUSIVE | DISCL_BACKGROUND;
    hookLog("KBD SetCooperativeLevel: hwnd=%p, origFlags=0x%lX -> newFlags=0x%lX (forced NONEXCL|BG)",
            (void*)hwnd, (unsigned long)origFlags, (unsigned long)dwFlags);
    return g_origKbdSetCooperativeLevel(self, hwnd, dwFlags);
}

/* --- Hooked GetDeviceState for KEYBOARD --- */

static volatile LONG g_kbdGetDeviceStateCallCount = 0;

static HRESULT WINAPI hookedKeyboardGetDeviceState(
    LPDIRECTINPUTDEVICEA self, DWORD cbData, LPVOID lpvData
) {
    HRESULT hr = g_origKeyboardGetDeviceState(self, cbData, lpvData);

    /* Log keyboard state periodically and when keys are pressed */
    LONG kcount = InterlockedIncrement(&g_kbdGetDeviceStateCallCount);
    if (hr == DI_OK && cbData >= 256 && lpvData) {
        BYTE *ks = (BYTE *)lpvData;
        /* Check if any key is currently pressed */
        int anyPressed = 0;
        for (int i = 0; i < 256; i++) {
            if (ks[i] & 0x80) { anyPressed = 1; break; }
        }
        if (anyPressed || kcount == 1 || (kcount % 2000 == 0)) {
            hookLog("KBD GetDeviceState (count=%ld, hr=0x%08X) keys:", kcount, (unsigned)hr);
            for (int i = 0; i < 256; i++) {
                if (ks[i] & 0x80) hookLog("  DIK_%d = 0x%02X", i, ks[i]);
            }
        }
    }

    /* --- F12 trigger key: click at current cursor position ---
     *
     * When F12 (DIK_F12 = 0x58) is detected pressed in the keyboard state,
     * trigger a mouse click injection at the current cursor position.
     * This avoids all focus issues because:
     * - QMP send-key delivers keyboard events through DInput
     * - The game is actively calling GetDeviceState (it has focus)
     * - The mouse injection state machine runs in the same GetDeviceState calls
     *
     * Usage: position cursor via QMP tablet, then send F12 via QMP send-key.
     */
    if (hr == DI_OK && cbData >= 256 && lpvData) {
        BYTE *ks = (BYTE *)lpvData;
        static int f12WasDown = 0;

        if ((ks[0x58] & 0x80) && !f12WasDown) {
            /* F12 just pressed — trigger click at current cursor position */
            f12WasDown = 1;
            POINT pt;
            if (g_origGetCursorPos) g_origGetCursorPos(&pt);
            else GetCursorPos(&pt);

            hookLog("F12 TRIGGER: clicking at cursor (%ld,%ld)", pt.x, pt.y);

            /* Set up the injection state machine.
             * Skip the RESET/MOVE phases — cursor is already positioned via QMP tablet.
             * Go straight to SETTLE → BTN_DOWN → BTN_HOLD → BTN_UP. */
            g_injTargetX = (int)pt.x;
            g_injTargetY = (int)pt.y;
            g_injClickRequested = 1;
            g_injFrame = 0;
            g_injState = INJ_SETTLE;

            /* Consume the F12 key so the game doesn't see it */
            ks[0x58] = 0;
        } else if (!(ks[0x58] & 0x80)) {
            f12WasDown = 0;
        }

        /* F11 (DIK_F11 = 0x57): same but with direct SendMessage approach
         * from within the keyboard GetDeviceState context (which runs on
         * the game's main thread) */
        static int f11WasDown = 0;
        if ((ks[0x57] & 0x80) && !f11WasDown) {
            f11WasDown = 1;
            POINT pt;
            if (g_origGetCursorPos) g_origGetCursorPos(&pt);
            else GetCursorPos(&pt);

            hookLog("F11 TRIGGER: direct SendMessage click at (%ld,%ld)", pt.x, pt.y);

            /* We're on the game's main thread right now.
             * Set cursor override and send click message. */
            g_injTargetX = (int)pt.x;
            g_injTargetY = (int)pt.y;
            g_injState = INJ_BTN_DOWN; /* activate GetCursorPos hook */

            LPARAM lp = MAKELPARAM((int)pt.x, (int)pt.y);
            if (g_gameHwnd) {
                PostMessageA(g_gameHwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp);
                Sleep(100);
                PostMessageA(g_gameHwnd, WM_LBUTTONUP, 0, lp);
            }
            Sleep(100);
            g_injState = INJ_IDLE;

            ks[0x57] = 0;
        } else if (!(ks[0x57] & 0x80)) {
            f11WasDown = 0;
        }
    }

    if (!g_shm || g_shm->cmdType != CMD_KEYPRESS || g_shm->done)
        return hr;

    if (cbData < 256)
        return hr;

    BYTE *keyState = (BYTE *)lpvData;
    LONG phase = InterlockedCompareExchange(&g_shm->phase, 0, 0);
    int dikCode = g_shm->keyCode;

    if (dikCode < 0 || dikCode >= 256)
        return hr;

    if (phase == PHASE_IDLE) {
        InterlockedExchange(&g_shm->phase, PHASE_KEY_DOWN);
        phase = PHASE_KEY_DOWN;
        g_shm->frameCount = 0;
    }

    switch (phase) {
    case PHASE_KEY_DOWN:
        keyState[dikCode] = 0x80;
        InterlockedExchange(&g_shm->phase, PHASE_KEY_HOLD1);
        g_shm->frameCount = 0;
        break;

    case PHASE_KEY_HOLD1:
        keyState[dikCode] = 0x80;
        InterlockedExchange(&g_shm->phase, PHASE_KEY_HOLD2);
        break;

    case PHASE_KEY_HOLD2:
        keyState[dikCode] = 0x80;
        InterlockedExchange(&g_shm->phase, PHASE_KEY_UP);
        break;

    case PHASE_KEY_UP:
        keyState[dikCode] = 0x00;
        hookLog("Key press complete: DIK %d", dikCode);
        InterlockedExchange(&g_shm->phase, PHASE_IDLE);
        InterlockedExchange(&g_shm->cmdType, CMD_NONE);
        InterlockedExchange(&g_shm->done, 1);
        g_shm->frameCount = 0;
        break;
    }

    return DI_OK;
}

/* --- Direct buffer injection into GetDeviceData ---
 *
 * Previous approach: mouse_event() → Windows message queue → DInput → GetDeviceData.
 * Problem: events reached GetDeviceData but game ignored them (possibly wrong format,
 * cooperative level issues, or menu uses Win32 API not DInput).
 *
 * New approach: directly write synthetic DIDEVICEOBJECTDATA events into the
 * GetDeviceData return buffer. This bypasses ALL Windows input routing,
 * cooperative level, focus, and message queue issues. We control exactly
 * what the game's mouse polling loop receives.
 */

static volatile LONG g_getDeviceDataCallCount = 0;
static DWORD g_injectSequence = 1000000;

/* Track accumulated DInput cursor position (sum of all deltas seen by game) */
static volatile LONG g_accumX = 0;
static volatile LONG g_accumY = 0;
static volatile LONG g_accumBtn = 0;  /* last button state seen */

/* Last GetDeviceData HRESULT and real event count — for diagnostics */
static volatile HRESULT g_lastGddHr = 0;
static volatile DWORD g_lastGddRealEvents = 0;
static volatile LONG g_reacqTotal = 0;
static volatile DWORD g_lastGddRetAddr = 0;  /* return address of caller */
static volatile DWORD g_callerEBP = 0;       /* caller's EBP = CInputDevice this */

/* Game cursor position (set by GetDeviceData hook on game thread via CInputLayer::GetMousePos) */
static volatile LONG g_gameMouseX = 0;
static volatile LONG g_gameMouseY = 0;

/* Direct FIFO event injection — bypasses DInput entirely, writes straight to CInputDevice's
 * event queue (at +0x2C, count at +0x142C). The live binary's WndProc path emits:
 *   type=3 via 0x4D3C10 for mouse move
 *   type=4 via 0x4D3D70 for button transitions
 *   type=5 via 0x4D3ED0 for WM_MOUSEWHEEL-style input
 * rawclick remains a diagnostics path for comparing event layouts; it is not the proven
 * title-menu click path. */
#define RAWCLICK_IDLE     0
#define RAWCLICK_PENDING  1   /* write type=3 move + type=5 btn_down */
#define RAWCLICK_UP       2   /* write type=5 btn_up on next GDD */
#define RAWCLICK_DONE     3
static volatile int    g_rawclickState = RAWCLICK_IDLE;
static volatile float  g_rawclickX = 0.0f;
static volatile float  g_rawclickY = 0.0f;
static volatile DWORD  g_rawclickType = 5;  /* diagnostic event type override (typically 4 or 5) */
static volatile DWORD  g_rawclickButtonIndex = 0;

#define GAMECLICK_IDLE     0
#define GAMECLICK_PENDING  1
#define GAMECLICK_HOLD     2
#define GAMECLICK_UP       3
#define GAMECLICK_DONE     4
static volatile int    g_gameclickState = GAMECLICK_IDLE;
static volatile float  g_gameclickX = 0.0f;
static volatile float  g_gameclickY = 0.0f;
static volatile DWORD  g_gameclickButtonIndex = 1;
static volatile LONG   g_gameclickHoldFrames = 2;

#define MENUCLICK_IDLE         0
#define MENUCLICK_PENDING_DOWN 1
#define MENUCLICK_PENDING_UP   2
#define MENUCLICK_DONE         3

#define MENUDIRECT_NONE   0
#define MENUDIRECT_CASE2  2
#define MENUDIRECT_CASE3  3
#define MENUDIRECT_CASE4  4
#define MENUDIRECT_COMBO  9
#define MENUDIRECT_MAINMSG 10
#define MENUDIRECT_MAINCB 11
#define MENUDIRECT_MAINCOMBO 12
#define MENUDIRECT_MAINSCAN 13
#define MENUDIRECT_MAINFLOW 14

#define MENU_TARGET_NONE           0
#define MENU_TARGET_SINGLE_PLAYER  1

#define MENUWATCH_TARGET_NONE      0
#define MENUWATCH_TARGET_MANAGER   1
#define MENUWATCH_TARGET_PENDING   2

static volatile LONG g_menuClickState = MENUCLICK_IDLE;
static volatile LONG g_menuClickTarget = MENU_TARGET_NONE;
static volatile LONG g_menuClickStage = 0;
static volatile LONG g_menuDirectMode = MENUDIRECT_NONE;
static volatile LONG g_menuDirectTarget = MENU_TARGET_NONE;
static volatile LONG g_menuDirectPumpCount = 0;
static volatile LONG g_menuPumpPending = 0;
static volatile LONG g_menuPumpCount = 1;
static volatile LONG g_menuWrapPending = 0;
static volatile LONG g_menuWrapTarget = MENU_TARGET_NONE;
static volatile LONG g_menuWrapArg1 = 1;
static volatile LONG g_menuWrapArg2 = 0;
static volatile LONG g_menuWrapArg3 = 1;
static volatile LONG g_menuWrapArg5 = 0;
static volatile LONG g_menuWrapUsePayload = 0;
static volatile LONG g_menuWrapForceClear18 = 0;
static volatile LONG g_menuWrapForceClear2C = 0;
static volatile LONG g_menuWrapArg5FromItem24 = 0;
static volatile LONG g_menuWrapAutoFlush = 0;
static volatile LONG g_menuItemKeyPending = 0;
static volatile LONG g_menuItemKeyTarget = MENU_TARGET_NONE;
static volatile LONG g_menuItemKeyArg1 = 0;
static volatile LONG g_menuItemKeyArg2 = 0;
static volatile LONG g_menuItemKeyArg3 = 0;
static volatile LONG g_menuItemKeyAutoFlush = 0;
static volatile LONG g_menuItemFlushPending = 0;
static volatile LONG g_menuItemFlushTarget = MENU_TARGET_NONE;
static volatile LONG g_menuTraceRemaining = 0;
static volatile LONG g_menuClickUsedContainerPath = 0;
static volatile LONG g_menuWatchPendingCommand = 0;
static volatile LONG g_menuWatchPendingHits = 24;
static volatile LONG g_menuWatchRearmPending = 0;
static volatile LONG g_menuWatchHitsLogged = 0;
static volatile LONG g_menuWatchFaultsSeen = 0;
static volatile LONG g_menuWatchHitLimit = 0;
static volatile LONG g_menuWatchFaultBudget = 0;
static volatile LONG g_menuWatchActive = 0;
static volatile LONG g_menuWatchTarget = MENUWATCH_TARGET_NONE;
static volatile DWORD g_screenOpenPendingAddr = 0;
static volatile LONG g_screenOpenPendingMode = 0;
static volatile LONG g_screenOpenAutoPumpCount = 0;
static volatile LONG g_screenPendingApplyMode = 0;
static volatile LONG g_screenEntryPending = 0;
static volatile LONG g_pendingUiDispatchSeq = 0;
static volatile LONG g_screenOpenTraceStage = 0;
static char g_screenEntryName[64];
static PVOID g_menuWatchVehHandle = NULL;
static BYTE *g_menuWatchManager = NULL;
static BYTE *g_menuWatchPageBase = NULL;
static SIZE_T g_menuWatchPageSize = 0;
static BYTE *g_menuWatchFieldBase = NULL;
static SIZE_T g_menuWatchFieldSize = 0;
static DWORD g_menuWatchProtectNoGuard = 0;

typedef unsigned char (__attribute__((thiscall)) *MenuSelectItem_t)(void *self, void *item);
typedef unsigned char (__attribute__((thiscall)) *MenuDispatchItem_t)(void *self, int action, int pressed, void *context);
/* 0x55A460 is the item-level wrapper around 0x55A520.
 * The extracted title-screen binary does not treat this like a simple down/up API:
 * - arg1 gates the entire wrapper: 0 goes straight to the release/reset branch.
 * - arg2 is forwarded to 0x55A520 as the queued action subtype.
 * - the low byte of arg3 becomes the queued pressed/armed flag.
 * - arg5 is forwarded as the queue record's extra value.
 * - arg4 is not consumed by this wrapper in the extracted snapshot build.
 */
typedef unsigned char (__attribute__((thiscall)) *MenuWrapperItem_t)(
    void *self,
    int arg1,
    int arg2,
    int arg3,
    void *context,
    int arg5
);
typedef void (__attribute__((thiscall)) *MenuCase2Item_t)(void *self, void *payload, int activate);
typedef void (__attribute__((thiscall)) *MenuCase3Item_t)(void *self, void *payload);
typedef void (__attribute__((thiscall)) *MenuCase4Item_t)(void *self, int value);
typedef void (__attribute__((thiscall)) *MenuControllerDispatch_t)(void *self, int action, int flags);
typedef void (__attribute__((thiscall)) *MenuAppPump_t)(void *self);
typedef void (__attribute__((thiscall)) *TitleSelectChild_t)(void *self, int index);
typedef void (__attribute__((thiscall)) *MenuContainerEvent_t)(void *self, void *event);
typedef void *(__attribute__((thiscall)) *FindNamedObject_t)(void *self, const char *name);
typedef void (__attribute__((thiscall)) *MainMenuProcessMessage_t)(void *self, void *event);
typedef void (__attribute__((thiscall)) *MainMenuCallback_t)(void *self, void *arg);
typedef void (__attribute__((thiscall)) *MainMenuTick_t)(void *self);
typedef unsigned char (__attribute__((thiscall)) *MenuItemKey_t)(void *self, int arg1, int arg2, int arg3);
typedef void (__attribute__((thiscall)) *MenuItemFlush_t)(void *self);

#define TITLE_SCREEN_VTABLE 0x005D35C4
#define WM_APP_PENDING_UI   (WM_APP + 0x52)
#define TIMER_ID_NAV        0xD1CE

/* SetTimer-based navigation: fires TIMERPROC from game's DispatchMessage,
 * outside any DInput COM context. Avoids crashes from GDD-direct and
 * SendMessage dispatch which run inside COM's internal message pump. */
static volatile LONG g_timerNavArmed = 0;
static char g_timerNavName[64];

#define DINPUT7_OBJECTDATA_SIZE 16

/* Write a single DInput7 event into the buffer at the given pointer.
 * Layout: dwOfs(4) + dwData(4) + dwTimeStamp(4) + dwSequence(4) = 16 bytes */
static void writeInjEvent(BYTE *buf, DWORD dwOfs, DWORD dwData) {
    *(DWORD *)(buf + 0)  = dwOfs;
    *(DWORD *)(buf + 4)  = dwData;
    *(DWORD *)(buf + 8)  = GetTickCount();
    *(DWORD *)(buf + 12) = g_injectSequence++;
}

/* Read the game's current cursor from CInputDevice.
 * The live binary stores the cursor as floats at +0x14/+0x18 and commits them
 * after processing a GetDeviceData buffer. This lets us compute a relative move
 * without relying on Windows cursor state or the old sensitivity heuristic. */
static int tryReadCurrentCursor(float *outX, float *outY) {
    if (!g_callerEBP)
        return 0;

    float *pX = (float *)((BYTE *)g_callerEBP + 0x14);
    float *pY = (float *)((BYTE *)g_callerEBP + 0x18);
    if (IsBadReadPtr((void *)pX, sizeof(float)) || IsBadReadPtr((void *)pY, sizeof(float)))
        return 0;

    float x = *pX;
    float y = *pY;
    if (x < -4096.0f || x > 4096.0f || y < -4096.0f || y > 4096.0f)
        return 0;

    if (outX) *outX = x;
    if (outY) *outY = y;
    return 1;
}

/* Mirror the extracted title-screen binary's queue writers closely enough for
 * diagnostic injection:
 * - 0x4D3C10 writes type=3 move records.
 * - 0x4D3D70 writes type=4 button transition records.
 *
 * The queue record layout is:
 *   +0x00 type
 *   +0x08/+0x0C committed x/y
 *   +0x10/+0x14 dx/dy from CInputDevice+0x24/+0x28
 *   +0x18/+0x1C button-state dwords from CInputDevice+0x1431/+0x1435
 *   +0x20 button index (-1 for move records)
 *   +0x24 reserved (0)
 */
static void rawQueueWriteMoveEvent(BYTE *cinput, BYTE *slot, float targetX, float targetY) {
    float oldX = *(float *)(cinput + 0x14);
    float oldY = *(float *)(cinput + 0x18);
    float dx = targetX - oldX;
    float dy = targetY - oldY;
    int useAltCursor = *(BYTE *)(cinput + 0x01) != 0;
    float eventX = useAltCursor ? *(float *)(cinput + 0x1C) : targetX;
    float eventY = useAltCursor ? *(float *)(cinput + 0x20) : targetY;

    *(float *)(cinput + 0x24) = dx;
    *(float *)(cinput + 0x28) = dy;
    *(float *)(cinput + 0x14) = targetX;
    *(float *)(cinput + 0x18) = targetY;

    memset(slot, 0, 40);
    *(DWORD *)(slot + 0x00) = 3;
    *(float *)(slot + 0x08) = eventX;
    *(float *)(slot + 0x0C) = eventY;
    *(float *)(slot + 0x10) = *(float *)(cinput + 0x24);
    *(float *)(slot + 0x14) = *(float *)(cinput + 0x28);
    *(DWORD *)(slot + 0x18) = *(DWORD *)(cinput + 0x1431);
    *(DWORD *)(slot + 0x1C) = *(DWORD *)(cinput + 0x1435);
    *(DWORD *)(slot + 0x20) = 0xFFFFFFFF;
    *(DWORD *)(slot + 0x24) = 0;
}

static void rawQueueWriteButtonEvent(BYTE *cinput, BYTE *slot, DWORD type, float targetX, float targetY, DWORD buttonIndex, BYTE buttonValue) {
    float oldX = *(float *)(cinput + 0x14);
    float oldY = *(float *)(cinput + 0x18);
    float dx = targetX - oldX;
    float dy = targetY - oldY;
    int useAltCursor = *(BYTE *)(cinput + 0x01) != 0;
    float eventX;
    float eventY;

    *(float *)(cinput + 0x24) = dx;
    *(float *)(cinput + 0x28) = dy;
    *(float *)(cinput + 0x14) = targetX;
    *(float *)(cinput + 0x18) = targetY;
    *((BYTE *)(cinput + 0x1431) + buttonIndex) = buttonValue;

    eventX = useAltCursor ? *(float *)(cinput + 0x1C) : *(float *)(cinput + 0x14);
    eventY = useAltCursor ? *(float *)(cinput + 0x20) : *(float *)(cinput + 0x18);

    memset(slot, 0, 40);
    *(DWORD *)(slot + 0x00) = type;
    *(float *)(slot + 0x08) = eventX;
    *(float *)(slot + 0x0C) = eventY;
    *(float *)(slot + 0x10) = *(float *)(cinput + 0x24);
    *(float *)(slot + 0x14) = *(float *)(cinput + 0x28);
    *(DWORD *)(slot + 0x18) = *(DWORD *)(cinput + 0x1431);
    *(DWORD *)(slot + 0x1C) = *(DWORD *)(cinput + 0x1435);
    *(DWORD *)(slot + 0x20) = buttonIndex;
    *(DWORD *)(slot + 0x24) = 0;
}

typedef void (__attribute__((thiscall)) *GameQueueMoveFn)(void *self, float x, float y);
typedef void (__attribute__((thiscall)) *GameQueueButtonFn)(void *self, float x, float y, DWORD buttonIndex, DWORD buttonValue);

static void callGameQueueMove(void *cinput, float targetX, float targetY) {
    ((GameQueueMoveFn)0x004D3C10)(cinput, targetX, targetY);
}

static void callGameQueueButton(void *cinput, float targetX, float targetY, DWORD buttonIndex, DWORD buttonValue) {
    ((GameQueueButtonFn)0x004D3D70)(cinput, targetX, targetY, buttonIndex, buttonValue);
}

/* Arm the direct buffered-click path using a delta derived from the current
 * game cursor. If we cannot read the cursor yet, fall back to origin-based
 * semantics (the old dclick behavior). */
static void armDirectClickCommand(int targetX, int targetY, int assumeOrigin, const char *label) {
    float currentX = 0.0f, currentY = 0.0f;
    int haveCursor = !assumeOrigin && tryReadCurrentCursor(&currentX, &currentY);
    int baseX = haveCursor ? (int)(currentX >= 0.0f ? currentX + 0.5f : currentX - 0.5f) : 0;
    int baseY = haveCursor ? (int)(currentY >= 0.0f ? currentY + 0.5f : currentY - 0.5f) : 0;
    int deltaX = targetX - baseX;
    int deltaY = targetY - baseY;

    g_injScreenX = targetX;
    g_injScreenY = targetY;
    g_injTargetX = deltaX;
    g_injTargetY = deltaY;
    g_injClickRequested = 1;
    g_injFrame = 0;
    g_injState = INJ_DIRECTCLICK;
    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);

    if (haveCursor) {
        hookLog("TCP: %s armed at (%d,%d) current(%.1f,%.1f) delta(%d,%d)",
                label, targetX, targetY, currentX, currentY, deltaX, deltaY);
    } else {
        hookLog("TCP: %s armed at (%d,%d) from origin delta(%d,%d)",
                label, targetX, targetY, deltaX, deltaY);
    }
}

static const char *menuTargetName(LONG target) {
    switch (target) {
    case MENU_TARGET_SINGLE_PLAYER:
        return "singleplayer";
    default:
        return "unknown";
    }
}

static const char *menuDirectModeName(LONG mode) {
    switch (mode) {
    case MENUDIRECT_CASE2:
        return "case2";
    case MENUDIRECT_CASE3:
        return "case3";
    case MENUDIRECT_CASE4:
        return "case4";
    case MENUDIRECT_COMBO:
        return "combo";
    case MENUDIRECT_MAINMSG:
        return "mainmsg";
    case MENUDIRECT_MAINCB:
        return "maincb";
    case MENUDIRECT_MAINCOMBO:
        return "maincombo";
    case MENUDIRECT_MAINSCAN:
        return "mainscan";
    case MENUDIRECT_MAINFLOW:
        return "mainflow";
    default:
        return "unknown";
    }
}

static const char *mainMenuTokenName(LONG target) {
    switch (target) {
    case MENU_TARGET_SINGLE_PLAYER:
        return "Single";
    default:
        return NULL;
    }
}

static DWORD mainMenuCallbackAddress(LONG target) {
    switch (target) {
    case MENU_TARGET_SINGLE_PLAYER:
        return 0x004E3880;
    default:
        return 0;
    }
}

static const char *tryReadAsciiString(const char *value) {
    size_t i;

    if (!value || IsBadReadPtr((void *)value, 1))
        return NULL;

    for (i = 0; i < 64; i++) {
        unsigned char ch;

        if (IsBadReadPtr((void *)(value + i), 1))
            return NULL;
        ch = (unsigned char)value[i];
        if (ch == 0)
            return i > 0 ? value : NULL;
        if (ch < 0x20 || ch > 0x7e)
            return NULL;
    }

    return NULL;
}

static DWORD namedScreenAddress(const char *name) {
    if (!name)
        return 0;
    if (_stricmp(name, "campaign") == 0)
        return 0x005FDB70;
    if (_stricmp(name, "coop") == 0)
        return 0x005FDB7C;
    if (_stricmp(name, "loadsave") == 0 || _stricmp(name, "load") == 0)
        return 0x005FDB24;
    if (_stricmp(name, "options") == 0)
        return 0x00600CBC;
    if (_stricmp(name, "house") == 0)
        return 0x005FDD78;
    if (_stricmp(name, "briefing") == 0)
        return 0x005FDD34;
    if (_stricmp(name, "mainmenu") == 0)
        return 0x005FD570;
    if (_stricmp(name, "wollogin") == 0)
        return 0x00600500;
    if (_stricmp(name, "wolchatroom") == 0)
        return 0x006034C8;
    return 0;
}

static LONG clampMenuWatchHits(LONG count) {
    if (count < 1)
        return 1;
    if (count > 64)
        return 64;
    return count;
}

static LONG menuWatchFaultBudget(LONG hits) {
    LONG budget = hits * 32;

    if (budget < 128)
        budget = 128;
    if (budget > 2048)
        budget = 2048;
    return budget;
}

static const char *menuWatchTargetName(LONG target) {
    switch (target) {
    case MENUWATCH_TARGET_MANAGER:
        return "manager";
    case MENUWATCH_TARGET_PENDING:
        return "pending";
    default:
        return "none";
    }
}

static const char *menuWatchAccessName(ULONG_PTR accessType) {
    switch (accessType) {
    case 0:
        return "read";
    case 1:
        return "write";
    case 8:
        return "exec";
    default:
        return "other";
    }
}

static DWORD readFrameCaller(DWORD ebp) {
    if (!ebp || IsBadReadPtr((void *)(uintptr_t)(ebp + 4), sizeof(DWORD)))
        return 0;
    return *(DWORD *)(uintptr_t)(ebp + 4);
}

static int isLikelyGameCodeAddress(DWORD address) {
    return address >= 0x00400000 && address < 0x00700000;
}

static const char *tryReadNamedObjectToken(void *object) {
    BYTE *ptr = (BYTE *)object;
    const char *value;

    if (!ptr || IsBadReadPtr(ptr + 0x08, sizeof(void *)))
        return NULL;

    value = *(const char **)(ptr + 0x08);
    return tryReadAsciiString(value);
}

static int wideEqualsAscii(const WCHAR *value, const char *ascii) {
    if (!value || !ascii)
        return 0;

    for (; *ascii; ascii++, value++) {
        if (IsBadReadPtr((void *)value, sizeof(WCHAR)))
            return 0;
        if (*value != (WCHAR)(unsigned char)*ascii)
            return 0;
    }

    return !IsBadReadPtr((void *)value, sizeof(WCHAR)) && *value == 0;
}

static void *resolveActiveTitleScreen(void) {
    BYTE *app = (BYTE *)0x818718;
    void **screens = (void **)app;
    LONG screenCount;
    LONG screenIndex;

    if (IsBadReadPtr(app, 0x10))
        return NULL;

    screenCount = *(LONG *)(app + 0x08);
    screenIndex = *(LONG *)(app + 0x0C);
    if (screenCount <= 0 || screenCount > 16 || screenIndex < 0 || screenIndex >= screenCount)
        return NULL;

    if (IsBadReadPtr(&screens[screenIndex], sizeof(void *)))
        return NULL;

    return screens[screenIndex];
}

static void *resolveCurrentMenuContainer(void) {
    BYTE *screen = (BYTE *)resolveActiveTitleScreen();
    void **children;
    LONG childIndex;
    LONG childCount;

    if (!screen || IsBadReadPtr(screen, 0x1C))
        return NULL;

    children = *(void ***)(screen + 0x08);
    childCount = *(LONG *)(screen + 0x0C);
    childIndex = *(LONG *)(screen + 0x18);
    if (!children || childCount <= 0 || childCount > 64 || childIndex < 0 || childIndex >= childCount)
        return NULL;

    if (IsBadReadPtr(&children[childIndex], sizeof(void *)))
        return NULL;

    return children[childIndex];
}

static void *findMenuItemByTarget(void *container, LONG target, LONG *outIndex);

static const char *tryReadScreenEntryName(void **items, LONG itemCount, LONG index) {
    BYTE *entry;

    if (!items || itemCount <= 0 || index < 0 || index >= itemCount)
        return NULL;
    if (IsBadReadPtr(&items[index], sizeof(void *)))
        return NULL;

    entry = (BYTE *)items[index];
    if (!entry || IsBadReadPtr(entry, sizeof(void *)))
        return NULL;

    return tryReadAsciiString(*(const char **)entry);
}

static void logActiveScreenState(const char *label) {
    BYTE *app = (BYTE *)0x818718;
    LONG sel;
    LONG appCount;
    BYTE *screen;
    void **items = NULL;
    LONG itemCount = 0;
    LONG activeIndex = -1;
    LONG pendingIndex = -1;
    float anim = 0.0f;
    DWORD ptr24 = 0;
    DWORD ptr28 = 0;
    DWORD ptr2c = 0;
    DWORD ptr30 = 0;
    DWORD ptr34 = 0;
    const char *activeName = NULL;
    const char *pendingName = NULL;

    if (IsBadReadPtr(app, 0x20))
        return;

    sel = *(LONG *)(app + 0x0C);
    appCount = *(LONG *)(app + 0x08);
    if (sel < 0 || sel >= appCount) {
        hookLog("SCREENSTATE: %s invalid sel=%ld count=%ld",
                label ? label : "unknown", (long)sel, (long)appCount);
        return;
    }

    screen = *(BYTE **)(app + (sel * 4));
    if (!screen || IsBadReadPtr(screen, 0x38)) {
        hookLog("SCREENSTATE: %s unreadable screen sel=%ld ptr=%p",
                label ? label : "unknown", (long)sel, (void *)screen);
        return;
    }

    items = *(void ***)(screen + 0x08);
    itemCount = *(LONG *)(screen + 0x0C);
    activeIndex = *(LONG *)(screen + 0x18);
    pendingIndex = (!IsBadReadPtr(screen + 0x374, sizeof(LONG)))
        ? *(LONG *)(screen + 0x370)
        : -1;
    anim = (!IsBadReadPtr(screen + 0x370, sizeof(float)))
        ? *(float *)(screen + 0x36C)
        : 0.0f;
    ptr24 = (!IsBadReadPtr(screen + 0x28, sizeof(DWORD))) ? *(DWORD *)(screen + 0x24) : 0;
    ptr28 = (!IsBadReadPtr(screen + 0x2C, sizeof(DWORD))) ? *(DWORD *)(screen + 0x28) : 0;
    ptr2c = (!IsBadReadPtr(screen + 0x30, sizeof(DWORD))) ? *(DWORD *)(screen + 0x2C) : 0;
    ptr30 = (!IsBadReadPtr(screen + 0x34, sizeof(DWORD))) ? *(DWORD *)(screen + 0x30) : 0;
    ptr34 = (!IsBadReadPtr(screen + 0x38, sizeof(DWORD))) ? *(DWORD *)(screen + 0x34) : 0;
    activeName = tryReadScreenEntryName(items, itemCount, activeIndex);
    pendingName = tryReadScreenEntryName(items, itemCount, pendingIndex);

    hookLog("SCREENSTATE: %s screen=%p vt=0x%08X items=%p count=%ld active=%ld(%s) cur20=%ld flag1c=%u ptr24=%p ptr28=%p ptr2c=%p ptr30=%p ptr34=%p anim=%.3f pending=%ld(%s)",
            label ? label : "unknown",
            (void *)screen,
            (unsigned)*(DWORD *)screen,
            (void *)items,
            (long)itemCount,
            (long)activeIndex,
            activeName ? activeName : "<null>",
            (long)*(LONG *)(screen + 0x20),
            (unsigned)*(BYTE *)(screen + 0x1C),
            (void *)(uintptr_t)ptr24,
            (void *)(uintptr_t)ptr28,
            (void *)(uintptr_t)ptr2c,
            (void *)(uintptr_t)ptr30,
            (void *)(uintptr_t)ptr34,
            anim,
            (long)pendingIndex,
            pendingName ? pendingName : "<null>");
}

static void logActiveScreenEntries(const char *label) {
    BYTE *app = (BYTE *)0x818718;
    LONG sel;
    LONG appCount;
    BYTE *screen;
    void **items;
    LONG itemCount;
    LONG activeIndex;
    LONG i;

    if (IsBadReadPtr(app, 0x20))
        return;

    sel = *(LONG *)(app + 0x0C);
    appCount = *(LONG *)(app + 0x08);
    if (sel < 0 || sel >= appCount) {
        hookLog("SCREENENTRIES: %s invalid sel=%ld count=%ld",
                label ? label : "unknown", (long)sel, (long)appCount);
        return;
    }

    screen = *(BYTE **)(app + (sel * 4));
    if (!screen || IsBadReadPtr(screen, 0x20)) {
        hookLog("SCREENENTRIES: %s unreadable screen sel=%ld ptr=%p",
                label ? label : "unknown", (long)sel, (void *)screen);
        return;
    }

    items = *(void ***)(screen + 0x08);
    itemCount = *(LONG *)(screen + 0x0C);
    activeIndex = *(LONG *)(screen + 0x18);
    hookLog("SCREENENTRIES: %s sel=%ld/%ld screen=%p vt=0x%08X items=%p count=%ld active=%ld",
            label ? label : "unknown",
            (long)sel,
            (long)appCount,
            (void *)screen,
            (unsigned)*(DWORD *)screen,
            (void *)items,
            (long)itemCount,
            (long)activeIndex);

    if (!items || itemCount <= 0 || itemCount > 64)
        return;

    for (i = 0; i < itemCount && i < 24; i++) {
        BYTE *entry;
        const char *name = NULL;
        DWORD state0c = 0;
        DWORD state10 = 0;
        DWORD state14 = 0;
        DWORD state18 = 0;

        if (IsBadReadPtr(&items[i], sizeof(void *)))
            continue;
        entry = (BYTE *)items[i];
        if (!entry || IsBadReadPtr(entry, 0x1C)) {
            hookLog("SCREENENTRIES: [%ld] entry=%p unreadable", (long)i, (void *)entry);
            continue;
        }

        name = tryReadAsciiString(*(const char **)entry);
        state0c = *(DWORD *)(entry + 0x0C);
        state10 = *(DWORD *)(entry + 0x10);
        state14 = *(DWORD *)(entry + 0x14);
        state18 = *(DWORD *)(entry + 0x18);

        hookLog("SCREENENTRIES: [%ld]%s entry=%p name=%s x0c=0x%08X x10=0x%08X x14=0x%08X x18=0x%08X",
                (long)i,
                (i == activeIndex) ? "*" : "",
                (void *)entry,
                name ? name : "<null>",
                (unsigned)state0c,
                (unsigned)state10,
                (unsigned)state14,
                (unsigned)state18);
    }
}

static void *selectMenuContainerForTarget(LONG target, LONG *outChildIndex) {
    TitleSelectChild_t selectChild = (TitleSelectChild_t)0x4AE800;
    BYTE *screen = (BYTE *)resolveActiveTitleScreen();
    void **children;
    LONG childIndex;
    LONG childCount;
    LONG candidateIndex = -1;
    LONG i;

    if (outChildIndex)
        *outChildIndex = -1;

    if (!screen || IsBadReadPtr(screen, 0x24))
        return NULL;

    children = *(void ***)(screen + 0x08);
    childCount = *(LONG *)(screen + 0x0C);
    childIndex = *(LONG *)(screen + 0x18);
    if (!children || childCount <= 0 || childCount > 64)
        return NULL;

    if (childIndex < 0 && *(DWORD *)screen == TITLE_SCREEN_VTABLE) {
        LONG primeIndex = 0;
        hookLog("MENU: priming title screen via child=%ld for target=%s on screen=%p",
                (long)primeIndex, menuTargetName(target), (void *)screen);
        selectChild(screen, primeIndex);
        childIndex = *(LONG *)(screen + 0x18);
        hookLog("MENU: screen child index after prime=%ld target=%s",
                (long)childIndex, menuTargetName(target));
    }

    if (childIndex >= 0 && childIndex < childCount &&
        !IsBadReadPtr(&children[childIndex], sizeof(void *)) &&
        findMenuItemByTarget(children[childIndex], target, NULL)) {
        if (outChildIndex)
            *outChildIndex = childIndex;
        return children[childIndex];
    }

    for (i = 0; i < childCount; i++) {
        if (IsBadReadPtr(&children[i], sizeof(void *)))
            continue;
        if (findMenuItemByTarget(children[i], target, NULL)) {
            candidateIndex = i;
            break;
        }
    }

    if (candidateIndex < 0) {
        hookLog("MENU: no child contains target=%s screen=%p childIndex=%ld count=%ld",
                menuTargetName(target), (void *)screen, (long)childIndex, (long)childCount);
        return NULL;
    }

    if (*(DWORD *)screen != TITLE_SCREEN_VTABLE) {
        hookLog("MENU: screen=%p vtable=0x%08X unexpected for target=%s child=%ld",
                (void *)screen, (unsigned)*(DWORD *)screen, menuTargetName(target), (long)candidateIndex);
    } else if (childIndex != candidateIndex) {
        hookLog("MENU: selecting child=%ld for target=%s on screen=%p (current=%ld)",
                (long)candidateIndex, menuTargetName(target), (void *)screen, (long)childIndex);
        selectChild(screen, candidateIndex);
        childIndex = *(LONG *)(screen + 0x18);
        hookLog("MENU: screen child index after select=%ld target=%s",
                (long)childIndex, menuTargetName(target));
    }

    if (childIndex < 0 || childIndex >= childCount || IsBadReadPtr(&children[childIndex], sizeof(void *))) {
        if (outChildIndex)
            *outChildIndex = candidateIndex;
        return children[candidateIndex];
    }

    if (outChildIndex)
        *outChildIndex = childIndex;
    return children[childIndex];
}

static void *findMenuItemByTarget(void *container, LONG target, LONG *outIndex) {
    static const char *kSinglePlayer = "SINGLE PLAYER";
    BYTE *menu = (BYTE *)container;
    void **items;
    LONG itemCount;
    LONG i;

    if (!menu || IsBadReadPtr(menu, 0x40))
        return NULL;

    items = *(void ***)(menu + 0x38);
    itemCount = *(LONG *)(menu + 0x3C);
    if (!items || itemCount <= 0 || itemCount > 128)
        return NULL;

    for (i = 0; i < itemCount; i++) {
        BYTE *item;
        BYTE *labelBlock;
        const WCHAR *label;

        if (IsBadReadPtr(&items[i], sizeof(void *)))
            continue;
        item = (BYTE *)items[i];
        if (!item || IsBadReadPtr(item, 0x3C))
            continue;

        labelBlock = *(BYTE **)(item + 0x38);
        if (!labelBlock || IsBadReadPtr(labelBlock, 0x20))
            continue;

        label = (const WCHAR *)(labelBlock + 0x18);
        if (target == MENU_TARGET_SINGLE_PLAYER && wideEqualsAscii(label, kSinglePlayer)) {
            if (outIndex) *outIndex = i;
            return item;
        }
    }

    return NULL;
}

static void logMenuAppState(const char *label) {
    BYTE *app = (BYTE *)0x818718;
    const char *d8Name;
    const char *dcName;

    if (IsBadReadPtr(app, 0x95F0))
        return;

    d8Name = tryReadAsciiString(*(const char **)(app + 0x95D8));
    dcName = tryReadAsciiString(*(const char **)(app + 0x95DC));

    hookLog("MENUAPP: %s sel=%ld d4=0x%08X d8=%p(%s) dc=%p(%s) e0=%u e1=%u",
            label,
            (long)*(LONG *)(app + 0x0C),
            (unsigned)*(DWORD *)(app + 0x95D4),
            *(void **)(app + 0x95D8),
            d8Name ? d8Name : "<null>",
            *(void **)(app + 0x95DC),
            dcName ? dcName : "<null>",
            (unsigned)*(BYTE *)(app + 0x95E0),
            (unsigned)*(BYTE *)(app + 0x95E1));
}

static void logMainMenuState(const char *label) {
    FindNamedObject_t findNamedObject = (FindNamedObject_t)0x4D6900;
    BYTE *app = (BYTE *)0x818718;
    BYTE *mainMenu;
    BYTE *manager;
    BYTE *controller = NULL;

    if (IsBadReadPtr(app, 0x20))
        return;

    mainMenu = (BYTE *)findNamedObject(app, "MainMenu");
    manager = (BYTE *)findNamedObject(app, "MainMenuManager");
    if (manager && !IsBadReadPtr(manager + 0x04, sizeof(void *)))
        controller = *(BYTE **)(manager + 0x04);

    hookLog("MAINMENU: %s menu=%p vt=0x%08X tree=%p mgr=%p vt=0x%08X ctrl=%p ctrlvt=0x%08X gateCE9=%u list=%p count=%ld f4=%u f8=%ld fc=%u gmode=%ld gflag=%u",
            label,
            (void *)mainMenu,
            (mainMenu && !IsBadReadPtr(mainMenu, sizeof(DWORD))) ? (unsigned)*(DWORD *)mainMenu : 0,
            (mainMenu && !IsBadReadPtr(mainMenu + 0xF0, sizeof(void *))) ? *(void **)(mainMenu + 0xF0) : NULL,
            (void *)manager,
            (manager && !IsBadReadPtr(manager, sizeof(DWORD))) ? (unsigned)*(DWORD *)manager : 0,
            (void *)controller,
            (controller && !IsBadReadPtr(controller, sizeof(DWORD))) ? (unsigned)*(DWORD *)controller : 0,
            (controller && !IsBadReadPtr(controller + 0xCE9, sizeof(BYTE))) ? (unsigned)*(BYTE *)(controller + 0xCE9) : 0,
            (controller && !IsBadReadPtr(controller + 0x38, sizeof(void *))) ? *(void **)(controller + 0x38) : NULL,
            (controller && !IsBadReadPtr(controller + 0x3C, sizeof(LONG))) ? (long)*(LONG *)(controller + 0x3C) : -1,
            (manager && !IsBadReadPtr(manager + 0xF4, sizeof(BYTE))) ? (unsigned)*(BYTE *)(manager + 0xF4) : 0,
            (manager && !IsBadReadPtr(manager + 0xF8, sizeof(LONG))) ? (long)*(LONG *)(manager + 0xF8) : -1,
            (manager && !IsBadReadPtr(manager + 0xFC, sizeof(BYTE))) ? (unsigned)*(BYTE *)(manager + 0xFC) : 0,
            !IsBadReadPtr((void *)0xB74C5C, sizeof(LONG)) ? (long)*(LONG *)0xB74C5C : -1,
            !IsBadReadPtr((void *)0xB7DA25, sizeof(BYTE)) ? (unsigned)*(BYTE *)0xB7DA25 : 0);
}

static void logMenuQueueEntry(const char *label, LONG index) {
    BYTE *entry;

    if (index < 0 || index >= 0x1000) {
        hookLog("MENUQ: %s idx=%ld (out-of-range)", label, (long)index);
        return;
    }

    entry = (BYTE *)0x8824E8 + (index * 0x28);
    if (IsBadReadPtr(entry, 0x28)) {
        hookLog("MENUQ: %s idx=%ld unreadable entry=%p", label, (long)index, (void *)entry);
        return;
    }

    hookLog("MENUQ: %s idx=%ld flag=%u next=%ld slot0c=%p slot14=%p a1=%ld a2=%u owner=%p a3=%p",
            label,
            (long)index,
            (unsigned)*(BYTE *)(entry + 0x04),
            (long)*(LONG *)(entry + 0x08),
            *(void **)(entry + 0x0C),
            *(void **)(entry + 0x14),
            (long)*(LONG *)(entry + 0x18),
            (unsigned)*(BYTE *)(entry + 0x1C),
            *(void **)(entry + 0x20),
            *(void **)(entry + 0x24));
}

static void logMenuQueueState(const char *label) {
    LONG queueHead;
    LONG freeHead;

    if (IsBadReadPtr((void *)0x821CD8, sizeof(DWORD)) ||
        IsBadReadPtr((void *)0x821CE8, sizeof(DWORD)) ||
        IsBadReadPtr((void *)0x8AA4E8, sizeof(LONG)) ||
        IsBadReadPtr((void *)0x8AA4EC, sizeof(LONG))) {
        hookLog("MENUQ: %s queue globals unreadable", label);
        return;
    }

    queueHead = *(LONG *)0x8AA4EC;
    freeHead = *(LONG *)0x8AA4E8;
    hookLog("MENUQ: %s gateCE8=%p gateCD8=0x%08X queueHead=%ld freeHead=%ld",
            label,
            *(void **)0x821CE8,
            (unsigned)*(DWORD *)0x821CD8,
            (long)queueHead,
            (long)freeHead);
    logMenuQueueEntry("queueHead", queueHead);
    logMenuQueueEntry("freeHead", freeHead);
}

static void disarmMenuWatchpoint(const char *reason) {
    DWORD oldProt;
    LONG target = InterlockedCompareExchange(&g_menuWatchTarget, 0, 0);

    if (g_menuWatchPageBase && g_menuWatchPageSize && g_menuWatchProtectNoGuard) {
        if (!VirtualProtect(g_menuWatchPageBase, g_menuWatchPageSize,
                            g_menuWatchProtectNoGuard, &oldProt)) {
            hookLog("MENUWATCH: disarm restore FAILED page=%p err=%lu",
                    (void *)g_menuWatchPageBase, GetLastError());
        }
    }

    if (InterlockedExchange(&g_menuWatchActive, 0) != 0) {
        hookLog("MENUWATCH: disarmed target=%s reason=%s hits=%ld/%ld faults=%ld/%ld object=%p page=%p",
                menuWatchTargetName(target),
                reason ? reason : "unknown",
                (long)g_menuWatchHitsLogged,
                (long)g_menuWatchHitLimit,
                (long)g_menuWatchFaultsSeen,
                (long)g_menuWatchFaultBudget,
                (void *)g_menuWatchManager,
                (void *)g_menuWatchPageBase);
    }

    g_menuWatchManager = NULL;
    g_menuWatchPageBase = NULL;
    g_menuWatchPageSize = 0;
    g_menuWatchFieldBase = NULL;
    g_menuWatchFieldSize = 0;
    g_menuWatchProtectNoGuard = 0;
    InterlockedExchange(&g_menuWatchRearmPending, 0);
    InterlockedExchange(&g_menuWatchHitsLogged, 0);
    InterlockedExchange(&g_menuWatchFaultsSeen, 0);
    InterlockedExchange(&g_menuWatchHitLimit, 0);
    InterlockedExchange(&g_menuWatchFaultBudget, 0);
    InterlockedExchange(&g_menuWatchTarget, MENUWATCH_TARGET_NONE);
}

static LONG CALLBACK menuWatchVectoredHandler(struct _EXCEPTION_POINTERS *info) {
    DWORD code;

    if (!info || !info->ExceptionRecord || !info->ContextRecord)
        return EXCEPTION_CONTINUE_SEARCH;

    code = info->ExceptionRecord->ExceptionCode;

    if (code == STATUS_GUARD_PAGE_VIOLATION) {
        BYTE *accessed = NULL;
        ULONG_PTR accessType = (ULONG_PTR)-1;
        DWORD eip;
        DWORD caller;
        LONG faults;

        if (!InterlockedCompareExchange(&g_menuWatchActive, 0, 0))
            return EXCEPTION_CONTINUE_SEARCH;

        if (info->ExceptionRecord->NumberParameters >= 2) {
            accessType = info->ExceptionRecord->ExceptionInformation[0];
            accessed = (BYTE *)(uintptr_t)info->ExceptionRecord->ExceptionInformation[1];
        }

        if (!accessed || !g_menuWatchPageBase || !g_menuWatchPageSize ||
            accessed < g_menuWatchPageBase ||
            accessed >= g_menuWatchPageBase + g_menuWatchPageSize) {
            return EXCEPTION_CONTINUE_SEARCH;
        }

        faults = InterlockedIncrement(&g_menuWatchFaultsSeen);
        eip = (DWORD)(uintptr_t)info->ContextRecord->Eip;
        caller = readFrameCaller((DWORD)(uintptr_t)info->ContextRecord->Ebp);

        if (g_menuWatchFieldBase &&
            accessed >= g_menuWatchFieldBase &&
            accessed < g_menuWatchFieldBase + g_menuWatchFieldSize &&
            isLikelyGameCodeAddress(eip)) {
            LONG hitNo = InterlockedIncrement(&g_menuWatchHitsLogged);
            LONG target = InterlockedCompareExchange(&g_menuWatchTarget, 0, 0);

            if (target == MENUWATCH_TARGET_PENDING) {
                void *d8 = NULL;
                void *dc = NULL;
                const char *d8Name = NULL;
                const char *dcName = NULL;
                BYTE e0 = 0;
                BYTE e1 = 0;

                if (!IsBadReadPtr(g_menuWatchManager + 0x95D8, sizeof(void *)))
                    d8 = *(void **)(g_menuWatchManager + 0x95D8);
                if (!IsBadReadPtr(g_menuWatchManager + 0x95DC, sizeof(void *)))
                    dc = *(void **)(g_menuWatchManager + 0x95DC);
                d8Name = tryReadAsciiString((const char *)d8);
                dcName = tryReadAsciiString((const char *)dc);
                if (!IsBadReadPtr(g_menuWatchManager + 0x95E0, sizeof(BYTE)))
                    e0 = *(BYTE *)(g_menuWatchManager + 0x95E0);
                if (!IsBadReadPtr(g_menuWatchManager + 0x95E1, sizeof(BYTE)))
                    e1 = *(BYTE *)(g_menuWatchManager + 0x95E1);

                hookLog("MENUWATCH: target=%s hit=%ld/%ld fault=%ld/%ld %s addr=%p off=0x%04X eip=0x%08X caller=0x%08X d8=%p(%s) dc=%p(%s) e0=%u e1=%u",
                        menuWatchTargetName(target),
                        (long)hitNo,
                        (long)g_menuWatchHitLimit,
                        (long)faults,
                        (long)g_menuWatchFaultBudget,
                        menuWatchAccessName(accessType),
                        (void *)accessed,
                        (unsigned)(accessed - g_menuWatchManager),
                        (unsigned)eip,
                        (unsigned)caller,
                        d8,
                        d8Name ? d8Name : "<null>",
                        dc,
                        dcName ? dcName : "<null>",
                        (unsigned)e0,
                        (unsigned)e1);
            } else {
                BYTE f4 = 0;
                LONG f8 = -1;
                BYTE fc = 0;

                if (!IsBadReadPtr(g_menuWatchManager + 0xF4, sizeof(BYTE)))
                    f4 = *(BYTE *)(g_menuWatchManager + 0xF4);
                if (!IsBadReadPtr(g_menuWatchManager + 0xF8, sizeof(LONG)))
                    f8 = *(LONG *)(g_menuWatchManager + 0xF8);
                if (!IsBadReadPtr(g_menuWatchManager + 0xFC, sizeof(BYTE)))
                    fc = *(BYTE *)(g_menuWatchManager + 0xFC);

                hookLog("MENUWATCH: target=%s hit=%ld/%ld fault=%ld/%ld %s addr=%p off=0x%02X eip=0x%08X caller=0x%08X f4=%u f8=%ld fc=%u",
                        menuWatchTargetName(target),
                        (long)hitNo,
                        (long)g_menuWatchHitLimit,
                        (long)faults,
                        (long)g_menuWatchFaultBudget,
                        menuWatchAccessName(accessType),
                        (void *)accessed,
                        (unsigned)(accessed - g_menuWatchManager),
                        (unsigned)eip,
                        (unsigned)caller,
                        (unsigned)f4,
                        (long)f8,
                        (unsigned)fc);
            }
        } else if (faults <= 12 || (faults % 64) == 0) {
            hookLog("MENUWATCH: target=%s page-touch fault=%ld/%ld %s addr=%p eip=0x%08X caller=0x%08X",
                    menuWatchTargetName(InterlockedCompareExchange(&g_menuWatchTarget, 0, 0)),
                    (long)faults,
                    (long)g_menuWatchFaultBudget,
                    menuWatchAccessName(accessType),
                    (void *)accessed,
                    (unsigned)eip,
                    (unsigned)caller);
        }

        if (faults >= g_menuWatchFaultBudget || g_menuWatchHitsLogged >= g_menuWatchHitLimit)
            InterlockedExchange(&g_menuWatchRearmPending, 2);
        else
            InterlockedExchange(&g_menuWatchRearmPending, 1);

        info->ContextRecord->EFlags |= 0x100;
        return EXCEPTION_CONTINUE_EXECUTION;
    }

    if (code == STATUS_SINGLE_STEP) {
        LONG mode = InterlockedExchange(&g_menuWatchRearmPending, 0);

        if (!mode)
            return EXCEPTION_CONTINUE_SEARCH;

        if (!InterlockedCompareExchange(&g_menuWatchActive, 0, 0))
            return EXCEPTION_CONTINUE_EXECUTION;

        if (mode == 2 || g_menuWatchFaultsSeen >= g_menuWatchFaultBudget) {
            disarmMenuWatchpoint((g_menuWatchHitsLogged >= g_menuWatchHitLimit)
                                 ? "hit-limit"
                                 : "fault-budget");
            return EXCEPTION_CONTINUE_EXECUTION;
        }

        if (g_menuWatchPageBase && g_menuWatchPageSize && g_menuWatchProtectNoGuard) {
            DWORD oldProt;

            if (VirtualProtect(g_menuWatchPageBase, g_menuWatchPageSize,
                               g_menuWatchProtectNoGuard | PAGE_GUARD, &oldProt)) {
                return EXCEPTION_CONTINUE_EXECUTION;
            }

            hookLog("MENUWATCH: rearm FAILED page=%p err=%lu",
                    (void *)g_menuWatchPageBase, GetLastError());
        }

        disarmMenuWatchpoint("rearm-failed");
        return EXCEPTION_CONTINUE_EXECUTION;
    }

    return EXCEPTION_CONTINUE_SEARCH;
}

static int ensureMenuWatchHandlerInstalled(void) {
    if (g_menuWatchVehHandle)
        return 1;

    g_menuWatchVehHandle = AddVectoredExceptionHandler(1, menuWatchVectoredHandler);
    if (!g_menuWatchVehHandle) {
        hookLog("MENUWATCH: AddVectoredExceptionHandler FAILED err=%lu", GetLastError());
        return 0;
    }

    hookLog("MENUWATCH: vectored handler installed handle=%p", g_menuWatchVehHandle);
    return 1;
}

static int armMenuWatchpoint(LONG hits) {
    FindNamedObject_t findNamedObject = (FindNamedObject_t)0x4D6900;
    SYSTEM_INFO sysInfo;
    MEMORY_BASIC_INFORMATION mbi;
    BYTE *app = (BYTE *)0x818718;
    BYTE *manager;
    BYTE *fieldBase;
    BYTE *pageBase;
    DWORD protectNoGuard;
    DWORD oldProt;

    if (!ensureMenuWatchHandlerInstalled())
        return 0;

    if (IsBadReadPtr(app, 0x20)) {
        hookLog("MENUWATCH: app unreadable");
        return 0;
    }

    manager = (BYTE *)findNamedObject(app, "MainMenuManager");
    if (!manager || IsBadReadPtr(manager, 0x100)) {
        hookLog("MENUWATCH: manager lookup failed");
        return 0;
    }

    fieldBase = manager + 0xF4;
    if (VirtualQuery(fieldBase, &mbi, sizeof(mbi)) != sizeof(mbi) || mbi.State != MEM_COMMIT) {
        hookLog("MENUWATCH: VirtualQuery failed field=%p err=%lu", (void *)fieldBase, GetLastError());
        return 0;
    }

    protectNoGuard = mbi.Protect & ~PAGE_GUARD;
    if (!protectNoGuard || protectNoGuard == PAGE_NOACCESS) {
        hookLog("MENUWATCH: unexpected protect=0x%08X field=%p", (unsigned)mbi.Protect, (void *)fieldBase);
        return 0;
    }

    GetSystemInfo(&sysInfo);
    pageBase = (BYTE *)((uintptr_t)fieldBase & ~((uintptr_t)sysInfo.dwPageSize - 1u));

    if (InterlockedCompareExchange(&g_menuWatchActive, 0, 0))
        disarmMenuWatchpoint("rearm");

    g_menuWatchManager = manager;
    g_menuWatchFieldBase = fieldBase;
    g_menuWatchFieldSize = 0x0C;
    g_menuWatchPageBase = pageBase;
    g_menuWatchPageSize = sysInfo.dwPageSize;
    g_menuWatchProtectNoGuard = protectNoGuard;
    InterlockedExchange(&g_menuWatchHitsLogged, 0);
    InterlockedExchange(&g_menuWatchFaultsSeen, 0);
    InterlockedExchange(&g_menuWatchHitLimit, clampMenuWatchHits(hits));
    InterlockedExchange(&g_menuWatchFaultBudget, menuWatchFaultBudget(g_menuWatchHitLimit));

    if (!VirtualProtect(pageBase, g_menuWatchPageSize, protectNoGuard | PAGE_GUARD, &oldProt)) {
        hookLog("MENUWATCH: arm FAILED page=%p protect=0x%08X err=%lu",
                (void *)pageBase, (unsigned)protectNoGuard, GetLastError());
        g_menuWatchManager = NULL;
        g_menuWatchFieldBase = NULL;
        g_menuWatchFieldSize = 0;
        g_menuWatchPageBase = NULL;
        g_menuWatchPageSize = 0;
        g_menuWatchProtectNoGuard = 0;
        return 0;
    }

    InterlockedExchange(&g_menuWatchTarget, MENUWATCH_TARGET_MANAGER);
    InterlockedExchange(&g_menuWatchActive, 1);
    hookLog("MENUWATCH: armed target=%s object=%p vt=0x%08X field=%p page=%p size=0x%lx hits=%ld budget=%ld",
            menuWatchTargetName(MENUWATCH_TARGET_MANAGER),
            (void *)manager,
            !IsBadReadPtr(manager, sizeof(DWORD)) ? (unsigned)*(DWORD *)manager : 0,
            (void *)fieldBase,
            (void *)pageBase,
            (unsigned long)g_menuWatchPageSize,
            (long)g_menuWatchHitLimit,
            (long)g_menuWatchFaultBudget);
    return 1;
}

static int armScreenPendingWatchpoint(LONG hits) {
    SYSTEM_INFO sysInfo;
    MEMORY_BASIC_INFORMATION mbi;
    BYTE *app = (BYTE *)0x818718;
    BYTE *fieldBase;
    BYTE *pageBase;
    DWORD protectNoGuard;
    DWORD oldProt;

    if (!ensureMenuWatchHandlerInstalled())
        return 0;

    if (IsBadReadPtr(app, 0x95E8)) {
        hookLog("MENUWATCH: pending app unreadable");
        return 0;
    }

    fieldBase = app + 0x95D8;
    if (VirtualQuery(fieldBase, &mbi, sizeof(mbi)) != sizeof(mbi) || mbi.State != MEM_COMMIT) {
        hookLog("MENUWATCH: pending VirtualQuery failed field=%p err=%lu", (void *)fieldBase, GetLastError());
        return 0;
    }

    protectNoGuard = mbi.Protect & ~PAGE_GUARD;
    if (!protectNoGuard || protectNoGuard == PAGE_NOACCESS) {
        hookLog("MENUWATCH: pending unexpected protect=0x%08X field=%p", (unsigned)mbi.Protect, (void *)fieldBase);
        return 0;
    }

    GetSystemInfo(&sysInfo);
    pageBase = (BYTE *)((uintptr_t)fieldBase & ~((uintptr_t)sysInfo.dwPageSize - 1u));

    if (InterlockedCompareExchange(&g_menuWatchActive, 0, 0))
        disarmMenuWatchpoint("rearm");

    g_menuWatchManager = app;
    g_menuWatchFieldBase = fieldBase;
    g_menuWatchFieldSize = 0x08;
    g_menuWatchPageBase = pageBase;
    g_menuWatchPageSize = sysInfo.dwPageSize;
    g_menuWatchProtectNoGuard = protectNoGuard;
    InterlockedExchange(&g_menuWatchHitsLogged, 0);
    InterlockedExchange(&g_menuWatchFaultsSeen, 0);
    InterlockedExchange(&g_menuWatchHitLimit, clampMenuWatchHits(hits));
    InterlockedExchange(&g_menuWatchFaultBudget, menuWatchFaultBudget(g_menuWatchHitLimit));

    if (!VirtualProtect(pageBase, g_menuWatchPageSize, protectNoGuard | PAGE_GUARD, &oldProt)) {
        hookLog("MENUWATCH: pending arm FAILED page=%p protect=0x%08X err=%lu",
                (void *)pageBase, (unsigned)protectNoGuard, GetLastError());
        g_menuWatchManager = NULL;
        g_menuWatchFieldBase = NULL;
        g_menuWatchFieldSize = 0;
        g_menuWatchPageBase = NULL;
        g_menuWatchPageSize = 0;
        g_menuWatchProtectNoGuard = 0;
        return 0;
    }

    InterlockedExchange(&g_menuWatchTarget, MENUWATCH_TARGET_PENDING);
    InterlockedExchange(&g_menuWatchActive, 1);
    hookLog("MENUWATCH: armed target=%s object=%p field=%p page=%p size=0x%lx hits=%ld budget=%ld d8=%p(%s) dc=%p(%s) e0=%u e1=%u",
            menuWatchTargetName(MENUWATCH_TARGET_PENDING),
            (void *)app,
            (void *)fieldBase,
            (void *)pageBase,
            (unsigned long)g_menuWatchPageSize,
            (long)g_menuWatchHitLimit,
            (long)g_menuWatchFaultBudget,
            *(void **)(app + 0x95D8),
            tryReadAsciiString(*(const char **)(app + 0x95D8)) ? tryReadAsciiString(*(const char **)(app + 0x95D8)) : "<null>",
            *(void **)(app + 0x95DC),
            tryReadAsciiString(*(const char **)(app + 0x95DC)) ? tryReadAsciiString(*(const char **)(app + 0x95DC)) : "<null>",
            (unsigned)*(BYTE *)(app + 0x95E0),
            (unsigned)*(BYTE *)(app + 0x95E1));
    return 1;
}

static LONG clampMenuPumpCount(LONG count) {
    if (count < 1)
        return 1;
    if (count > 8)
        return 8;
    return count;
}

#define MENU_DISPATCH_VTABLE_PRIMARY 0x005D3CE4
#define MENU_DISPATCH_VTABLE_SHIFTED 0x005D3D00

static int isLikelyGamePtr(DWORD value) {
    if (value < 0x00400000 || value >= 0x00700000)
        return 0;
    return !IsBadReadPtr((void *)value, sizeof(void *));
}

static int isLikelyHeapPtr(DWORD value) {
    if (!value)
        return 0;
    if (value >= 0x00400000 && value < 0x00700000)
        return 0;
    return !IsBadReadPtr((void *)value, sizeof(void *));
}

static int isLikelyMenuDispatchVtable(DWORD value) {
    return value == MENU_DISPATCH_VTABLE_PRIMARY || value == MENU_DISPATCH_VTABLE_SHIFTED;
}

static LONG menuDispatchHandlerOffset(DWORD vtable) {
    if (vtable == MENU_DISPATCH_VTABLE_PRIMARY)
        return 0x54;
    if (vtable == MENU_DISPATCH_VTABLE_SHIFTED)
        return 0x38;
    return -1;
}

static LONG findMenuDispatchSlotIndex(BYTE *dispatchSelf, BYTE *item) {
    LONG i;

    if (!dispatchSelf || IsBadReadPtr(dispatchSelf + 0x104, sizeof(void *)))
        return -1;

    for (i = 0; i < 6; i++) {
        void *slot;

        if (IsBadReadPtr(dispatchSelf + 0xEC + (i * 4), sizeof(void *)))
            break;
        slot = *(void **)(dispatchSelf + 0xEC + (i * 4));
        if (slot == item)
            return i;
    }
    return -1;
}

static int isLikelyMenuDispatchSelf(BYTE *dispatchSelf, BYTE *item, DWORD *outVtable, LONG *outSlotIndex) {
    DWORD vtable;
    LONG slotIndex;

    if (outVtable)
        *outVtable = 0;
    if (outSlotIndex)
        *outSlotIndex = -1;

    if (!dispatchSelf || !isLikelyHeapPtr((DWORD)(uintptr_t)dispatchSelf) ||
        IsBadReadPtr(dispatchSelf, 0x44C)) {
        return 0;
    }

    vtable = *(DWORD *)dispatchSelf;
    if (!isLikelyMenuDispatchVtable(vtable))
        return 0;

    slotIndex = findMenuDispatchSlotIndex(dispatchSelf, item);
    if (slotIndex < 0 && item)
        return 0;

    if (outVtable)
        *outVtable = vtable;
    if (outSlotIndex)
        *outSlotIndex = slotIndex;
    return 1;
}

static int isReadablePageProtect(DWORD protect) {
    DWORD baseProtect = protect & 0xff;

    if (protect & (PAGE_GUARD | PAGE_NOACCESS))
        return 0;

    return baseProtect == PAGE_READONLY ||
           baseProtect == PAGE_READWRITE ||
           baseProtect == PAGE_WRITECOPY ||
           baseProtect == PAGE_EXECUTE_READ ||
           baseProtect == PAGE_EXECUTE_READWRITE ||
           baseProtect == PAGE_EXECUTE_WRITECOPY;
}

static BYTE *findGlobalMenuDispatchSelf(BYTE *item, DWORD *outVtable, LONG *outSlotIndex, void **outEventTarget) {
    SYSTEM_INFO sysInfo;
    BYTE *cursor;
    BYTE *end;
    MEMORY_BASIC_INFORMATION mbi;

    if (outVtable)
        *outVtable = 0;
    if (outSlotIndex)
        *outSlotIndex = -1;
    if (outEventTarget)
        *outEventTarget = NULL;
    if (!item)
        return NULL;

    GetSystemInfo(&sysInfo);
    cursor = (BYTE *)sysInfo.lpMinimumApplicationAddress;
    end = (BYTE *)sysInfo.lpMaximumApplicationAddress;

    while (cursor < end && VirtualQuery(cursor, &mbi, sizeof(mbi)) == sizeof(mbi)) {
        BYTE *regionBase = (BYTE *)mbi.BaseAddress;
        BYTE *regionEnd = regionBase + mbi.RegionSize;

        if (mbi.State == MEM_COMMIT &&
            isReadablePageProtect(mbi.Protect) &&
            regionEnd > regionBase + 0x104) {
            BYTE *p = (BYTE *)(((uintptr_t)regionBase + 3u) & ~3u);
            BYTE *scanEnd = regionEnd - 0x104;

            for (; p <= scanEnd; p += 4) {
                DWORD vtable = *(DWORD *)p;
                LONG i;

                if (!isLikelyMenuDispatchVtable(vtable))
                    continue;

                for (i = 0; i < 6; i++) {
                    void *slot = *(void **)(p + 0xEC + (i * 4));

                    if (slot == item) {
                        if (outVtable)
                            *outVtable = vtable;
                        if (outSlotIndex)
                            *outSlotIndex = i;
                        if (outEventTarget)
                            *outEventTarget = slot;
                        return p;
                    }
                }
            }
        }

        if (regionEnd <= cursor)
            break;
        cursor = regionEnd;
    }

    return NULL;
}

static void logMenuWrapperSummary(const char *label, BYTE *root) {
    LONG i;

    if (!root || IsBadReadPtr(root, 0x30)) {
        hookLog("MENU2: %s root=%p unreadable", label, (void *)root);
        return;
    }

    hookLog("MENU2: %s root=%p d0=0x%08X d1=0x%08X d2=0x%08X d3=0x%08X items=%p count=%ld x40=0x%08X x44=0x%08X x48=0x%08X x4c=0x%08X",
            label,
            (void *)root,
            (unsigned)*(DWORD *)(root + 0x00),
            (unsigned)*(DWORD *)(root + 0x04),
            (unsigned)*(DWORD *)(root + 0x08),
            (unsigned)*(DWORD *)(root + 0x0C),
            !IsBadReadPtr(root + 0x38, sizeof(void *)) ? *(void **)(root + 0x38) : NULL,
            !IsBadReadPtr(root + 0x3C, sizeof(LONG)) ? (long)*(LONG *)(root + 0x3C) : -1,
            !IsBadReadPtr(root + 0x40, sizeof(DWORD)) ? (unsigned)*(DWORD *)(root + 0x40) : 0,
            !IsBadReadPtr(root + 0x44, sizeof(DWORD)) ? (unsigned)*(DWORD *)(root + 0x44) : 0,
            !IsBadReadPtr(root + 0x48, sizeof(DWORD)) ? (unsigned)*(DWORD *)(root + 0x48) : 0,
            !IsBadReadPtr(root + 0x4C, sizeof(DWORD)) ? (unsigned)*(DWORD *)(root + 0x4C) : 0);

    for (i = 0; i < 8; i++) {
        DWORD child = *(DWORD *)(root + (i * 4));

        if (!isLikelyHeapPtr(child) || IsBadReadPtr((void *)child, 0x30))
            continue;
        hookLog("MENU2: %s child[%ld]=%p c0=0x%08X c1=0x%08X c2=0x%08X c3=0x%08X",
                label,
                (long)i,
                (void *)child,
                (unsigned)*(DWORD *)(child + 0x00),
                (unsigned)*(DWORD *)(child + 0x04),
                (unsigned)*(DWORD *)(child + 0x08),
                (unsigned)*(DWORD *)(child + 0x0C));
    }
}

static int isInterestingMenuVtable(DWORD value) {
    return value == TITLE_SCREEN_VTABLE ||
           value == MENU_DISPATCH_VTABLE_PRIMARY ||
           value == MENU_DISPATCH_VTABLE_SHIFTED ||
           value == 0x005D5F68 ||
           value == 0x005D5FF0 ||
           value == 0x005D0724;
}

static void logMenuObjectRefs(
    const char *label,
    BYTE *root,
    LONG scanLimit,
    BYTE *item,
    BYTE *container,
    BYTE *owner10
) {
    LONG offset;
    LONG hits = 0;

    if (!root || scanLimit <= 0 || IsBadReadPtr(root, scanLimit + 4))
        return;

    for (offset = 0; offset <= scanLimit; offset += 4) {
        DWORD value = *(DWORD *)(root + offset);

        if ((BYTE *)(uintptr_t)value == item ||
            (BYTE *)(uintptr_t)value == container ||
            (BYTE *)(uintptr_t)value == owner10) {
            hookLog("MENU2: %s root=%p +0x%lx -> %p%s%s%s",
                    label,
                    (void *)root,
                    (long)offset,
                    (void *)(uintptr_t)value,
                    ((BYTE *)(uintptr_t)value == item) ? " [item]" : "",
                    ((BYTE *)(uintptr_t)value == container) ? " [container]" : "",
                    ((BYTE *)(uintptr_t)value == owner10) ? " [owner10]" : "");
            if (++hits >= 32)
                break;
            continue;
        }

        if (isInterestingMenuVtable(value)) {
            hookLog("MENU2: %s root=%p +0x%lx embedded-vt=0x%08X",
                    label, (void *)root, (long)offset, (unsigned)value);
            if (++hits >= 32)
                break;
            continue;
        }

        if (isLikelyHeapPtr(value) && !IsBadReadPtr((void *)value, sizeof(DWORD))) {
            DWORD pointeeVtable = *(DWORD *)(uintptr_t)value;
            if (isInterestingMenuVtable(pointeeVtable)) {
                hookLog("MENU2: %s root=%p +0x%lx ptr=%p vt=0x%08X",
                        label,
                        (void *)root,
                        (long)offset,
                        (void *)(uintptr_t)value,
                        (unsigned)pointeeVtable);
                if (++hits >= 32)
                    break;
            }
        }
    }

    if (hits == 0) {
        hookLog("MENU2: %s root=%p no interesting refs within 0x%lx",
                label, (void *)root, (long)scanLimit);
    }
}

static BYTE *findLikelyWrappedMenuDispatchSelf(
    BYTE *root,
    BYTE *item,
    LONG depth,
    LONG embedScanLimit,
    LONG *outIndex0,
    LONG *outIndex1,
    LONG *outInnerOffset,
    DWORD *outVtable
) {
    LONG offset;
    LONG i;

    if (outIndex0)
        *outIndex0 = -1;
    if (outIndex1)
        *outIndex1 = -1;
    if (outInnerOffset)
        *outInnerOffset = -1;
    if (outVtable)
        *outVtable = 0;

    if (embedScanLimit <= 0)
        embedScanLimit = 0x200;

    if (!root || IsBadReadPtr(root, 0x60))
        return NULL;

    if (isLikelyHeapPtr((DWORD)(uintptr_t)root)) {
        for (offset = 0; offset <= embedScanLimit; offset += 4) {
            BYTE *candidate = root + offset;
            DWORD candidateVtable = 0;

            if (isLikelyMenuDispatchSelf(candidate, item, &candidateVtable, NULL)) {
                if (outInnerOffset)
                    *outInnerOffset = offset;
                if (outVtable)
                    *outVtable = candidateVtable;
                return candidate;
            }
        }
    }

    if (depth <= 0)
        return NULL;

    for (i = 0; i < 128; i++) {
        DWORD child = *(DWORD *)(root + (i * 4));
        BYTE *found;
        LONG childIndex0 = -1;
        LONG childIndex1 = -1;
        LONG childInnerOffset = -1;
        DWORD childVtable = 0;

        if (!isLikelyHeapPtr(child) || IsBadReadPtr((void *)child, 0x60))
            continue;

        found = findLikelyWrappedMenuDispatchSelf(
            (BYTE *)child, item, depth - 1, embedScanLimit,
            &childIndex0, &childIndex1, &childInnerOffset, &childVtable);
        if (!found)
            continue;

        if (outIndex0)
            *outIndex0 = i;
        if (outIndex1)
            *outIndex1 = childIndex0;
        if (outInnerOffset)
            *outInnerOffset = childInnerOffset;
        if (outVtable)
            *outVtable = childVtable;
        return found;
    }

    return NULL;
}

static void pumpMenuApp(const char *label, LONG count) {
    MenuAppPump_t pump = (MenuAppPump_t)0x4D5E00;
    LONG clamped = clampMenuPumpCount(count);
    LONG i;

    for (i = 0; i < clamped; i++) {
        hookLog("MENUPUMP: %s iter=%ld/%ld", label ? label : "manual", (long)(i + 1), (long)clamped);
        logMenuAppState("pump-before");
        logMenuQueueState("pump-before");
        pump((void *)0x818718);
        hookLog("MENUPUMP: %s iter=%ld/%ld returned stage=%ld",
                label ? label : "manual",
                (long)(i + 1),
                (long)clamped,
                (long)g_screenOpenTraceStage);
        logMenuAppState("pump-after");
        logMenuQueueState("pump-after");
    }
}

static void postPendingUiWork(const char *reason) {
    HWND hwnd = g_gameHwnd;
    LONG seq;

    if (!hwnd)
        return;

    seq = InterlockedIncrement(&g_pendingUiDispatchSeq);
    if (!PostMessageA(hwnd, WM_APP_PENDING_UI, (WPARAM)seq, 0)) {
        hookLog("UIWORK: post reason=%s FAILED hwnd=%p err=%lu",
                reason ? reason : "unknown", (void *)hwnd, GetLastError());
        return;
    }

    hookLog("UIWORK: post reason=%s seq=%ld hwnd=%p",
            reason ? reason : "unknown", (long)seq, (void *)hwnd);
}

static int applyPendingD8Lite(BYTE *app, const char *label) {
    void (__attribute__((thiscall)) *attachPendingScreen)(void *self, void *pending) =
        (void (__attribute__((thiscall)) *)(void *, void *))0x524A90;
    void (__attribute__((thiscall)) *resetMenuState)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4D3FA0;
    void (__attribute__((thiscall)) *releasePendingObj)(void *self, void *obj) =
        (void (__attribute__((thiscall)) *)(void *, void *))0x54BCB0;
    void (__cdecl *freeHeap)(void *ptr) = (void (__cdecl *)(void *))0x5B0C8F;
    LONG sel;
    LONG count;
    void *pending;
    void *cleanup;
    void *screenObj;

    if (!app || IsBadReadPtr(app, 0x95E0))
        return 0;

    g_screenOpenTraceStage = 171;
    pending = *(void **)(app + 0x95D8);
    if (!pending)
        return 0;

    sel = *(LONG *)(app + 0x0C);
    count = *(LONG *)(app + 0x08);
    if (sel < 0 || sel >= count) {
        hookLog("SCREENOPEN[%s]: d8 pending=%p invalid sel=%ld count=%ld",
                label ? label : "unknown", pending, (long)sel, (long)count);
        return 0;
    }

    cleanup = *(void **)(app + 0x95BC);
    if (cleanup) {
        g_screenOpenTraceStage = 172;
        releasePendingObj(app + 0x74, cleanup);
        *(void **)(app + 0x95BC) = NULL;
    }

    screenObj = *(void **)(app + (sel * 4));
    if (!screenObj) {
        hookLog("SCREENOPEN[%s]: d8 pending=%p null screen object sel=%ld",
                label ? label : "unknown", pending, (long)sel);
        return 0;
    }

    *(void **)(app + 0x95D8) = NULL;
    g_screenOpenTraceStage = 173;
    attachPendingScreen(screenObj, pending);
    g_screenOpenTraceStage = 174;
    freeHeap(pending);
    g_screenOpenTraceStage = 175;
    resetMenuState(app + 0x8160);
    *(DWORD *)(app + 0x95C0) = 0;
    g_screenOpenTraceStage = 176;
    hookLog("SCREENOPEN[%s]: applied pending d8=%p sel=%ld screen=%p",
            label ? label : "unknown", pending, (long)sel, screenObj);
    return 1;
}

static int applyPendingDcLite(BYTE *app, const char *label) {
    int (__cdecl *cmpStrings)(const char *lhs, const char *rhs) =
        (int (__cdecl *)(const char *, const char *))0x5B25E0;
    void (__attribute__((thiscall)) *resetDispatchList)(void *self, int a, int b) =
        (void (__attribute__((thiscall)) *)(void *, int, int))0x49F460;
    void (__attribute__((thiscall)) *clearList74)(void *self, int value) =
        (void (__attribute__((thiscall)) *)(void *, int))0x54BD80;
    void (__attribute__((thiscall)) *resetQueueRoot)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4E8260;
    void (__attribute__((thiscall)) *flushDispatchList)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x49F1E0;
    void (__attribute__((thiscall)) *finishList74)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x54BD10;
    void (__attribute__((thiscall)) *prepare95a0)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4B2030;
    void (__attribute__((thiscall)) *setB7D108Mode)(void *self, int value) =
        (void (__attribute__((thiscall)) *)(void *, int))0x54C650;
    void (__attribute__((thiscall)) *reset74Full)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x54BBE0;
    void (__attribute__((thiscall)) *reset7D7650A)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4ABA40;
    void (__attribute__((thiscall)) *destroy821D64)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4A0890;
    void (__attribute__((thiscall)) *reset818458)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4CFE20;
    void (__cdecl *apply7D75B4)(DWORD value) = (void (__cdecl *)(DWORD))0x417690;
    void (__attribute__((thiscall)) *reset817C10)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4BFA10;
    void (__attribute__((thiscall)) *refreshMenuApp)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4D4DA0;
    void (__attribute__((thiscall)) *reset7D7650B)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4AB160;
    void (__attribute__((thiscall)) *apply605B50)(void *self, const char *value) =
        (void (__attribute__((thiscall)) *)(void *, const char *))0x54B980;
    void (__cdecl *freeHeap)(void *ptr) = (void (__cdecl *)(void *))0x5B0C8F;
    void (__attribute__((thiscall)) *flushPostSelect)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x49EF70;
    void (__attribute__((thiscall)) *finalizeCurrent)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x524AF0;
    FindNamedObject_t findNamedObject = (FindNamedObject_t)0x4D6900;
    void (__attribute__((thiscall)) *applyNamedValue)(void *self, void *value) =
        (void (__attribute__((thiscall)) *)(void *, void *))0x55A750;
    void (__attribute__((thiscall)) *resetMenuState)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4D3FA0;
    const char *pendingName;
    LONG count;
    LONG found = -1;
    LONG prevSel;
    LONG i;
    BYTE *screen;
    void **items;
    BYTE *list74;
    BYTE *list88;
    BYTE *current;
    void *tmp;
    BYTE *node;

    if (!app || IsBadReadPtr(app, 0x95E0))
        return 0;

    g_screenOpenTraceStage = 151;
    pendingName = *(const char **)(app + 0x95DC);
    if (!pendingName)
        return 0;

    hookLog("SCREENOPEN[%s]: mode=4 resolving dc=%p (%s)",
            label ? label : "unknown", pendingName, pendingName);

    prevSel = *(LONG *)(app + 0x0C);
    count = *(LONG *)(app + 0x08);
    if (prevSel < 0 || prevSel >= count) {
        hookLog("SCREENOPEN[%s]: mode=4 invalid current sel=%ld count=%ld",
                label ? label : "unknown", (long)prevSel, (long)count);
        return 0;
    }

    screen = *(BYTE **)(app + (prevSel * 4));
    if (!screen || IsBadReadPtr(screen, 0x20)) {
        hookLog("SCREENOPEN[%s]: mode=4 unreadable current screen sel=%ld ptr=%p",
                label ? label : "unknown", (long)prevSel, (void *)screen);
        return 0;
    }

    items = *(void ***)(screen + 0x08);
    count = *(LONG *)(screen + 0x0C);
    if (!items || count <= 0 || count > 64) {
        hookLog("SCREENOPEN[%s]: mode=4 invalid screen items=%p count=%ld sel=%ld",
                label ? label : "unknown", (void *)items, (long)count, (long)prevSel);
        return 0;
    }

    for (i = 0; i < count; i++) {
        BYTE *entry;
        const char *entryName;

        if (IsBadReadPtr(&items[i], sizeof(void *)))
            continue;
        entry = (BYTE *)items[i];
        if (!entry || IsBadReadPtr(entry, 0x1C))
            continue;
        entryName = tryReadAsciiString(*(const char **)entry);
        if (i < 4) {
            hookLog("SCREENOPEN[%s]: mode=4 cand[%ld] entry=%p name=%s",
                    label ? label : "unknown",
                    (long)i,
                    (void *)entry,
                    entryName ? entryName : "<null>");
        }
        if (!entryName)
            continue;
        if (cmpStrings(entryName, pendingName) == 0) {
            found = i;
            hookLog("SCREENOPEN[%s]: mode=4 matched dc=%s at index=%ld entry=%p",
                    label ? label : "unknown",
                    pendingName,
                    (long)found,
                    (void *)entry);
            break;
        }
    }

    if (found < 0) {
        hookLog("SCREENOPEN[%s]: mode=4 unresolved dc=%p (%s)",
                label ? label : "unknown", pendingName, pendingName);
        return 0;
    }
    list88 = app + 0x88;
    list74 = app + 0x74;

    g_screenOpenTraceStage = 152;
    *(DWORD *)(app + 0x95D0) = 0;
    *(DWORD *)(app + 0x95D4) = 0xFFFFFFFFu;
    *(DWORD *)(app + 0x95BC) = 0;
    resetDispatchList(list88, 0, 0);
    clearList74(list74, 0);

    if (prevSel >= 0 && prevSel < count) {
        current = *(BYTE **)(app + (prevSel * 4));
        if (current && !IsBadReadPtr(current, sizeof(void *))) {
            void **vtable = *(void ***)current;
            if (vtable && !IsBadReadPtr(vtable + 4, sizeof(void *)))
                ((void (__attribute__((thiscall)) *)(void *))vtable[4])(current);
        }
    }

    resetQueueRoot((void *)0x8824E8);
    flushDispatchList(list88);
    finishList74(list74);
    *(LONG *)(app + 0x0C) = found;

    g_screenOpenTraceStage = 1543;
    /* Avoid allocator-side stalls on the forced commit path. */
    *(DWORD *)(app + 0x95DC) = 0;
    g_screenOpenTraceStage = 1544;

    current = *(BYTE **)(app + (found * 4));
    if (!current || IsBadReadPtr(current, sizeof(void *))) {
        hookLog("SCREENOPEN[%s]: mode=4 found=%ld but current item missing",
                label ? label : "unknown", (long)found);
        return 0;
    }

    {
        unsigned char okay = 1;

        if (okay) {
            g_screenOpenTraceStage = 1550;
            *(DWORD *)(app + 0x95D4) = 0xFFFFFFFFu;
            *(DWORD *)(uintptr_t)0xB7D118 = 0;
            g_screenOpenTraceStage = 1551;
            flushPostSelect(list88);
            g_screenOpenTraceStage = 1552;
            if (*(void **)(app + 0x95D8) == NULL) {
                g_screenOpenTraceStage = 1553;
                finalizeCurrent(current);
                g_screenOpenTraceStage = 1554;
            }

            g_screenOpenTraceStage = 156;
            node = *(BYTE **)(app + 0x70);
            while (node && !IsBadReadPtr(node, 12)) {
                const char *name = *(const char **)node;
                void *value = *(void **)(node + 4);
                BYTE *target = NULL;

                if (name)
                    target = (BYTE *)findNamedObject(app, name);
                if (target)
                    applyNamedValue(target, value);
                node = *(BYTE **)(node + 8);
            }

            g_screenOpenTraceStage = 157;
            resetMenuState(app + 0x8160);
            *(DWORD *)(app + 0x95C0) = 0;
            *(DWORD *)(uintptr_t)0xB7D118 = 1;
        }
    }

    g_screenOpenTraceStage = 159;
    hookLog("SCREENOPEN[%s]: mode=4 committed dc=%s found=%ld prev=%ld d8=%p",
            label ? label : "unknown",
            pendingName,
            (long)found,
            (long)prevSel,
            *(void **)(app + 0x95D8));
    return 1;
}

static int selectCurrentScreenEntry(BYTE *app, const char *entryName, const char *label) {
    void (__attribute__((thiscall)) *selectScreenEntry)(void *self, void *pending) =
        (void (__attribute__((thiscall)) *)(void *, void *))0x524A90;
    void (__attribute__((thiscall)) *resetMenuState)(void *self) =
        (void (__attribute__((thiscall)) *)(void *))0x4D3FA0;
    LONG sel;
    LONG count;
    BYTE *screen;

    if (!app || !entryName || !entryName[0] || IsBadReadPtr(app, 0x20))
        return 0;

    sel = *(LONG *)(app + 0x0C);
    count = *(LONG *)(app + 0x08);
    if (sel < 0 || sel >= count) {
        hookLog("SCREENENTRY[%s]: invalid sel=%ld count=%ld name=%s",
                label ? label : "unknown", (long)sel, (long)count, entryName);
        return 0;
    }

    screen = *(BYTE **)(app + (sel * 4));
    if (!screen || IsBadReadPtr(screen, sizeof(void *))) {
        hookLog("SCREENENTRY[%s]: null screen sel=%ld name=%s",
                label ? label : "unknown", (long)sel, entryName);
        return 0;
    }

    /* The game uses POINTER COMPARISON for screen names — the second parameter
     * to selectScreenEntry must be the game's own interned string address (in
     * the .rdata section), not a copy on our stack.  namedScreenAddress()
     * returns the address of the game's string constant for known screen names.
     * If we can't resolve, fall back to passing entryName directly. */
    {
        DWORD gameStrAddr = namedScreenAddress(entryName);
        void *pending = gameStrAddr ? (void *)(uintptr_t)gameStrAddr : (void *)entryName;
        hookLog("SCREENENTRY[%s]: calling selectScreenEntry screen=%p pending=%p (gameAddr=0x%08X) name=%s",
                label ? label : "unknown", (void *)screen, pending,
                (unsigned)gameStrAddr, entryName);
        selectScreenEntry(screen, pending);
    }
    resetMenuState(app + 0x8160);
    *(DWORD *)(app + 0x95C0) = 0;
    hookLog("SCREENENTRY[%s]: selected name=%s sel=%ld screen=%p",
            label ? label : "unknown", entryName, (long)sel, (void *)screen);
    return 1;
}

/* --- SetTimer-based navigation callback ---
 * Fires from the game's own DispatchMessage processing (via PeekMessage loop).
 * NO DInput COM locks held, NO WndProc reentrancy — safest context for calling
 * game screen transition functions like selectScreenEntry.
 *
 * Uses SEH to catch and report any access violations instead of crashing. */
static volatile LONG g_timerNavScreenIdx = -1;  /* -1=use sel, 0..N=explicit index */

static VOID CALLBACK timerNavCallback(HWND hwnd, UINT msg, UINT_PTR id, DWORD time) {
    BYTE *app = (BYTE *)0x818718;
    char name[64];
    int ok = 0;
    LONG screenIdx;

    /* Kill timer immediately — one-shot */
    KillTimer(hwnd, TIMER_ID_NAV);
    g_timerNavArmed = 0;

    memcpy(name, g_timerNavName, sizeof(name));
    name[sizeof(name) - 1] = 0;
    screenIdx = g_timerNavScreenIdx;

    hookLog("TIMERNAV: firing for name=%s screenIdx=%ld hwnd=%p", name, (long)screenIdx, (void *)hwnd);
    logMenuAppState("timernav-before");
    logMainMenuState("timernav-before");

    /* Validate app state */
    if (IsBadReadPtr(app, 0x20)) {
        hookLog("TIMERNAV: app not readable, aborting");
        return;
    }

    {
        void (__attribute__((thiscall)) *selectScreenEntry)(void *self, void *pending) =
            (void (__attribute__((thiscall)) *)(void *, void *))0x524A90;
        void (__attribute__((thiscall)) *resetMenuState)(void *self) =
            (void (__attribute__((thiscall)) *)(void *))0x4D3FA0;
        LONG sel = *(LONG *)(app + 0x0C);
        LONG count = *(LONG *)(app + 0x08);
        LONG idx = (screenIdx >= 0) ? screenIdx : sel;
        BYTE *screen;
        DWORD gameStrAddr;

        hookLog("TIMERNAV: sel=%ld count=%ld using idx=%ld", (long)sel, (long)count, (long)idx);

        if (idx < 0 || idx >= count) {
            hookLog("TIMERNAV: idx out of range, aborting");
            return;
        }

        screen = *(BYTE **)(app + (idx * 4));
        if (!screen || IsBadReadPtr(screen, 0x100)) {
            hookLog("TIMERNAV: screen[%ld] at %p not readable, aborting", (long)idx, (void *)screen);
            return;
        }

        gameStrAddr = namedScreenAddress(name);
        if (!gameStrAddr) {
            hookLog("TIMERNAV: unknown screen name '%s', aborting", name);
            return;
        }

        /* Log screen vtable and first few fields for diagnostics */
        {
            DWORD vt = *(DWORD *)screen;
            DWORD f4 = *(DWORD *)(screen + 4);
            DWORD f8 = *(DWORD *)(screen + 8);
            hookLog("TIMERNAV: screen[%ld]=%p vt=%08X +4=%08X +8=%08X",
                    (long)idx, (void *)screen, vt, f4, f8);
        }

        hookLog("TIMERNAV: calling selectScreenEntry(screen=%p, pending=%p gameAddr=0x%08X)",
                (void *)screen, (void *)(uintptr_t)gameStrAddr, (unsigned)gameStrAddr);

        selectScreenEntry(screen, (void *)(uintptr_t)gameStrAddr);

        hookLog("TIMERNAV: selectScreenEntry returned OK");

        resetMenuState(app + 0x8160);
        hookLog("TIMERNAV: resetMenuState returned OK");

        *(DWORD *)(app + 0x95C0) = 0;
        ok = 1;
    }

    hookLog("TIMERNAV: result=%d name=%s", ok, name);
    logMenuAppState("timernav-after");
    logMainMenuState("timernav-after");
    g_menuTraceRemaining = 6;
}

/* Timer callback for directly calling vtable[0x3C](entryIndex) on a screen.
 * Used for screens whose entries have NULL names (e.g., house selection). */
#define TIMER_ID_SELECTIDX 0xD1D1
static volatile LONG g_timerSelectIdxArmed = 0;
static volatile LONG g_timerSelectIdxScreen = -1;
static volatile LONG g_timerSelectIdxEntry = 0;

static VOID CALLBACK timerSelectIdxCallback(HWND hwnd, UINT msg, UINT_PTR id, DWORD time) {
    BYTE *app = (BYTE *)0x818718;
    LONG screenIdx;
    LONG entryIdx;

    KillTimer(hwnd, TIMER_ID_SELECTIDX);
    g_timerSelectIdxArmed = 0;

    screenIdx = g_timerSelectIdxScreen;
    entryIdx = g_timerSelectIdxEntry;

    hookLog("TIMERSELECT: firing screenIdx=%ld entryIdx=%ld", (long)screenIdx, (long)entryIdx);
    logMenuAppState("timerselect-before");

    if (IsBadReadPtr(app, 0x20)) {
        hookLog("TIMERSELECT: app not readable, aborting");
        return;
    }

    {
        LONG count = *(LONG *)(app + 0x08);
        LONG sel = *(LONG *)(app + 0x0C);
        LONG idx = (screenIdx >= 0) ? screenIdx : sel;
        BYTE *screen;
        DWORD vtable;
        DWORD selectFn;

        hookLog("TIMERSELECT: count=%ld sel=%ld using idx=%ld", (long)count, (long)sel, (long)idx);

        if (idx < 0 || idx >= count) {
            hookLog("TIMERSELECT: idx out of range, aborting");
            return;
        }

        screen = *(BYTE **)(app + (idx * 4));
        if (!screen || IsBadReadPtr(screen, 0x10)) {
            hookLog("TIMERSELECT: screen[%ld]=%p not readable, aborting", (long)idx, (void *)screen);
            return;
        }

        vtable = *(DWORD *)screen;
        if (!vtable || IsBadReadPtr((void *)(vtable + 0x3C), 4)) {
            hookLog("TIMERSELECT: vtable=%08X not readable, aborting", vtable);
            return;
        }

        selectFn = *(DWORD *)(vtable + 0x3C);
        if (!selectFn || IsBadReadPtr((void *)selectFn, 1)) {
            hookLog("TIMERSELECT: selectFn=%08X not readable, aborting", selectFn);
            return;
        }

        {
            /* Check entry count at screen+0x0C to validate entryIdx */
            LONG entryCount = *(LONG *)(screen + 0x0C);
            hookLog("TIMERSELECT: screen=%p vtable=%08X selectFn=%08X entryCount=%ld entryIdx=%ld",
                    (void *)screen, vtable, selectFn, (long)entryCount, (long)entryIdx);

            if (entryIdx < 0 || entryIdx >= entryCount) {
                hookLog("TIMERSELECT: entryIdx out of range (0..%ld), aborting", (long)(entryCount - 1));
                return;
            }
        }

        /* Call vtable[0x3C](entryIdx) — thiscall: ecx=screen, arg=entryIdx */
        {
            typedef void (__attribute__((thiscall)) *VtableSelectFn)(void *, LONG);
            hookLog("TIMERSELECT: calling selectFn=%08X(screen=%p, idx=%ld)...",
                    selectFn, (void *)screen, (long)entryIdx);
            ((VtableSelectFn)selectFn)(screen, entryIdx);
            hookLog("TIMERSELECT: selectFn returned OK");
        }

        /* Reset menu state like timerNavCallback does */
        {
            void (__attribute__((thiscall)) *resetMenuState)(void *self) =
                (void (__attribute__((thiscall)) *)(void *))0x4D3FA0;
            resetMenuState(app + 0x8160);
            hookLog("TIMERSELECT: resetMenuState returned OK");
        }

        *(DWORD *)(app + 0x95C0) = 0;
    }

    hookLog("TIMERSELECT: done screenIdx=%ld entryIdx=%ld", (long)screenIdx, (long)entryIdx);
    logMenuAppState("timerselect-after");
    g_menuTraceRemaining = 6;
}

/* Timer callback for popping the top screen (dismissing title overlay).
 * Simply decrements the screen count, making the next screen active. */
#define TIMER_ID_POPSCREEN 0xD1CF
static volatile LONG g_timerPopArmed = 0;

static VOID CALLBACK timerPopScreenCallback(HWND hwnd, UINT msg, UINT_PTR id, DWORD time) {
    BYTE *app = (BYTE *)0x818718;

    KillTimer(hwnd, TIMER_ID_POPSCREEN);
    g_timerPopArmed = 0;

    hookLog("TIMERPOP: firing");
    logMenuAppState("timerpop-before");
    logMainMenuState("timerpop-before");

    if (IsBadReadPtr(app, 0x20)) {
        hookLog("TIMERPOP: app not readable");
        return;
    }

    {
        LONG count = *(LONG *)(app + 0x08);
        LONG sel = *(LONG *)(app + 0x0C);

        hookLog("TIMERPOP: count=%ld sel=%ld", (long)count, (long)sel);

        if (count >= 2) {
            /* Pop screen[0]: copy screen[1] to screen[0], clear screen[1] */
            DWORD s1 = *(DWORD *)(app + 4);
            *(DWORD *)(app + 0) = s1;
            *(DWORD *)(app + 4) = 0;
            count = 1;
            *(LONG *)(app + 0x08) = count;

            /* Clamp sel */
            if (sel >= count) sel = count - 1;
            if (sel < 0) sel = 0;
            *(LONG *)(app + 0x0C) = sel;

            hookLog("TIMERPOP: popped, new count=%ld sel=%ld screen[0]=%p",
                    (long)count, (long)sel,
                    (void *)(uintptr_t)(*(DWORD *)(app + sel * 4)));
        } else {
            hookLog("TIMERPOP: count=%ld, nothing to pop", (long)count);
        }
    }

    logMenuAppState("timerpop-after");
    logMainMenuState("timerpop-after");
    g_menuTraceRemaining = 6;
}

/* Timer callback for opening a screen via prepScreen+openScreen+commitScreen.
 * This is the full screen transition sequence used by the game's own menu code. */
#define TIMER_ID_OPENSCREEN 0xD1D0
static volatile DWORD g_timerScreenAddr = 0;

static VOID CALLBACK timerOpenScreenCallback(HWND hwnd, UINT msg, UINT_PTR id, DWORD time) {
    BYTE *app = (BYTE *)0x818718;
    DWORD screenAddr;

    KillTimer(hwnd, TIMER_ID_OPENSCREEN);

    screenAddr = g_timerScreenAddr;
    g_timerScreenAddr = 0;

    hookLog("TIMERSCREEN: firing addr=0x%08X hwnd=%p", (unsigned)screenAddr, (void *)hwnd);
    logMenuAppState("timerscreen-before");
    logMainMenuState("timerscreen-before");

    if (!screenAddr || IsBadReadPtr(app, 0x20)) {
        hookLog("TIMERSCREEN: invalid state, aborting");
        return;
    }

    {
        MenuCase3Item_t prepScreen = (MenuCase3Item_t)0x4D69D0;
        MenuCase2Item_t openScreen = (MenuCase2Item_t)0x4D6A40;
        MenuCase4Item_t commitScreen = (MenuCase4Item_t)0x4D5D00;
        void (__cdecl *flushScreenQueue)(void) = (void (__cdecl *)(void))0x4EA190;

        hookLog("TIMERSCREEN: calling prepScreen(app=%p, addr=%p)", (void *)app, (void *)(uintptr_t)screenAddr);
        prepScreen((void *)0x818718, (void *)(uintptr_t)screenAddr);
        hookLog("TIMERSCREEN: prepScreen returned OK");

        hookLog("TIMERSCREEN: calling openScreen(app=%p, addr=%p, 1)", (void *)app, (void *)(uintptr_t)screenAddr);
        openScreen((void *)0x818718, (void *)(uintptr_t)screenAddr, 1);
        hookLog("TIMERSCREEN: openScreen returned OK");

        hookLog("TIMERSCREEN: calling commitScreen(app=%p, 0)", (void *)app);
        commitScreen((void *)0x818718, 0);
        hookLog("TIMERSCREEN: commitScreen returned OK");

        hookLog("TIMERSCREEN: calling flushScreenQueue");
        flushScreenQueue();
        hookLog("TIMERSCREEN: flushScreenQueue returned OK");
    }

    hookLog("TIMERSCREEN: complete addr=0x%08X", (unsigned)screenAddr);
    logMenuAppState("timerscreen-after");
    logMainMenuState("timerscreen-after");
    g_menuTraceRemaining = 6;
}

static void processPendingUiWork(const char *source) {
    const char *label = source ? source : "unknown";
    LONG screenAutoPumpCount = 0;

    if (g_screenOpenPendingAddr != 0) {
        MenuCase3Item_t prepScreen = (MenuCase3Item_t)0x4D69D0;
        MenuCase2Item_t openScreen = (MenuCase2Item_t)0x4D6A40;
        MenuCase4Item_t commitScreen = (MenuCase4Item_t)0x4D5D00;
        void (__cdecl *flushScreenQueue)(void) = (void (__cdecl *)(void))0x4EA190;
        BYTE *app = (BYTE *)0x818718;
        DWORD screenAddr = g_screenOpenPendingAddr;
        LONG screenMode = g_screenOpenPendingMode;

        g_screenOpenPendingAddr = 0;
        g_screenOpenPendingMode = 0;
        screenAutoPumpCount = g_screenOpenAutoPumpCount;
        g_screenOpenAutoPumpCount = 0;
        g_screenOpenTraceStage = 100;
        hookLog("SCREENOPEN[%s]: mode=%ld addr=0x%08X before", label, (long)screenMode, (unsigned)screenAddr);
        logMenuAppState("screen-before");
        logMainMenuState("screen-before");
        if (screenMode == 2 || screenMode == 4) {
            g_screenOpenTraceStage = 101;
            prepScreen((void *)0x818718, (void *)(uintptr_t)screenAddr);
            g_screenOpenTraceStage = 102;
            openScreen((void *)0x818718, (void *)(uintptr_t)screenAddr, 1);
            g_screenOpenTraceStage = 103;
            commitScreen((void *)0x818718, 0);
        } else {
            g_screenOpenTraceStage = 104;
            openScreen((void *)0x818718, (void *)(uintptr_t)screenAddr, 1);
        }
        g_screenOpenTraceStage = 105;
        flushScreenQueue();
        g_screenOpenTraceStage = 106;
        if (screenMode == 4)
            applyPendingDcLite(app, label);
        g_screenOpenTraceStage = 107;
        if (screenMode == 3 || screenMode == 4)
            applyPendingD8Lite(app, label);
        g_screenOpenTraceStage = 108;
        hookLog("SCREENOPEN[%s]: mode=%ld addr=0x%08X completed", label, (long)screenMode, (unsigned)screenAddr);
        logMenuAppState("screen-after");
        logMainMenuState("screen-after");
        g_menuTraceRemaining = 6;
        if (screenAutoPumpCount > 0) {
            g_screenOpenTraceStage = 109;
            hookLog("SCREENOPEN[%s]: autopump=%ld begin", label, (long)screenAutoPumpCount);
            pumpMenuApp(label, screenAutoPumpCount);
            g_screenOpenTraceStage = 110;
            hookLog("SCREENOPEN[%s]: autopump=%ld completed", label, (long)screenAutoPumpCount);
            logMenuAppState("screen-autopump-after");
            logMainMenuState("screen-autopump-after");
            g_menuTraceRemaining = 6;
        }
    }

    if (g_screenPendingApplyMode != 0) {
        void (__cdecl *flushScreenQueue)(void) = (void (__cdecl *)(void))0x4EA190;
        BYTE *app = (BYTE *)0x818718;
        LONG pendingMode = g_screenPendingApplyMode;

        g_screenPendingApplyMode = 0;
        g_screenOpenTraceStage = 180;
        hookLog("SCREENPENDING[%s]: mode=%ld before", label, (long)pendingMode);
        logMenuAppState("pending-before");
        logMainMenuState("pending-before");

        flushScreenQueue();
        g_screenOpenTraceStage = 181;
        if (pendingMode & 0x2)
            applyPendingDcLite(app, label);
        g_screenOpenTraceStage = 182;
        if (pendingMode & 0x1)
            applyPendingD8Lite(app, label);
        g_screenOpenTraceStage = 183;

        hookLog("SCREENPENDING[%s]: mode=%ld completed", label, (long)pendingMode);
        logMenuAppState("pending-after");
        logMainMenuState("pending-after");
        g_menuTraceRemaining = 6;
    }

    if (g_screenEntryPending) {
        BYTE *app = (BYTE *)0x818718;
        char name[64];

        memcpy(name, g_screenEntryName, sizeof(name));
        name[sizeof(name) - 1] = 0;
        g_screenEntryPending = 0;
        selectCurrentScreenEntry(app, name, label);
        g_menuTraceRemaining = 6;
    }

    if (g_menuPumpPending) {
        LONG pumpCount = g_menuPumpCount;
        g_menuPumpPending = 0;
        pumpMenuApp(label, pumpCount);
        g_menuTraceRemaining = 6;
        hookLog("MENUPUMP[%s]: count=%ld completed", label, (long)pumpCount);
    }
}

static int hasPendingWakeWork(void) {
    return (g_injState != INJ_IDLE && g_injState != INJ_COMPLETE) ||
           (g_rawclickState != RAWCLICK_IDLE && g_rawclickState != RAWCLICK_DONE) ||
           (g_gameclickState != GAMECLICK_IDLE && g_gameclickState != GAMECLICK_DONE) ||
           g_menuClickState == MENUCLICK_PENDING_DOWN ||
           g_menuClickState == MENUCLICK_PENDING_UP ||
           g_menuDirectMode != MENUDIRECT_NONE ||
           g_menuPumpPending != 0 ||
           g_menuWrapPending != 0 ||
           g_menuItemKeyPending != 0 ||
           g_menuItemFlushPending != 0 ||
           g_menuWatchPendingCommand != 0 ||
           g_menuWatchRearmPending != 0 ||
           g_screenOpenPendingAddr != 0 ||
           g_screenPendingApplyMode != 0 ||
           g_screenEntryPending != 0 ||
           g_menuTraceRemaining > 0;
}

static int resolveMenuTargetEntry(
    LONG target,
    BYTE **outRawContainer,
    BYTE **outContainer,
    BYTE **outItem,
    LONG *outChildIndex,
    LONG *outItemIndex
) {
    BYTE *container;
    BYTE *rawContainer;
    BYTE *item;
    BYTE *parent;
    LONG childIndex = -1;
    LONG itemIndex = -1;

    if (outRawContainer)
        *outRawContainer = NULL;
    if (outContainer)
        *outContainer = NULL;
    if (outItem)
        *outItem = NULL;
    if (outChildIndex)
        *outChildIndex = -1;
    if (outItemIndex)
        *outItemIndex = -1;

    container = (BYTE *)selectMenuContainerForTarget(target, &childIndex);
    if (!container) {
        hookLog("MENU: no active container for target=%s", menuTargetName(target));
        return 0;
    }

    item = (BYTE *)findMenuItemByTarget(container, target, &itemIndex);
    if (!item) {
        hookLog("MENU: target=%s not found in container=%p child=%ld", menuTargetName(target),
                (void *)container, (long)childIndex);
        return 0;
    }

    rawContainer = container;
    parent = *(BYTE **)(item + 0x04);
    if (parent && !IsBadReadPtr(parent, 0x48))
        container = parent;

    if (outRawContainer)
        *outRawContainer = rawContainer;
    if (outContainer)
        *outContainer = container;
    if (outItem)
        *outItem = item;
    if (outChildIndex)
        *outChildIndex = childIndex;
    if (outItemIndex)
        *outItemIndex = itemIndex;
    return 1;
}

static int tryContainerMenuTarget(
    LONG target,
    BYTE *container,
    BYTE *item,
    LONG childIndex,
    LONG itemIndex
) {
    BYTE eventBuf[0x28];
    BYTE *dispatchSelf = container;
    DWORD vtable;
    DWORD handler;
    void *eventTarget = item;
    LONG slotIndex = -1;
    LONG wrapperIndex = -1;
    LONG wrapperSubIndex = -1;
    LONG wrapperInnerOffset = -1;

    if (!container || !item || IsBadReadPtr(item, 0x04))
        return 0;
    if (IsBadReadPtr(container, 0x20)) {
        hookLog("MENU2: target=%s child=%ld item=%p index=%ld container=%p root unreadable",
                menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex, (void *)container);
        return 0;
    }

    vtable = *(DWORD *)dispatchSelf;
    if (!isLikelyMenuDispatchSelf(dispatchSelf, item, &vtable, &slotIndex)) {
        BYTE *wrappedObject = findLikelyWrappedMenuDispatchSelf(
            container, item, 3, 0x200, &wrapperIndex, &wrapperSubIndex, &wrapperInnerOffset, &vtable);
        if (wrappedObject) {
            dispatchSelf = wrappedObject;
            slotIndex = findMenuDispatchSlotIndex(dispatchSelf, item);
            hookLog("MENU2: target=%s child=%ld item=%p index=%ld wrapper=%p[%ld,%ld,+0x%lx] -> self=%p vt=0x%08X slot=%ld",
                    menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
                    (void *)container, (long)wrapperIndex, (long)wrapperSubIndex, (long)wrapperInnerOffset,
                    (void *)dispatchSelf, (unsigned)vtable, (long)slotIndex);
        } else {
            BYTE *owner10 = NULL;
            BYTE *screen = NULL;

            hookLog("MENU2: target=%s child=%ld item=%p index=%ld container=%p no dispatch self found",
                    menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex, (void *)container);
            logMenuWrapperSummary("search", container);
            wrappedObject = findLikelyWrappedMenuDispatchSelf(
                item, item, 2, 0x200, &wrapperIndex, &wrapperSubIndex, &wrapperInnerOffset, &vtable);
            if (wrappedObject) {
                dispatchSelf = wrappedObject;
                slotIndex = findMenuDispatchSlotIndex(dispatchSelf, item);
                hookLog("MENU2: target=%s child=%ld item=%p index=%ld item-root[%ld,%ld,+0x%lx] -> self=%p vt=0x%08X slot=%ld",
                        menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
                        (long)wrapperIndex, (long)wrapperSubIndex, (long)wrapperInnerOffset,
                        (void *)dispatchSelf, (unsigned)vtable, (long)slotIndex);
            } else if (!IsBadReadPtr(item + 0x10, sizeof(void *))) {
                owner10 = *(BYTE **)(item + 0x10);
                if (isLikelyHeapPtr((DWORD)(uintptr_t)owner10)) {
                    wrappedObject = findLikelyWrappedMenuDispatchSelf(
                        owner10, item, 2, 0x200, &wrapperIndex, &wrapperSubIndex, &wrapperInnerOffset, &vtable);
                    if (wrappedObject) {
                        dispatchSelf = wrappedObject;
                        slotIndex = findMenuDispatchSlotIndex(dispatchSelf, item);
                        hookLog("MENU2: target=%s child=%ld item=%p index=%ld owner10=%p[%ld,%ld,+0x%lx] -> self=%p vt=0x%08X slot=%ld",
                                menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
                                (void *)owner10, (long)wrapperIndex, (long)wrapperSubIndex, (long)wrapperInnerOffset,
                                (void *)dispatchSelf, (unsigned)vtable, (long)slotIndex);
                    } else if (!IsBadReadPtr(owner10, 0x20)) {
                        hookLog("MENU2: owner10=%p d0=0x%08X d1=0x%08X d2=0x%08X d3=0x%08X",
                                (void *)owner10,
                                (unsigned)*(DWORD *)(owner10 + 0x00),
                                (unsigned)*(DWORD *)(owner10 + 0x04),
                                (unsigned)*(DWORD *)(owner10 + 0x08),
                                (unsigned)*(DWORD *)(owner10 + 0x0C));
                    }
                }
            }

            if (!wrappedObject) {
                screen = (BYTE *)resolveActiveTitleScreen();
                if (isLikelyHeapPtr((DWORD)(uintptr_t)screen) && !IsBadReadPtr(screen, 0x200)) {
                    wrappedObject = findLikelyWrappedMenuDispatchSelf(
                        screen, item, 3, 0x1000, &wrapperIndex, &wrapperSubIndex, &wrapperInnerOffset, &vtable);
                    if (wrappedObject) {
                        dispatchSelf = wrappedObject;
                        slotIndex = findMenuDispatchSlotIndex(dispatchSelf, item);
                        hookLog("MENU2: target=%s child=%ld item=%p index=%ld screen=%p[%ld,%ld,+0x%lx] -> self=%p vt=0x%08X slot=%ld",
                                menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
                                (void *)screen, (long)wrapperIndex, (long)wrapperSubIndex, (long)wrapperInnerOffset,
                                (void *)dispatchSelf, (unsigned)vtable, (long)slotIndex);
                    } else {
                        BYTE *screenOwner = NULL;
                        hookLog("MENU2: screen-root=%p no dispatch self found for target=%s item=%p",
                                (void *)screen, menuTargetName(target), (void *)item);
                        logMenuObjectRefs("screen-scan", screen, 0x900, item, container, owner10);
                        if (!IsBadReadPtr(screen + 0x34, sizeof(void *)))
                            screenOwner = *(BYTE **)(screen + 0x34);
                        if (isLikelyHeapPtr((DWORD)(uintptr_t)screenOwner) && !IsBadReadPtr(screenOwner, 0x100)) {
                            logMenuObjectRefs("screen-owner-scan", screenOwner, 0x600, item, container, owner10);
                        }
                        logMenuObjectRefs("container-scan", container, 0x200, item, container, owner10);
                    }
                }
            }

            if (!wrappedObject) {
                void *globalEventTarget = NULL;

                wrappedObject = findGlobalMenuDispatchSelf(item, &vtable, &slotIndex, &globalEventTarget);
                if (wrappedObject) {
                    dispatchSelf = wrappedObject;
                    eventTarget = globalEventTarget ? globalEventTarget : item;
                    hookLog("MENU2: target=%s child=%ld item=%p index=%ld global-scan -> self=%p vt=0x%08X slot=%ld eventTarget=%p",
                            menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
                            (void *)dispatchSelf, (unsigned)vtable, (long)slotIndex, eventTarget);
                } else {
                    hookLog("MENU2: target=%s child=%ld item=%p index=%ld global scan found no dispatcher",
                            menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex);
                }
            }
        }
    }

    if (slotIndex < 0 && target == MENU_TARGET_SINGLE_PLAYER) {
        void *slot0 = NULL;
        if (!IsBadReadPtr(dispatchSelf + 0xEC, sizeof(void *)))
            slot0 = *(void **)(dispatchSelf + 0xEC);
        if (slot0 && !IsBadReadPtr(slot0, sizeof(void *))) {
            eventTarget = slot0;
            slotIndex = 0;
        }
    }

    LONG handlerOffset = menuDispatchHandlerOffset(vtable);

    if (!vtable || handlerOffset < 0 ||
        IsBadReadPtr((void *)vtable, handlerOffset + sizeof(DWORD))) {
        hookLog("MENU2: target=%s child=%ld item=%p index=%ld container=%p self=%p bad vtable=0x%08X",
                menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
                (void *)container, (void *)dispatchSelf, (unsigned)vtable);
        logMenuWrapperSummary("badvt", container);
        return 0;
    }

    handler = *(DWORD *)(vtable + handlerOffset);
    if (!handler || handler == 0x00401670 || IsBadReadPtr((void *)handler, 1)) {
        hookLog("MENU2: target=%s child=%ld item=%p index=%ld container=%p self=%p vt=0x%08X handler=0x%08X invalid",
                menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
                (void *)container, (void *)dispatchSelf, (unsigned)vtable, (unsigned)handler);
        logMenuWrapperSummary("invalid", container);
        return 0;
    }

    memset(eventBuf, 0, sizeof(eventBuf));
    *(DWORD *)(eventBuf + 0x10) = 2;
    *(DWORD *)(eventBuf + 0x18) = 0;
    *(BYTE *)(eventBuf + 0x1C) = 1;
    *(void **)(eventBuf + 0x20) = eventTarget;

    hookLog("MENU2: target=%s child=%ld item=%p index=%ld container=%p self=%p slot=%ld eventTarget=%p vt=0x%08X handler=0x%08X",
            menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
            (void *)container, (void *)dispatchSelf, (long)slotIndex, eventTarget, (unsigned)vtable, (unsigned)handler);

    ((MenuContainerEvent_t)handler)(dispatchSelf, eventBuf);

    hookLog("MENU2: target=%s post state440=%ld state444=%ld state448=%p",
            menuTargetName(target),
            !IsBadReadPtr(dispatchSelf + 0x440, sizeof(LONG)) ? (long)*(LONG *)(dispatchSelf + 0x440) : -1,
            !IsBadReadPtr(dispatchSelf + 0x444, sizeof(LONG)) ? (long)*(LONG *)(dispatchSelf + 0x444) : -1,
            !IsBadReadPtr(dispatchSelf + 0x448, sizeof(void *)) ? *(void **)(dispatchSelf + 0x448) : NULL);
    return 1;
}

static int tryDispatchMenuTarget(LONG target, int phase) {
    MenuSelectItem_t selectItem = (MenuSelectItem_t)0x5311D0;
    MenuWrapperItem_t clickItem = (MenuWrapperItem_t)0x55A460;
    BYTE *rawContainer;
    BYTE *container;
    BYTE *item;
    LONG childIndex = -1;
    LONG itemIndex = -1;
    int wrapperGate;
    int actionSubtype;
    int armedFlag;
    unsigned char selectResult = 0;
    unsigned char clickResult = 0;
    LONG actionType;
    LONG stageBase = (phase == 0) ? 100 : 200;

    g_menuClickStage = stageBase + 1;

    if (!resolveMenuTargetEntry(target, &rawContainer, &container, &item, &childIndex, &itemIndex))
        return 0;

    g_menuClickStage = stageBase + 2;
    actionType = *(LONG *)(item + 0x30);
    hookLog("MENU: target=%s child=%ld item=%p index=%ld raw=%p container=%p actionType=%ld",
            menuTargetName(target), (long)childIndex, (void *)item, (long)itemIndex,
            (void *)rawContainer, (void *)container,
            (long)actionType);
    hookLog("MENUITEM: item=%p vt=0x%08X parent=%p p08=%p p0c=%p p10=%p p14=%p p18=0x%08X p1c=0x%08X p34=%p payload=%p",
            (void *)item,
            !IsBadReadPtr(item, sizeof(DWORD)) ? (unsigned)*(DWORD *)item : 0,
            !IsBadReadPtr(item + 0x04, sizeof(void *)) ? *(void **)(item + 0x04) : NULL,
            !IsBadReadPtr(item + 0x08, sizeof(void *)) ? *(void **)(item + 0x08) : NULL,
            !IsBadReadPtr(item + 0x0C, sizeof(void *)) ? *(void **)(item + 0x0C) : NULL,
            !IsBadReadPtr(item + 0x10, sizeof(void *)) ? *(void **)(item + 0x10) : NULL,
            !IsBadReadPtr(item + 0x14, sizeof(void *)) ? *(void **)(item + 0x14) : NULL,
            !IsBadReadPtr(item + 0x18, sizeof(DWORD)) ? (unsigned)*(DWORD *)(item + 0x18) : 0,
            !IsBadReadPtr(item + 0x1C, sizeof(DWORD)) ? (unsigned)*(DWORD *)(item + 0x1C) : 0,
            !IsBadReadPtr(item + 0x34, sizeof(void *)) ? *(void **)(item + 0x34) : NULL,
            !IsBadReadPtr(item + 0x38, sizeof(void *)) ? *(void **)(item + 0x38) : NULL);

    if (actionType == 1) {
        if (phase == 0) {
            g_menuClickStage = stageBase + 3;
            int ok = tryContainerMenuTarget(target, rawContainer ? rawContainer : container, item, childIndex, itemIndex);
            g_menuClickUsedContainerPath = ok ? 1 : 0;
            if (ok) {
                g_menuClickStage = stageBase + 4;
                hookLog("MENU2: target=%s phase=%d dispatched via container path",
                        menuTargetName(target), phase);
                return 1;
            }
            g_menuClickStage = stageBase + 5;
            hookLog("MENU2: target=%s phase=%d container path unavailable, falling back to wrapper",
                    menuTargetName(target), phase);
        } else if (g_menuClickUsedContainerPath) {
            g_menuClickUsedContainerPath = 0;
            g_menuClickStage = stageBase + 4;
            hookLog("MENU2: target=%s phase=%d skipping synthetic release after container dispatch",
                    menuTargetName(target), phase);
            return 1;
        }
    }

    /* Mirror the internal focus path first, then use the item's higher-level wrapper with
     * the same engage/release contract the extracted binary uses:
     * - phase 0 (down): enter the wrapper's active path and arm the queue record.
     * - phase 1 (up): take the wrapper's release/reset branch. */
    wrapperGate = (phase == 0) ? 1 : 0;
    actionSubtype = 0;
    armedFlag = (phase == 0) ? 1 : 0;

    g_menuClickStage = stageBase + 6;
    if (container)
        selectResult = selectItem(container, item);
    g_menuClickStage = stageBase + 7;
    hookLog("MENU: target=%s phase=%d pre-wrapper gate=%d subtype=%d armed=%d",
            menuTargetName(target), phase, wrapperGate, actionSubtype, armedFlag);
    clickResult = clickItem(item, wrapperGate, actionSubtype, armedFlag, NULL, 0);
    g_menuClickStage = stageBase + 8;

    hookLog("MENU: dispatched target=%s phase=%d gate=%d subtype=%d armed=%d select=%u click=%u hover=%ld active=%ld",
            menuTargetName(target),
            phase,
            wrapperGate,
            actionSubtype,
            armedFlag,
            (unsigned)selectResult,
            (unsigned)clickResult,
            container && !IsBadReadPtr(container + 0x40, 8) ? (long)*(LONG *)(container + 0x40) : -999,
            container && !IsBadReadPtr(container + 0x44, 8) ? (long)*(LONG *)(container + 0x44) : -999);
    g_menuClickStage = stageBase + 9;
    return 1;
}

static int tryWrapperMenuTarget(
    LONG target,
    LONG arg1,
    LONG arg2,
    LONG arg3,
    LONG arg5,
    LONG usePayload,
    LONG forceClear18,
    LONG forceClear2C,
    LONG arg5FromItem24
) {
    MenuSelectItem_t selectItem = (MenuSelectItem_t)0x5311D0;
    MenuWrapperItem_t wrapItem = (MenuWrapperItem_t)0x55A460;
    BYTE *rawContainer;
    BYTE *container;
    BYTE *item;
    void *context = NULL;
    void *payload = NULL;
    DWORD vtable = 0;
    DWORD handler54 = 0;
    DWORD handler64 = 0;
    LONG resolvedArg5 = arg5;
    LONG childIndex = -1;
    LONG itemIndex = -1;
    unsigned char selectResult = 0;
    unsigned char wrapResult;

    if (!resolveMenuTargetEntry(target, &rawContainer, &container, &item, &childIndex, &itemIndex))
        return 0;

    payload = *(void **)(item + 0x38);
    if (usePayload) {
        context = payload;
        if (!context) {
            hookLog("MENUWRAP: target=%s item=%p requested payload context but payload is null",
                    menuTargetName(target), (void *)item);
            return 0;
        }
    }

    if (forceClear18 && *(BYTE *)(item + 0x18) != 0) {
        hookLog("MENUWRAP: clearing item+0x18 gate on item=%p (was %u)",
                (void *)item, (unsigned)*(BYTE *)(item + 0x18));
        *(BYTE *)(item + 0x18) = 0;
    }

    if (container)
        selectResult = selectItem(container, item);

    if (forceClear2C && *(BYTE *)(item + 0x2C) != 0) {
        hookLog("MENUWRAP: clearing item+0x2C gate on item=%p (was %u)",
                (void *)item, (unsigned)*(BYTE *)(item + 0x2C));
        *(BYTE *)(item + 0x2C) = 0;
    }

    if (arg5FromItem24) {
        resolvedArg5 = *(LONG *)(item + 0x24);
    }

    if (!IsBadReadPtr(item, sizeof(DWORD))) {
        vtable = *(DWORD *)item;
        if (vtable && !IsBadReadPtr((void *)vtable, 0x68)) {
            handler54 = *(DWORD *)(vtable + 0x54);
            handler64 = *(DWORD *)(vtable + 0x64);
        }
    }

    hookLog("MENUWRAP: target=%s child=%ld item=%p vt=0x%08X h54=0x%08X h64=0x%08X index=%ld actionType=%ld flag18=%u flag2c=%u item24=0x%08X d8=%ld c4[0]=0x%08X c4[1]=0x%08X c4[2]=0x%08X slot34=%p payload=%p a1=%ld a2=%ld a3=%ld a4=%p a5=%ld",
            menuTargetName(target),
            (long)childIndex,
            (void *)item,
            (unsigned)vtable,
            (unsigned)handler54,
            (unsigned)handler64,
            (long)itemIndex,
            (long)*(LONG *)(item + 0x30),
            (unsigned)*(BYTE *)(item + 0x18),
            (unsigned)*(BYTE *)(item + 0x2C),
            (unsigned)*(DWORD *)(item + 0x24),
            !IsBadReadPtr(item + 0xD8, sizeof(LONG)) ? (long)*(LONG *)(item + 0xD8) : -1,
            !IsBadReadPtr(item + 0xC4, sizeof(DWORD)) ? (unsigned)*(DWORD *)(item + 0xC4) : 0,
            !IsBadReadPtr(item + 0xC8, sizeof(DWORD)) ? (unsigned)*(DWORD *)(item + 0xC8) : 0,
            !IsBadReadPtr(item + 0xCC, sizeof(DWORD)) ? (unsigned)*(DWORD *)(item + 0xCC) : 0,
            *(void **)(item + 0x34),
            payload,
            (long)arg1,
            (long)arg2,
            (long)arg3,
            context,
            (long)resolvedArg5);
    logMenuAppState("wrap-before");
    logMenuQueueState("wrap-before");

    wrapResult = wrapItem(item, (int)arg1, (int)arg2, (int)arg3, context, (int)resolvedArg5);

    hookLog("MENUWRAP: select=%u result=%u hover=%ld active=%ld post18=%u post2c=%u",
            (unsigned)selectResult,
            (unsigned)wrapResult,
            container && !IsBadReadPtr(container + 0x40, 8) ? (long)*(LONG *)(container + 0x40) : -999,
            container && !IsBadReadPtr(container + 0x44, 8) ? (long)*(LONG *)(container + 0x44) : -999,
            (unsigned)*(BYTE *)(item + 0x18),
            (unsigned)*(BYTE *)(item + 0x2C));
    logMenuAppState("wrap-after");
    logMenuQueueState("wrap-after");
    return 1;
}

static int tryFlushMenuTarget(LONG target) {
    BYTE *rawContainer;
    BYTE *container;
    BYTE *item;
    DWORD vtable = 0;
    DWORD handler = 0;
    LONG childIndex = -1;
    LONG itemIndex = -1;

    if (!resolveMenuTargetEntry(target, &rawContainer, &container, &item, &childIndex, &itemIndex))
        return 0;

    if (IsBadReadPtr(item, sizeof(DWORD))) {
        hookLog("MENUFLUSH: target=%s item unreadable", menuTargetName(target));
        return 0;
    }

    vtable = *(DWORD *)item;
    if (!vtable || IsBadReadPtr((void *)vtable, 0x14)) {
        hookLog("MENUFLUSH: target=%s item=%p bad vtable=0x%08X",
                menuTargetName(target), (void *)item, (unsigned)vtable);
        return 0;
    }

    handler = *(DWORD *)(vtable + 0x10);
    if (!handler || IsBadReadPtr((void *)handler, 1)) {
        hookLog("MENUFLUSH: target=%s item=%p invalid handler=0x%08X",
                menuTargetName(target), (void *)item, (unsigned)handler);
        return 0;
    }

    hookLog("MENUFLUSH: target=%s child=%ld item=%p vt=0x%08X flush=0x%08X pre2c=%u pre1c=0x%08X",
            menuTargetName(target), (long)childIndex, (void *)item,
            (unsigned)vtable, (unsigned)handler,
            (unsigned)*(BYTE *)(item + 0x2C),
            (unsigned)*(DWORD *)(item + 0x1C));
    logMenuAppState("flush-before");
    logMenuQueueState("flush-before");

    ((MenuItemFlush_t)handler)(item);

    hookLog("MENUFLUSH: target=%s post2c=%u post1c=0x%08X",
            menuTargetName(target),
            (unsigned)*(BYTE *)(item + 0x2C),
            (unsigned)*(DWORD *)(item + 0x1C));
    logMenuAppState("flush-after");
    logMenuQueueState("flush-after");
    return 1;
}

static int tryItemKeyMenuTarget(
    LONG target,
    LONG arg1,
    LONG arg2,
    LONG arg3,
    LONG autoFlush
) {
    BYTE *rawContainer;
    BYTE *container;
    BYTE *item;
    DWORD vtable = 0;
    DWORD handler = 0;
    LONG childIndex = -1;
    LONG itemIndex = -1;
    unsigned char result = 0;

    if (!resolveMenuTargetEntry(target, &rawContainer, &container, &item, &childIndex, &itemIndex))
        return 0;

    if (IsBadReadPtr(item, sizeof(DWORD))) {
        hookLog("MENUITEMKEY: target=%s item unreadable", menuTargetName(target));
        return 0;
    }

    vtable = *(DWORD *)item;
    if (!vtable || IsBadReadPtr((void *)vtable, 0x44)) {
        hookLog("MENUITEMKEY: target=%s item=%p bad vtable=0x%08X",
                menuTargetName(target), (void *)item, (unsigned)vtable);
        return 0;
    }

    handler = *(DWORD *)(vtable + 0x40);
    if (!handler || IsBadReadPtr((void *)handler, 1)) {
        hookLog("MENUITEMKEY: target=%s item=%p invalid handler=0x%08X",
                menuTargetName(target), (void *)item, (unsigned)handler);
        return 0;
    }

    hookLog("MENUITEMKEY: target=%s child=%ld item=%p vt=0x%08X key=0x%08X a1=%ld a2=%ld a3=%ld flush=%ld flag15=%u flag18=%u flag20=%u owner10=%p",
            menuTargetName(target), (long)childIndex, (void *)item,
            (unsigned)vtable, (unsigned)handler,
            (long)arg1, (long)arg2, (long)arg3, (long)autoFlush,
            (unsigned)*(BYTE *)(item + 0x15),
            (unsigned)*(BYTE *)(item + 0x18),
            (unsigned)*(BYTE *)(item + 0x20),
            *(void **)(item + 0x10));
    logMenuAppState("itemkey-before");
    logMenuQueueState("itemkey-before");

    result = ((MenuItemKey_t)handler)(item, (int)arg1, (int)arg2, (int)arg3);

    hookLog("MENUITEMKEY: target=%s result=%u post2c=%u post1c=0x%08X",
            menuTargetName(target),
            (unsigned)result,
            (unsigned)*(BYTE *)(item + 0x2C),
            (unsigned)*(DWORD *)(item + 0x1C));
    logMenuAppState("itemkey-after");
    logMenuQueueState("itemkey-after");

    if (autoFlush)
        return tryFlushMenuTarget(target);

    return 1;
}

static int tryDirectMenuTarget(LONG target, LONG mode, LONG pumpCount) {
    MenuSelectItem_t selectItem = (MenuSelectItem_t)0x5311D0;
    MenuCase2Item_t case2Item = (MenuCase2Item_t)0x4D6A40;
    MenuCase3Item_t case3Item = (MenuCase3Item_t)0x4D69D0;
    MenuCase4Item_t case4Item = (MenuCase4Item_t)0x4D5D00;
    BYTE *rawContainer;
    BYTE *container;
    BYTE *item;
    void *payload;
    LONG childIndex = -1;
    LONG itemIndex = -1;

    if (!resolveMenuTargetEntry(target, &rawContainer, &container, &item, &childIndex, &itemIndex))
        return 0;

    payload = *(void **)(item + 0x38);
    if (!payload) {
        hookLog("MENUDIRECT: target=%s mode=%s item=%p has null payload",
                menuTargetName(target), menuDirectModeName(mode), (void *)item);
        return 0;
    }

    if (container)
        selectItem(container, item);

    hookLog("MENUDIRECT: target=%s mode=%s pump=%ld child=%ld item=%p index=%ld payload=%p actionType=%ld",
            menuTargetName(target), menuDirectModeName(mode), (long)pumpCount, (long)childIndex, (void *)item,
            (long)itemIndex, payload, (long)*(LONG *)(item + 0x30));
    logMenuAppState("before");

    switch (mode) {
    case MENUDIRECT_CASE2:
        case2Item((void *)0x818718, payload, 1);
        break;
    case MENUDIRECT_CASE3:
        case3Item((void *)0x818718, payload);
        break;
    case MENUDIRECT_CASE4:
        case4Item((void *)0x818718, 0);
        break;
    case MENUDIRECT_COMBO:
        case3Item((void *)0x818718, payload);
        case2Item((void *)0x818718, payload, 1);
        case4Item((void *)0x818718, 0);
        break;
    default:
        hookLog("MENUDIRECT: unknown mode=%ld target=%s", (long)mode, menuTargetName(target));
        return 0;
    }

    logMenuAppState("after-set");
    if (pumpCount > 0)
        pumpMenuApp("direct", pumpCount);
    logMenuAppState("after");
    return 1;
}

static int tryMainMenuTarget(LONG target, LONG mode, LONG pumpCount) {
    FindNamedObject_t findNamedObject = (FindNamedObject_t)0x4D6900;
    MenuSelectItem_t selectItem = (MenuSelectItem_t)0x5311D0;
    MenuControllerDispatch_t controllerDispatch = (MenuControllerDispatch_t)0x531250;
    MainMenuProcessMessage_t processMessage = (MainMenuProcessMessage_t)0x4E3520;
    MainMenuCallback_t callback = (MainMenuCallback_t)(uintptr_t)mainMenuCallbackAddress(target);
    MainMenuCallback_t managerPump = (MainMenuCallback_t)0x4E3C10;
    MainMenuTick_t postPumpTick = (MainMenuTick_t)0x4E34E0;
    BYTE *rawContainer;
    BYTE *container;
    BYTE *item;
    BYTE *mainMenu;
    BYTE *manager;
    BYTE *controller = NULL;
    BYTE *itemToken = NULL;
    BYTE *payload = NULL;
    BYTE *owner10 = NULL;
    const char *itemTokenName = NULL;
    const char *payloadName = NULL;
    const char *owner10Name = NULL;
    const char *targetTokenName = mainMenuTokenName(target);
    LONG childIndex = -1;
    LONG itemIndex = -1;
    LONG i;
    struct {
        DWORD unk0;
        DWORD unk4;
        const char *name;
    } fakeToken = { 0, 0, NULL };
    BYTE eventBuf[0x28];
    void *eventTarget = NULL;

    if (!targetTokenName) {
        hookLog("MAINMENU: target=%s has no token mapping", menuTargetName(target));
        return 0;
    }

    if (!resolveMenuTargetEntry(target, &rawContainer, &container, &item, &childIndex, &itemIndex))
        return 0;

    mainMenu = (BYTE *)findNamedObject((void *)0x818718, "MainMenu");
    manager = (BYTE *)findNamedObject((void *)0x818718, "MainMenuManager");
    if ((!mainMenu || IsBadReadPtr(mainMenu, 0xF4)) &&
        manager && !IsBadReadPtr(manager, sizeof(DWORD)) &&
        *(DWORD *)manager == 0x005D4078) {
        mainMenu = manager;
    }

    if ((!mainMenu || IsBadReadPtr(mainMenu, 0xF4)) &&
        (mode == MENUDIRECT_MAINMSG || mode == MENUDIRECT_MAINCOMBO || mode == MENUDIRECT_MAINSCAN)) {
        hookLog("MAINMENU: target=%s main menu object missing for processMessage", menuTargetName(target));
        if (mode == MENUDIRECT_MAINMSG)
            return 0;
    }

    if (manager && !IsBadReadPtr(manager + 0x04, sizeof(void *)))
        controller = *(BYTE **)(manager + 0x04);

    if (!IsBadReadPtr(item + 0x08, sizeof(void *)))
        itemToken = *(BYTE **)(item + 0x08);
    if (!IsBadReadPtr(item + 0x10, sizeof(void *)))
        owner10 = *(BYTE **)(item + 0x10);
    if (!IsBadReadPtr(item + 0x38, sizeof(void *)))
        payload = *(BYTE **)(item + 0x38);

    itemTokenName = tryReadNamedObjectToken(itemToken);
    payloadName = tryReadNamedObjectToken(payload);
    owner10Name = tryReadNamedObjectToken(owner10);

    fakeToken.name = targetTokenName;
    eventTarget = (itemTokenName && _stricmp(itemTokenName, targetTokenName) == 0)
        ? (void *)itemToken
        : (void *)&fakeToken;

    memset(eventBuf, 0, sizeof(eventBuf));
    *(DWORD *)(eventBuf + 0x10) = 2;
    *(DWORD *)(eventBuf + 0x18) = 0;
    *(BYTE *)(eventBuf + 0x1C) = 1;
    *(void **)(eventBuf + 0x20) = eventTarget;

    hookLog("MAINMENU: target=%s mode=%s child=%ld item=%p index=%ld raw=%p container=%p menu=%p mgr=%p item08=%p token=%s payload=%p payloadToken=%s owner10=%p ownerToken=%s eventTarget=%p eventToken=%s cb=0x%08X",
            menuTargetName(target),
            menuDirectModeName(mode),
            (long)childIndex,
            (void *)item,
            (long)itemIndex,
            (void *)rawContainer,
            (void *)container,
            (void *)mainMenu,
            (void *)manager,
            (void *)itemToken,
            itemTokenName ? itemTokenName : "<null>",
            (void *)payload,
            payloadName ? payloadName : "<null>",
            (void *)owner10,
            owner10Name ? owner10Name : "<null>",
            eventTarget,
            targetTokenName,
            (unsigned)(uintptr_t)mainMenuCallbackAddress(target));
    logMainMenuState("before");
    logMenuAppState("main-before");
    logMenuQueueState("main-before");

    if (container && !IsBadReadPtr(container, 0x10) && item && !IsBadReadPtr(item, 0x3C)) {
        selectItem(container, item);
        hookLog("MAINMENU: selectItem target=%s container=%p item=%p completed",
                menuTargetName(target), (void *)container, (void *)item);
        logMainMenuState("after-select");
    }

    if ((mode == MENUDIRECT_MAINMSG || mode == MENUDIRECT_MAINCOMBO ||
         mode == MENUDIRECT_MAINSCAN || mode == MENUDIRECT_MAINFLOW) &&
        mainMenu && !IsBadReadPtr(mainMenu, 0xF4)) {
        processMessage(mainMenu, eventBuf);
        hookLog("MAINMENU: processMessage target=%s completed", menuTargetName(target));
        logMainMenuState("after-msg");
        logMenuQueueState("after-msg");
    }

    if (mode == MENUDIRECT_MAINSCAN) {
        LONG action;
        LONG flags;
        int changeCount = 0;

        if (!controller || IsBadReadPtr(controller, 0xD00)) {
            hookLog("MAINSCAN: target=%s controller missing/unreadable", menuTargetName(target));
            return 0;
        }

        for (action = 0; action <= 6; action++) {
            for (flags = 0; flags <= 7; flags++) {
                LONG queueHeadBefore = *(LONG *)0x8AA4EC;
                LONG freeHeadBefore = *(LONG *)0x8AA4E8;
                BYTE f4Before = *(BYTE *)(manager + 0xF4);
                LONG f8Before = *(LONG *)(manager + 0xF8);
                BYTE fcBefore = *(BYTE *)(manager + 0xFC);

                controllerDispatch(controller, action, flags);

                if (queueHeadBefore != *(LONG *)0x8AA4EC ||
                    freeHeadBefore != *(LONG *)0x8AA4E8 ||
                    f4Before != *(BYTE *)(manager + 0xF4) ||
                    f8Before != *(LONG *)(manager + 0xF8) ||
                    fcBefore != *(BYTE *)(manager + 0xFC)) {
                    changeCount++;
                    hookLog("MAINSCAN: hit#%d action=%ld flags=%ld queueHead %ld->%ld freeHead %ld->%ld f4 %u->%u f8 %ld->%ld fc %u->%u",
                            changeCount,
                            (long)action,
                            (long)flags,
                            (long)queueHeadBefore,
                            (long)*(LONG *)0x8AA4EC,
                            (long)freeHeadBefore,
                            (long)*(LONG *)0x8AA4E8,
                            (unsigned)f4Before,
                            (unsigned)*(BYTE *)(manager + 0xF4),
                            (long)f8Before,
                            (long)*(LONG *)(manager + 0xF8),
                            (unsigned)fcBefore,
                            (unsigned)*(BYTE *)(manager + 0xFC));
                    logMenuQueueState("scan-hit");
                    logMainMenuState("scan-hit");
                    logMenuAppState("scan-hit");
                }
            }
        }

        if (!changeCount)
            hookLog("MAINSCAN: target=%s no queue/state change across action=0..6 flags=0..7",
                    menuTargetName(target));
        else
            hookLog("MAINSCAN: target=%s total-changing-combos=%d",
                    menuTargetName(target), changeCount);
    }

    if ((mode == MENUDIRECT_MAINCB || mode == MENUDIRECT_MAINCOMBO ||
         mode == MENUDIRECT_MAINFLOW) && callback) {
        callback(eventTarget, NULL);
        hookLog("MAINMENU: callback target=%s completed", menuTargetName(target));
        logMainMenuState("after-cb");
        logMenuQueueState("after-cb");
    }

    for (i = 0; i < pumpCount; i++) {
        managerPump(manager ? manager : mainMenu, NULL);
        hookLog("MAINMENU: manager pump %ld/%ld target=%s", (long)(i + 1), (long)pumpCount, menuTargetName(target));
        logMainMenuState("after-pump");
        logMenuQueueState("after-pump");

        if (mode == MENUDIRECT_MAINFLOW && postPumpTick) {
            postPumpTick(manager ? (void *)manager : (void *)mainMenu);
            hookLog("MAINMENU: post pump tick %ld/%ld target=%s", (long)(i + 1), (long)pumpCount, menuTargetName(target));
            logMainMenuState("after-post");
            logMenuQueueState("after-post");
        }
    }

    logMenuAppState("main-after");
    return 1;
}

/* Force frame pointer so we can walk the frame chain to find caller's EBP.
 * The game stores CInputDevice 'this' in EBP (via MOV EBP, ECX at 0x4D36CB).
 * EBP is callee-saved across stdcall COM calls. With frame pointer enabled,
 * [EBP+0] in our function = saved caller's EBP = CInputDevice this. */
__attribute__((optimize("no-omit-frame-pointer")))
static HRESULT WINAPI hookedMouseGetDeviceData(
    LPDIRECTINPUTDEVICEA self, DWORD cbObjectData,
    LPDIDEVICEOBJECTDATA rgdod, LPDWORD pdwInOut, DWORD dwFlags
) {
    /* Capture caller's EBP FIRST (before any function calls that might clobber).
     * With frame pointer: our EBP points to stack frame, [EBP+0] = saved old EBP. */
    {
        DWORD callerEbp;
        __asm__ volatile ("movl 0(%%ebp), %0" : "=r"(callerEbp));
        g_callerEBP = callerEbp;
    }

    /* Capture return address to find the game code calling GetDeviceData */
    g_lastGddRetAddr = (DWORD)(uintptr_t)__builtin_return_address(0);

    /* Save buffer capacity BEFORE calling original (it overwrites pdwInOut) */
    DWORD savedCapacity = (pdwInOut && rgdod) ? *pdwInOut : 0;

    HRESULT hr = g_origMouseGetDeviceData(self, cbObjectData, rgdod, pdwInOut, dwFlags);

    /* Auto-reacquire on ANY failure HRESULT from GetDeviceData.
     * This handles: DIERR_NOTACQUIRED (0x8007001C), DIERR_INPUTLOST (0x8007001E),
     * 0x8007000C (device lost/not-enough-memory), and other error codes that occur
     * when game window doesn't have foreground focus (DISCL_FOREGROUND mode). */
    if (FAILED(hr)) {
        static LONG reacqCount = 0;
        LONG rc = InterlockedIncrement(&reacqCount);
        InterlockedIncrement(&g_reacqTotal);
        HRESULT acqHr = self->lpVtbl->Acquire(self);
        if (rc <= 10 || (rc % 500 == 0))
            hookLog("Auto-reacquire: GDD hr=0x%08X, Acquire()=0x%08X (attempt #%ld)",
                    (unsigned)hr, (unsigned)acqHr, rc);
        if (SUCCEEDED(acqHr) || acqHr == DI_NOEFFECT /* already acquired */) {
            /* Retry GetDeviceData after successful reacquisition */
            if (pdwInOut) *pdwInOut = savedCapacity;
            hr = g_origMouseGetDeviceData(self, cbObjectData, rgdod, pdwInOut, dwFlags);
            if (rc <= 10 || (rc % 500 == 0))
                hookLog("Auto-reacquire: retry GetDeviceData hr=0x%08X events=%lu",
                        (unsigned)hr, pdwInOut ? (unsigned long)*pdwInOut : 0);
            if (SUCCEEDED(acqHr))
                reacqCount = 0;  /* Reset counter on success */
        }
    }

    LONG count = InterlockedIncrement(&g_getDeviceDataCallCount);
    DWORD realEvents = pdwInOut ? *pdwInOut : 0;
    g_lastGddHr = hr;
    g_lastGddRealEvents = realEvents;

    /* Log periodically and when events arrive */
    if (count == 1 || (count % 1000 == 0) || realEvents > 0) {
        hookLog("GetDeviceData #%ld: events=%lu cbObj=%lu cap=%lu hr=0x%08X",
                count, (unsigned long)realEvents, (unsigned long)cbObjectData,
                (unsigned long)savedCapacity, (unsigned)hr);
        if (realEvents > 0 && rgdod && cbObjectData >= DINPUT7_OBJECTDATA_SIZE) {
            for (DWORD i = 0; i < realEvents && i < 4; i++) {
                BYTE *ev = (BYTE *)rgdod + (i * cbObjectData);
                hookLog("  real[%lu]: ofs=%lu data=%ld", (unsigned long)i,
                        (unsigned long)*(DWORD*)(ev+0), (long)(int)*(DWORD*)(ev+4));
            }
        }
    }

    if (g_menuTraceRemaining > 0) {
        logMenuAppState("tick");
        logMainMenuState("tick");
        InterlockedDecrement(&g_menuTraceRemaining);
    }

    processPendingUiWork("gdd");

    if (g_menuDirectMode != MENUDIRECT_NONE) {
        LONG target = g_menuDirectTarget;
        LONG mode = g_menuDirectMode;
        LONG pumpCount = g_menuDirectPumpCount;
        int ok;
        if (mode == MENUDIRECT_MAINMSG || mode == MENUDIRECT_MAINCB ||
            mode == MENUDIRECT_MAINCOMBO || mode == MENUDIRECT_MAINSCAN ||
            mode == MENUDIRECT_MAINFLOW)
            ok = tryMainMenuTarget(target, mode, pumpCount);
        else
            ok = tryDirectMenuTarget(target, mode, pumpCount);
        g_menuDirectMode = MENUDIRECT_NONE;
        g_menuDirectPumpCount = 0;
        g_menuTraceRemaining = 6;
        hookLog("MENUDIRECT: target=%s mode=%s pump=%ld %s",
                menuTargetName(target), menuDirectModeName(mode), (long)pumpCount,
                ok ? "completed" : "failed");
    }

    if (g_menuWrapPending) {
        LONG target = g_menuWrapTarget;
        LONG arg1 = g_menuWrapArg1;
        LONG arg2 = g_menuWrapArg2;
        LONG arg3 = g_menuWrapArg3;
        LONG arg5 = g_menuWrapArg5;
        LONG usePayload = g_menuWrapUsePayload;
        LONG forceClear18 = g_menuWrapForceClear18;
        LONG forceClear2C = g_menuWrapForceClear2C;
        LONG arg5FromItem24 = g_menuWrapArg5FromItem24;
        LONG autoFlush = g_menuWrapAutoFlush;
        int ok = tryWrapperMenuTarget(target, arg1, arg2, arg3, arg5, usePayload, forceClear18, forceClear2C, arg5FromItem24);
        if (ok && autoFlush)
            ok = tryFlushMenuTarget(target);
        g_menuWrapPending = 0;
        g_menuTraceRemaining = 6;
        hookLog("MENUWRAP: target=%s a1=%ld a2=%ld a3=%ld a5=%ld payload=%ld clear18=%ld clear2c=%ld a5item24=%ld flush=%ld %s",
                menuTargetName(target),
                (long)arg1,
                (long)arg2,
                (long)arg3,
                (long)arg5,
                (long)usePayload,
                (long)forceClear18,
                (long)forceClear2C,
                (long)arg5FromItem24,
                (long)autoFlush,
                ok ? "completed" : "failed");
    }

    if (g_menuItemKeyPending) {
        LONG target = g_menuItemKeyTarget;
        LONG arg1 = g_menuItemKeyArg1;
        LONG arg2 = g_menuItemKeyArg2;
        LONG arg3 = g_menuItemKeyArg3;
        LONG autoFlush = g_menuItemKeyAutoFlush;
        int ok = tryItemKeyMenuTarget(target, arg1, arg2, arg3, autoFlush);
        g_menuItemKeyPending = 0;
        g_menuTraceRemaining = 6;
        hookLog("MENUITEMKEY: target=%s a1=%ld a2=%ld a3=%ld flush=%ld %s",
                menuTargetName(target),
                (long)arg1,
                (long)arg2,
                (long)arg3,
                (long)autoFlush,
                ok ? "completed" : "failed");
    }

    if (g_menuItemFlushPending) {
        LONG target = g_menuItemFlushTarget;
        int ok = tryFlushMenuTarget(target);
        g_menuItemFlushPending = 0;
        g_menuTraceRemaining = 6;
        hookLog("MENUFLUSH: target=%s %s",
                menuTargetName(target),
                ok ? "completed" : "failed");
    }

    if (g_menuClickState == MENUCLICK_PENDING_DOWN) {
        LONG target = g_menuClickTarget;
        g_menuClickStage = 10;
        int ok = tryDispatchMenuTarget(target, 0);
        g_menuClickState = ok ? MENUCLICK_PENDING_UP : MENUCLICK_DONE;
        g_menuClickStage = ok ? 11 : 12;
        g_menuTraceRemaining = 6;
        hookLog("MENU: menuclick target=%s down %s",
                menuTargetName(target), ok ? "completed" : "failed");
    } else if (g_menuClickState == MENUCLICK_PENDING_UP) {
        LONG target = g_menuClickTarget;
        g_menuClickStage = 20;
        int ok = tryDispatchMenuTarget(target, 1);
        g_menuClickState = MENUCLICK_DONE;
        g_menuClickStage = ok ? 21 : 22;
        g_menuTraceRemaining = 6;
        hookLog("MENU: menuclick target=%s up %s",
                menuTargetName(target), ok ? "completed" : "failed");
    }

    if (g_menuWatchPendingCommand != 0) {
        LONG cmd = g_menuWatchPendingCommand;
        LONG hits = g_menuWatchPendingHits;

        g_menuWatchPendingCommand = 0;
        if (cmd < 0) {
            disarmMenuWatchpoint("manual");
        } else {
            int ok = (cmd == MENUWATCH_TARGET_PENDING)
                ? armScreenPendingWatchpoint(hits)
                : armMenuWatchpoint(hits);
            hookLog("MENUWATCH: arm target=%s hits=%ld %s",
                    menuWatchTargetName(cmd == MENUWATCH_TARGET_PENDING
                                        ? MENUWATCH_TARGET_PENDING
                                        : MENUWATCH_TARGET_MANAGER),
                    (long)clampMenuWatchHits(hits),
                    ok ? "completed" : "failed");
        }
    }

    /* --- v7 injection: OPTIMIZED 3-call state machine ---
     *
     * v6 bug: packed reset(-100000) + move(+400) in the SAME buffer.
     * Games accumulate all X deltas per GetDeviceData call, then clamp:
     *   total_dx = -100000 + 400 = -99600 → clamped to 0 (move lost!)
     *
     * v7 fix: split into SEPARATE GetDeviceData calls, minimizing total calls.
     * GetDeviceData is only called every ~7.5s (no event notification), so
     * each call costs real time. Optimized to just 3 calls:
     *   Call 1 (RESET):   [X=-10000, Y=-10000]           → slam to (0,0)
     *   Call 2 (CLICK):   [X=target, Y=target, btn_down] → move + press
     *   Call 3 (RELEASE): [btn_up]                        → release
     *
     * Button down/up MUST be in separate calls: if both are in one buffer,
     * the game sees btn_down then btn_up, ending with btn_pressed=false,
     * and the click is missed.
     */
    /* Track accumulated cursor position from REAL events (when not injecting).
     * This tracks what the game actually sees from hardware input. */
    if ((g_injState == INJ_IDLE || g_injState == INJ_COMPLETE) &&
        realEvents > 0 && rgdod && cbObjectData >= DINPUT7_OBJECTDATA_SIZE &&
        !(dwFlags & 0x1)) {
        for (DWORD i = 0; i < realEvents; i++) {
            BYTE *ev = (BYTE *)rgdod + (i * cbObjectData);
            DWORD ofs = *(DWORD *)(ev + 0);
            LONG  val = (LONG)*(DWORD *)(ev + 4);
            if (ofs == 0) g_accumX += val;
            else if (ofs == 4) g_accumY += val;
            else if (ofs == 12) g_accumBtn = val;
        }
    }

    /* rawclick: SendInput from in-process.
     * SendInput goes through the full Windows input pipeline, generating BOTH
     * DInput events AND WM messages — as close to a real mouse click as possible.
     * We also force GetCursorPos and GetAsyncKeyState overrides. */
    if (g_rawclickState != RAWCLICK_IDLE) {
        int ix = (int)g_rawclickX, iy = (int)g_rawclickY;

        if (g_rawclickState == RAWCLICK_PENDING) {
            /* Force GetCursorPos to return target coords */
            g_forceX = ix;
            g_forceY = iy;
            g_forceClickFrames = 200;

            /* Move cursor via SetCursorPos */
            SetCursorPos(ix, iy);

            /* SendInput: move mouse to absolute position + left button down */
            INPUT inputs[2];
            memset(inputs, 0, sizeof(inputs));

            /* Mouse move (absolute) */
            inputs[0].type = INPUT_MOUSE;
            inputs[0].mi.dx = (LONG)((ix * 65535) / GetSystemMetrics(SM_CXSCREEN));
            inputs[0].mi.dy = (LONG)((iy * 65535) / GetSystemMetrics(SM_CYSCREEN));
            inputs[0].mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;

            /* Mouse left button down */
            inputs[1].type = INPUT_MOUSE;
            inputs[1].mi.dx = inputs[0].mi.dx;
            inputs[1].mi.dy = inputs[0].mi.dy;
            inputs[1].mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTDOWN;

            UINT sent = SendInput(2, inputs, sizeof(INPUT));
            hookLog("RAWCLICK: SendInput MOVE+LEFTDOWN at (%d,%d) abs(%ld,%ld) sent=%u",
                    ix, iy, inputs[0].mi.dx, inputs[0].mi.dy, sent);

            g_rawclickState = RAWCLICK_UP;

        } else if (g_rawclickState == RAWCLICK_UP) {
            /* SendInput: left button up */
            INPUT input;
            memset(&input, 0, sizeof(input));
            input.type = INPUT_MOUSE;
            input.mi.dwFlags = MOUSEEVENTF_LEFTUP;

            UINT sent = SendInput(1, &input, sizeof(INPUT));
            hookLog("RAWCLICK: SendInput LEFTUP sent=%u", sent);

            g_rawclickState = RAWCLICK_DONE;
            g_forceClickFrames = 0;
        }
    }

    if (g_gameclickState != GAMECLICK_IDLE && g_callerEBP) {
        void *cinput = (void *)(uintptr_t)g_callerEBP;
        float fx = g_gameclickX, fy = g_gameclickY;
        DWORD buttonIndex = g_gameclickButtonIndex;

        if (g_gameclickState == GAMECLICK_PENDING) {
            callGameQueueMove(cinput, fx, fy);
            callGameQueueButton(cinput, fx, fy, buttonIndex, 1);
            g_gameclickState = GAMECLICK_HOLD;
            g_gameclickHoldFrames = 2;
            hookLog("GAMECLICK: called move+btn_down button=%lu at (%.0f,%.0f)",
                    (unsigned long)buttonIndex, fx, fy);
        } else if (g_gameclickState == GAMECLICK_HOLD) {
            LONG holdFrames = g_gameclickHoldFrames - 1;
            g_gameclickHoldFrames = holdFrames;
            if (holdFrames <= 0) {
                g_gameclickState = GAMECLICK_UP;
            }
        } else if (g_gameclickState == GAMECLICK_UP) {
            callGameQueueButton(cinput, fx, fy, buttonIndex, 0);
            g_gameclickState = GAMECLICK_DONE;
            hookLog("GAMECLICK: called btn_up button=%lu at (%.0f,%.0f)",
                    (unsigned long)buttonIndex, fx, fy);
        }
    }

    if (g_injState == INJ_IDLE || g_injState == INJ_COMPLETE)
        return hr;
    if (!rgdod || !pdwInOut || cbObjectData < DINPUT7_OBJECTDATA_SIZE)
        return hr;
    if (dwFlags & 0x1) /* DIGDD_PEEK — don't inject on peek calls */
        return hr;

    /* SUPPRESS all real events — write from start of buffer */
    BYTE *writePtr = (BYTE *)rgdod;
    DWORD added = 0;

    switch (g_injState) {
    case INJ_RESET:
        /* Call 1: Slam cursor to (0,0) with large negative deltas. */
        if (savedCapacity >= 2) {
            writeInjEvent(writePtr, 0, (DWORD)(int)-10000);
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)-10000);
            added = 2;

            /* Always go to MOVE first — game needs cursor at target position
             * for several frames before click, so 3D hover detection works. */
            g_injState = INJ_MOVE;
            g_injFrame = 0;
            hookLog("INJ/GDD v8: RESET [X=-10000, Y=-10000] "
                    "[suppressed %lu real] → next: MOVE(%d,%d)",
                    (unsigned long)realEvents,
                    g_injTargetX, g_injTargetY);
        }
        break;

    case INJ_MOVE:
        /* Call 2: Move cursor to target position. */
        if (savedCapacity >= 2) {
            writeInjEvent(writePtr, 0, (DWORD)(int)g_injTargetX);
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)g_injTargetY);
            added = 2;
            g_injFrame = 0;
            if (g_injClickRequested) {
                /* Need to settle for a few frames so game detects hover. */
                g_injState = INJ_SETTLE;
                hookLog("INJ/GDD v8: MOVE [X=%d, Y=%d] → SETTLE (hover detection)",
                        g_injTargetX, g_injTargetY);
            } else {
                g_injState = INJ_COMPLETE;
                hookLog("INJ/GDD v8: MOVE [X=%d, Y=%d] → COMPLETE",
                        g_injTargetX, g_injTargetY);
            }
        }
        break;

    case INJ_BTN_DOWN: {
        /* Align OS cursor with game cursor so WM_LBUTTONDOWN carries correct coords.
         * SetCursorPos does NOT generate DInput deltas in EXCLUSIVE mode. */
        SetCursorPos(g_injScreenX, g_injScreenY);

        /* Force GetCursorPos override too */
        g_forceX = g_injScreenX;
        g_forceY = g_injScreenY;
        g_forceClickFrames = 200;

        /* SendInput button press — goes through full Windows input pipeline,
         * generating BOTH DInput button events AND WM_LBUTTONDOWN. */
        INPUT input;
        memset(&input, 0, sizeof(input));
        input.type = INPUT_MOUSE;
        input.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        UINT sent = SendInput(1, &input, sizeof(INPUT));
        added = 0; /* Don't suppress — let SendInput's events flow normally */
        g_injState = INJ_BTN_HOLD;
        g_injFrame = 0;
        hookLog("INJ/GDD v10: BTN_DOWN via SendInput sent=%u at screen(%d,%d)",
                sent, g_injScreenX, g_injScreenY);
        break;
    }

    case INJ_BTN_UP: {
        /* Use SendInput for button release */
        INPUT input;
        memset(&input, 0, sizeof(input));
        input.type = INPUT_MOUSE;
        input.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        UINT sentUp = SendInput(1, &input, sizeof(INPUT));
        added = 0; /* Don't suppress real events */
        g_injState = INJ_COMPLETE;
        hookLog("INJ/GDD v10: BTN_UP via SendInput sent=%u → COMPLETE at (%d,%d)",
                sentUp, g_injScreenX, g_injScreenY);
        break;
    }

    case INJ_SETTLE:
        /* Settle — wait several frames for game to update 3D cursor/hover state
         * before clicking. Game's CCursor3D needs time to ray-cast AABB on menu
         * meshes and detect the hover (HighLight) state. */
        g_injFrame++;
        /* SetCursorPos+WM_MOUSEMOVE removed — caused issues in NONEXCLUSIVE mode. */
        if (g_injFrame < 5) {
            hookLog("INJ/GDD v8: SETTLE frame %d/5 [suppressed %lu real]",
                    g_injFrame, (unsigned long)realEvents);
        } else {
            if (g_injClickRequested == 3) {
                /* moveclick mode: use pure DInput button injection */
                g_injState = INJ_MOVECLICK_BTN;
                hookLog("INJ/GDD v8: SETTLE done → MOVECLICK_BTN (pure DInput)");
            } else if (g_injClickRequested) {
                g_injState = INJ_BTN_DOWN;
                hookLog("INJ/GDD v8: SETTLE done → BTN_DOWN");
            } else {
                g_injState = INJ_COMPLETE;
                hookLog("INJ/GDD v8: SETTLE done → COMPLETE");
            }
        }
        break;

    case INJ_BTN_HOLD:
        /* Hold button for 3 frames before releasing */
        g_injFrame++;
        if (g_injFrame < 3) {
            hookLog("INJ/GDD v8: BTN_HOLD frame %d/3", g_injFrame);
        } else {
            g_injState = INJ_BTN_UP;
            hookLog("INJ/GDD v8: BTN_HOLD done → BTN_UP");
        }
        break;

    case INJ_BTN_ONLY: {
        /* Button-only injection (fclick or btn command). */
        if (g_injClickRequested == 2 && savedCapacity >= 3) {
            /* FCLICK: position delta + button down */
            writeInjEvent(writePtr, 0, (DWORD)(int)g_injTargetX);
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)g_injTargetY);
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 12, 0x80);
            added = 3;
            hookLog("INJ/GDD v7: FCLICK dx=%d dy=%d + btn_down",
                    g_injTargetX, g_injTargetY);
        } else if (savedCapacity >= 1) {
            writeInjEvent(writePtr, 12, 0x80);
            added = 1;
            hookLog("INJ/GDD v7: BTN_ONLY btn_down");
        }
        g_injState = INJ_BTN_UP;
        g_injFrame = 0;
        break;
    }

    case INJ_ALLCLICK: {
        /* ALL-IN-ONE: reset + move + btn_down + btn_up in a SINGLE GDD call.
         * Real mouse hardware produces interleaved position+button events in one
         * buffer when polled infrequently (which is the case on the title screen
         * where GDD is called only every ~5-10 seconds in TCG emulation).
         * Events: [dx_reset, dy_reset, dx_target, dy_target, btn_down, btn_up] */
        DWORD needed = 6;
        if (savedCapacity >= needed) {
            writeInjEvent(writePtr, 0, (DWORD)(int)-10000);  /* X reset */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)-10000);  /* Y reset */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 0, (DWORD)(int)g_injTargetX);  /* X move to target */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)g_injTargetY);  /* Y move to target */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 12, 0x80);  /* Button down */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 12, 0x00);  /* Button up */
            added = needed;
            g_injState = INJ_COMPLETE;

            hookLog("INJ/GDD v9: ALLCLICK [reset(-10000,-10000) move(%d,%d) btn_down btn_up] "
                    "in SINGLE call [suppressed %lu real]",
                    g_injTargetX, g_injTargetY, (unsigned long)realEvents);

            /* DO NOT PostMessage — can disrupt DirectDraw focus */
        } else {
            hookLog("INJ/GDD v9: ALLCLICK needs %lu events but cap=%lu, falling back to RESET",
                    (unsigned long)needed, (unsigned long)savedCapacity);
            g_injState = INJ_RESET;  /* Fall back to multi-call approach */
        }
        break;
    }

    case INJ_DIRECTCLICK: {
        /* DIRECT CLICK phase 1: MOVE ONLY, NO button, NO reset.
         * Assumes cursor starts at (0,0) (from GetCursorPos at init).
         * TargetX/Y are absolute screen coords = DInput deltas from origin.
         * CRITICAL: Game's CCursor3D needs several frames after cursor moves
         * to ray-cast AABB on menu meshes and detect hover (HighLight) state.
         * Phase 2 (INJ_SETTLE) waits for hover detection.
         * Phase 3 (INJ_BTN_DOWN) sends button press.
         * Phase 4 (INJ_BTN_HOLD) holds for frames.
         * Phase 5 (INJ_BTN_UP) releases button. */
        DWORD needed = 2;
        if (savedCapacity >= needed) {
            writeInjEvent(writePtr, 0, (DWORD)(int)g_injTargetX);  /* X delta = target */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)g_injTargetY);  /* Y delta = target */
            added = needed;
            /* Preserve g_injClickRequested if already set (e.g. 3 for moveclick).
             * Only default to 1 if it wasn't already set by the command handler. */
            if (g_injClickRequested < 1)
                g_injClickRequested = 1;  /* Tell SETTLE to proceed to BTN_DOWN */
            g_injState = INJ_SETTLE;
            g_injFrame = 0;

            hookLog("INJ/GDD: DIRECTCLICK phase1 [move(%d,%d)] "
                    "[suppressed %lu real] -> SETTLE (hover detection)",
                    g_injTargetX, g_injTargetY, (unsigned long)realEvents);
        } else {
            hookLog("INJ/GDD: DIRECTCLICK needs %lu events but cap=%lu",
                    (unsigned long)needed, (unsigned long)savedCapacity);
        }
        break;
    }

    case INJ_CLICK2_DOWN: {
        /* click2 call 1: reset + move + btn_down — NO btn_up.
         * Button stays pressed across the entire GDD interval (~80-100s).
         * Game processes: cursor moves to target, btn_down seen, frame runs
         * with button pressed → raycast → if over button, trigger event.
         * btn_up comes in NEXT GDD call (INJ_CLICK2_UP). */
        DWORD needed = 5;
        if (savedCapacity >= needed) {
            writeInjEvent(writePtr, 0, (DWORD)(int)-10000);  /* X reset */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)-10000);  /* Y reset */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 0, (DWORD)(int)g_injTargetX);  /* X move */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)g_injTargetY);  /* Y move */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 12, 0x80);  /* Button 0 down — NO btn_up */
            added = needed;
            g_injState = INJ_CLICK2_UP;
            hookLog("INJ/GDD: CLICK2_DOWN [reset+move(%d,%d)+btn_down] "
                    "[suppressed %lu real] → next: CLICK2_UP",
                    g_injTargetX, g_injTargetY, (unsigned long)realEvents);
        } else {
            hookLog("INJ/GDD: CLICK2_DOWN needs %lu events but cap=%lu",
                    (unsigned long)needed, (unsigned long)savedCapacity);
        }
        break;
    }

    case INJ_CLICK2_UP: {
        /* click2 call 2: btn_up only.
         * By this time, the game has had one full frame with button pressed
         * at the target position. If the click registered, the menu should
         * have already navigated. */
        if (savedCapacity >= 1) {
            writeInjEvent(writePtr, 12, 0x00);  /* Button 0 up */
            added = 1;
            g_injState = INJ_COMPLETE;
            hookLog("INJ/GDD: CLICK2_UP [btn_up] → COMPLETE at (%d,%d) "
                    "[suppressed %lu real]",
                    g_injTargetX, g_injTargetY, (unsigned long)realEvents);
        }
        break;
    }

    case INJ_MOVECLICK_SETTLE: {
        /* MOVECLICK settle: wait for game to process cursor move and detect hover.
         * After settle, inject button events via DInput buffer (NOT SendInput). */
        g_injFrame++;
        if (g_injFrame < 5) {
            hookLog("INJ/GDD: MOVECLICK_SETTLE frame %d/5 [suppressed %lu real]",
                    g_injFrame, (unsigned long)realEvents);
        } else {
            g_injState = INJ_MOVECLICK_BTN;
            hookLog("INJ/GDD: MOVECLICK_SETTLE done → MOVECLICK_BTN");
        }
        break;
    }

    case INJ_MOVECLICK_BTN: {
        /* MOVECLICK button: inject btn_down + btn_up via DInput buffer.
         * Pure DInput injection — no SendInput, no OS cursor manipulation.
         * Game sees button events directly in GetDeviceData buffer. */
        if (savedCapacity >= 2) {
            writeInjEvent(writePtr, 12, 0x80);  /* Button 0 down */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 12, 0x00);  /* Button 0 up */
            added = 2;
            g_injState = INJ_COMPLETE;
            hookLog("INJ/GDD: MOVECLICK_BTN [btn_down + btn_up] → COMPLETE at (%d,%d) "
                    "[suppressed %lu real]",
                    g_injTargetX, g_injTargetY, (unsigned long)realEvents);
        } else {
            hookLog("INJ/GDD: MOVECLICK_BTN needs 2 events but cap=%lu",
                    (unsigned long)savedCapacity);
        }
        break;
    }

    default:
        hookLog("INJ/GDD v7: unexpected state=%d, suppressing %lu real events",
                (int)g_injState, (unsigned long)realEvents);
        break;
    }

    /* Only override event count when we injected events or need to suppress.
     * When added == 0 and we're in SendInput-based phases (BTN_DOWN, BTN_HOLD, BTN_UP),
     * let real events through so SendInput's events reach the game. */
    if (added > 0) {
        *pdwInOut = added;
    } else if (g_injState != INJ_BTN_DOWN && g_injState != INJ_BTN_HOLD &&
               g_injState != INJ_BTN_UP && g_injState != INJ_COMPLETE) {
        *pdwInOut = 0; /* Suppress during RESET/MOVE/SETTLE positioning phases */
    }
    /* else: leave *pdwInOut as-is (realEvents) — let SendInput events through */

    /* Track accumulated cursor from injected events */
    {
        DWORD finalCount = *pdwInOut;
        if (finalCount > 0 && rgdod && cbObjectData >= DINPUT7_OBJECTDATA_SIZE) {
            for (DWORD i = 0; i < finalCount; i++) {
                BYTE *ev = (BYTE *)rgdod + (i * cbObjectData);
                DWORD ofs = *(DWORD *)(ev + 0);
                LONG  val = (LONG)*(DWORD *)(ev + 4);
                if (ofs == 0) g_accumX += val;
                else if (ofs == 4) g_accumY += val;
                else if (ofs == 12) g_accumBtn = val;
            }
        }
    }

    /* NOTE: Do NOT call CInputLayer::GetMousePos (0x4D67F0) here.
     * Even from the game thread, calling it during DInput polling causes
     * 0xC0000005 crashes (function relies on state not yet updated).
     * g_gameMouseX/Y remain 0 — use readmem for cursor diagnosis instead. */

    /* Process pending UI work directly from the game thread.
     * WM_APP_PENDING_UI dispatch via WndProc doesn't work because the game's
     * PeekMessage loop filters out custom messages. By calling processPendingUiWork
     * here (inside GetDeviceData, which runs on the game thread during frame
     * processing), we guarantee the game thread executes the screen transition. */
    if (g_screenEntryPending) {
        hookLog("GDD: processing screenEntryPending from GetDeviceData hook");
        processPendingUiWork("gdd-direct");
    }

    /* Signal event handle to keep game polling */
    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);

    return DI_OK;
}

/* --- Hooked SetEventNotification for MOUSE --- */

static HRESULT WINAPI hookedMouseSetEventNotification(
    LPDIRECTINPUTDEVICEA self, HANDLE hEvent
) {
    hookLog("SetEventNotification called: hEvent=%p", (void*)hEvent);
    g_mouseEventHandle = hEvent;
    return g_origMouseSetEventNotification(self, hEvent);
}

static void ensureMouseWakeEvent(LPDIRECTINPUTDEVICEA self, const char *reason) {
    HANDLE hEvt;
    HRESULT hr;

    if (!self || g_mouseEventHandle || !g_origMouseSetEventNotification)
        return;

    hEvt = CreateEventA(NULL, FALSE, FALSE, NULL);
    if (!hEvt) {
        hookLog("WakeEvent[%s]: CreateEvent failed err=%lu",
                reason ? reason : "unknown", GetLastError());
        return;
    }

    hr = g_origMouseSetEventNotification(self, hEvt);
    if (FAILED(hr)) {
        hookLog("WakeEvent[%s]: SetEventNotification failed hr=0x%08X",
                reason ? reason : "unknown", (unsigned)hr);
        CloseHandle(hEvt);
        return;
    }

    g_privateMouseEventHandle = hEvt;
    g_mouseEventHandle = hEvt;
    SetEvent(hEvt);
    hookLog("WakeEvent[%s]: installed private event=%p hr=0x%08X",
            reason ? reason : "unknown", (void *)hEvt, (unsigned)hr);
}

/* --- Hooked SetDataFormat for MOUSE — log the data format --- */

static HRESULT WINAPI hookedMouseSetDataFormat(
    LPDIRECTINPUTDEVICEA self, LPCDIDATAFORMAT lpdf
) {
    hookLog("SetDataFormat called: dwSize=%lu, dwObjSize=%lu, dwFlags=0x%lX, dwDataSize=%lu, dwNumObjs=%lu",
            (unsigned long)lpdf->dwSize, (unsigned long)lpdf->dwObjSize,
            (unsigned long)lpdf->dwFlags, (unsigned long)lpdf->dwDataSize,
            (unsigned long)lpdf->dwNumObjs);
    /* Log each object in the format */
    for (DWORD i = 0; i < lpdf->dwNumObjs && i < 20; i++) {
        const DIOBJECTDATAFORMAT *obj = &lpdf->rgodf[i];
        hookLog("  obj[%lu]: ofs=%lu, dwType=0x%08lX, dwFlags=0x%lX, pguid=%p",
                (unsigned long)i, (unsigned long)obj->dwOfs,
                (unsigned long)obj->dwType, (unsigned long)obj->dwFlags,
                (void*)obj->pguid);
    }
    return g_origMouseSetDataFormat(self, lpdf);
}

/* --- Hooked SetProperty for MOUSE — log buffer size etc. --- */

static HRESULT WINAPI hookedMouseSetProperty(
    LPDIRECTINPUTDEVICEA self, REFGUID rguidProp, LPCDIPROPHEADER pdiph
) {
    if (rguidProp == (REFGUID)DIPROP_BUFFERSIZE || (DWORD_PTR)rguidProp == 1) {
        LPDIPROPDWORD pd = (LPDIPROPDWORD)pdiph;
        hookLog("SetProperty DIPROP_BUFFERSIZE: dwData=%lu", (unsigned long)pd->dwData);
    } else {
        hookLog("SetProperty: guid=%p, dwSize=%lu, dwHeaderSize=%lu, dwObj=%lu, dwHow=%lu",
                (void*)rguidProp, (unsigned long)pdiph->dwSize,
                (unsigned long)pdiph->dwHeaderSize,
                (unsigned long)pdiph->dwObj, (unsigned long)pdiph->dwHow);
    }
    return g_origMouseSetProperty(self, rguidProp, pdiph);
}

/* Forward declarations for WndProc hook (defined later) */
static WNDPROC g_origWndProc;
static LRESULT CALLBACK hookedWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

/* When non-zero, hookedWndProc bypasses DDraw and forwards mouse messages
 * directly to the game's class WndProc. Set by "wpclick" TCP command,
 * cleared after WM_LBUTTONUP is forwarded. */
static volatile int g_bypassDDraw = 0;

/* --- Hooked Acquire for MOUSE --- */

static HRESULT WINAPI hookedMouseAcquire(LPDIRECTINPUTDEVICEA self) {
    HRESULT hr = g_origMouseAcquire(self);
    hookLog("Mouse Acquire() = 0x%08X (%s)",
            (unsigned)hr,
            hr == DI_OK ? "OK" :
            hr == S_FALSE ? "ALREADY_ACQUIRED" :
            hr == (HRESULT)0x80070005 ? "OTHERAPPHASPRIO" :
            hr == (HRESULT)DIERR_NOTINITIALIZED ? "NOTINITIALIZED" : "OTHER");
    if (SUCCEEDED(hr))
        ensureMouseWakeEvent(self, "acquire");
    if (FAILED(hr)) {
        hookLog("WARNING: Mouse Acquire FAILED! Game will have no mouse input!");
    }
    return hr;
}

/* --- Hooked SetCooperativeLevel for MOUSE --- */

static HRESULT WINAPI hookedMouseSetCooperativeLevel(
    LPDIRECTINPUTDEVICEA self, HWND hwnd, DWORD dwFlags
) {
    g_gameHwnd = hwnd;
    DWORD origFlags = dwFlags;

    /* Install WndProc hook immediately when we get the game hwnd */
    if (hwnd && !g_origWndProc) {
        g_origWndProc = (WNDPROC)SetWindowLongPtrA(hwnd, GWLP_WNDPROC, (LONG_PTR)hookedWndProc);
        hookLog("WndProc hook installed early (hwnd=%p, orig=%p)", (void*)hwnd, (void*)g_origWndProc);
    }

    /* v7: Force NONEXCLUSIVE + BACKGROUND for QEMU compatibility.
     *
     * EXCLUSIVE+FOREGROUND requires the window to be foreground when
     * Acquire() is called. In QEMU, the game window may NOT be foreground
     * at startup (console window competes for focus), causing Acquire()
     * to fail. Once Acquire() fails, the game disables mouse input.
     *
     * NONEXCLUSIVE+BACKGROUND always acquires successfully.
     * Delta scaling concern: NONEXCLUSIVE mode may apply mouse acceleration,
     * but we inject events directly into GetDeviceData, bypassing this. */
    dwFlags = DISCL_NONEXCLUSIVE | DISCL_BACKGROUND;
    hookLog("SetCooperativeLevel: hwnd=%p, origFlags=0x%lX -> forced NONEXCL|BG (0x%lX)",
            (void*)hwnd, (unsigned long)origFlags, (unsigned long)dwFlags);

    return g_origMouseSetCooperativeLevel(self, hwnd, dwFlags);
}

/* --- Background wake thread ---
 *
 * Emperor uses event-driven DInput: SetEventNotification(hEvent) + WaitForSingleObject.
 * The game only calls GetDeviceData when the event is signaled (i.e., real input arrives).
 * This thread periodically signals the event handle to wake the game during injection,
 * ensuring GetDeviceData is called so our hook can inject synthetic events.
 */

/* Trigger a click at the given game coordinates.
 *
 * ARCHITECTURE:
 * - Game uses DInput7 GetDeviceData (buffered mode) for mouse, NOT GetDeviceState
 * - GetDeviceData called every ~5-6s (event-driven with WaitForSingleObject)
 * - In NONEXCLUSIVE mode, DInput returns ACCELERATED deltas (not raw)
 * - Windows "Enhance pointer precision" halves large instant jumps
 *
 * FIX: Disable mouse acceleration before sending events, restore after.
 * Use relative mouse_event for predictable DInput deltas.
 *
 * Flow:
 * 1. Disable mouse acceleration
 * 2. RESET: relative mouse_event (-10000, -10000) → clamps to (0,0)
 * 3. WAIT 12s → GetDeviceData drains reset events
 * 4. MOVE: relative mouse_event (gameX, gameY) → exact delta to target
 * 5. WAIT 12s → GetDeviceData drains move events + hover
 * 6. CLICK: mouse_event button down/up
 * 7. Restore mouse acceleration
 */
static void triggerInjectionClick(int gameX, int gameY, const char *label) {
    hookLog("=== triggerInjectionClick: %s at (%d,%d) ===", label, gameX, gameY);

    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);

    /* Disable mouse acceleration for predictable DInput deltas.
     * SPI_GETMOUSE returns [threshold1, threshold2, acceleration].
     * Set to [0, 0, 0] to disable. */
    int origAccel[3] = {0, 0, 0};
    SystemParametersInfoA(SPI_GETMOUSE, 0, origAccel, 0);
    int noAccel[3] = {0, 0, 0};
    SystemParametersInfoA(SPI_SETMOUSE, 0, noAccel, 0);

    /* Also set pointer speed to middle (10 = default, 1:1 mapping) */
    int origSpeed = 10;
    SystemParametersInfoA(SPI_GETMOUSESPEED, 0, &origSpeed, 0);
    int speed = 10;
    SystemParametersInfoA(SPI_SETMOUSESPEED, 0, (PVOID)(intptr_t)speed, 0);

    hookLog("  screen=%dx%d, origAccel=[%d,%d,%d] speed=%d",
            screenW, screenH, origAccel[0], origAccel[1], origAccel[2], origSpeed);

    /* PHASE 1: RESET — large negative relative movement slams cursor to (0,0).
     * Use relative mode so DInput gets the exact delta we send.
     * Send multiple times for robustness. */
    for (int i = 0; i < 5; i++) {
        mouse_event(MOUSEEVENTF_MOVE, (DWORD)(int)-2000, (DWORD)(int)-2000, 0, 0);
        Sleep(100);
    }
    POINT pt;
    GetCursorPos(&pt);
    hookLog("  RESET: GetCursorPos=(%ld,%ld) (should be 0,0)", pt.x, pt.y);

    /* Signal event handle to wake game */
    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);

    /* Wait for GetDeviceData to drain reset events.
     * Signal event handle repeatedly to keep game polling. */
    hookLog("  Waiting for reset drain (signaling every 500ms)...");
    for (int w = 0; w < 10; w++) {
        Sleep(500);
        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
    }

    /* PHASE 2: MOVE — relative movement from (0,0) to target.
     * DInput in NONEXCLUSIVE mode applies a consistent 0.5x scaling factor
     * (confirmed: rel(400,380) → DInput delta (200,190)).
     * Compensate by sending 2x the desired game coordinates. */
    int moveX = gameX * 2;
    int moveY = gameY * 2;
    mouse_event(MOUSEEVENTF_MOVE, (DWORD)moveX, (DWORD)moveY, 0, 0);
    Sleep(200);
    GetCursorPos(&pt);
    hookLog("  MOVE: rel(%d,%d) [2x=%d,%d] → GetCursorPos=(%ld,%ld)",
            gameX, gameY, moveX, moveY, pt.x, pt.y);

    /* Signal event handle */
    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);

    /* Wait for GetDeviceData to process move + hover */
    hookLog("  Waiting for move + hover (signaling every 500ms)...");
    for (int w = 0; w < 10; w++) {
        Sleep(500);
        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
    }

    /* FIX: The 2x relative mouse_event puts the Windows cursor at (2*gameX, 2*gameY).
     * But many games (especially menus) use GetCursorPos for hit-testing.
     * SetCursorPos teleports cursor to the correct game position without generating
     * DInput events (which is fine — we already have the right DInput deltas from above). */
    SetCursorPos(gameX, gameY);
    Sleep(500);
    GetCursorPos(&pt);
    hookLog("  SetCursorPos(%d,%d) → actual=(%ld,%ld)", gameX, gameY, pt.x, pt.y);

    /* PHASE 3: CLICK */
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    Sleep(300);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    GetCursorPos(&pt);
    hookLog("  CLICK done. GetCursorPos=(%ld,%ld)", pt.x, pt.y);

    /* Signal event handle */
    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);

    /* Restore mouse settings */
    SystemParametersInfoA(SPI_SETMOUSE, 0, origAccel, 0);
    SystemParametersInfoA(SPI_SETMOUSESPEED, 0, (PVOID)(intptr_t)origSpeed, 0);
}

/* --- WndProc subclass for message logging --- */
/* g_origWndProc forward-declared above hookedMouseSetCooperativeLevel */
static volatile LONG g_wndProcMsgCount = 0;

static LRESULT CALLBACK hookedWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_APP_PENDING_UI) {
        hookLog("WndProc: WM_APP_PENDING_UI seq=%lu", (unsigned long)wParam);
        processPendingUiWork("wndproc");
        return 0;
    }

    /* Log mouse-related and input messages */
    switch (msg) {
    case WM_MOUSEMOVE:
    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
    case WM_MOUSEACTIVATE:
    case WM_SETCURSOR:
    case WM_NCHITTEST: {
        LONG c = InterlockedIncrement(&g_wndProcMsgCount);
        if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP || msg == WM_MOUSEMOVE) {
            int x = (short)LOWORD(lParam);
            int y = (short)HIWORD(lParam);
            hookLog("WndProc: msg=0x%04X (%s) x=%d y=%d wParam=0x%lX bypass=%d [#%ld]",
                    msg,
                    msg == WM_MOUSEMOVE ? "MOUSEMOVE" :
                    msg == WM_LBUTTONDOWN ? "LBUTTONDOWN" :
                    msg == WM_LBUTTONUP ? "LBUTTONUP" : "?",
                    x, y, (unsigned long)wParam, g_bypassDDraw, c);
        }

        /* DDraw bypass: forward mouse messages directly to game's class WndProc,
         * skipping DDraw's subclassed WndProc which clips cursor in exclusive mode. */
        if (g_bypassDDraw && (msg == WM_MOUSEMOVE || msg == WM_LBUTTONDOWN ||
                              msg == WM_LBUTTONUP || msg == WM_RBUTTONDOWN ||
                              msg == WM_RBUTTONUP)) {
            WNDPROC classWp = (WNDPROC)GetClassLongPtrA(hwnd, GCLP_WNDPROC);
            if (classWp && classWp != (WNDPROC)g_origWndProc) {
                hookLog("  -> bypassing DDraw, forwarding to classWP=%p", (void*)classWp);
                LRESULT result = CallWindowProcA(classWp, hwnd, msg, wParam, lParam);
                if (msg == WM_LBUTTONUP) {
                    g_bypassDDraw = 0;
                    hookLog("  -> bypass cleared after LBUTTONUP");
                }
                return result;
            }
        }
        break;
    }
    case WM_INPUT:
        hookLog("WndProc: WM_INPUT received (raw input)");
        break;
    case WM_ACTIVATE:
        hookLog("WndProc: WM_ACTIVATE wParam=0x%lX", (unsigned long)wParam);
        break;
    case WM_SETFOCUS:
        hookLog("WndProc: WM_SETFOCUS");
        break;
    case WM_KILLFOCUS:
        hookLog("WndProc: WM_KILLFOCUS");
        break;
    }
    return CallWindowProcA(g_origWndProc, hwnd, msg, wParam, lParam);
}

/* Self-test removed — all input injection now happens via IPC from inputctl.exe.
 * The IPC handler in wakeThreadProc uses the injection state machine
 * (GetDeviceState/GetDeviceData hooks) which works without focus. */

static DWORD WINAPI wakeThreadProc(LPVOID param) {
    (void)param;
    hookLog("Wake thread started");

    while (!InterlockedCompareExchange(&g_wakeThreadStop, 0, 0)) {
        /* Handle IPC commands from inputctl.exe via shared memory.
         *
         * Strategy: inputctl.exe steals focus when launched via Win+R/CMD.
         * The game stops calling GetDeviceState when not foreground,
         * so the injection state machine stalls.
         *
         * Fix: Since this thread runs IN the game process, we can
         * SetForegroundWindow from the foreground process (the game itself
         * was foreground before inputctl ran). Then wait for the game to
         * resume its main loop, and use triggerInjectionClick which calls
         * mouse_event (generates DInput events in NONEXCLUSIVE mode). */
        if (g_shm && g_shm->cmdType != CMD_NONE && !g_shm->done) {
            LONG cmdType = g_shm->cmdType;

            if (cmdType == CMD_CLICK || cmdType == CMD_MOVE) {
                LONG targetX = g_shm->targetX;
                LONG targetY = g_shm->targetY;

                hookLog("Wake: IPC cmd=%ld target=(%ld,%ld)", cmdType, targetX, targetY);

                /* Step 1: Bring game window to foreground.
                 * This is critical — inputctl.exe via Win+R stole focus.
                 * Since we're in the game process, SetForegroundWindow should
                 * succeed (processes can set their own windows foreground). */
                if (g_gameHwnd) {
                    HWND fg = GetForegroundWindow();
                    hookLog("Wake: current foreground=%p, game=%p", (void*)fg, (void*)g_gameHwnd);

                    ShowWindow(g_gameHwnd, SW_RESTORE);
                    SetForegroundWindow(g_gameHwnd);
                    BringWindowToTop(g_gameHwnd);
                    SetActiveWindow(g_gameHwnd);
                    SetFocus(g_gameHwnd);

                    /* Wait for D3D fullscreen to re-establish and game
                     * to resume its main loop (GetDeviceState calls).
                     * Check by monitoring g_getDeviceStateCallCount. */
                    LONG countBefore = g_getDeviceStateCallCount;
                    hookLog("Wake: waiting for game to resume (GDS count=%ld)...", countBefore);

                    for (int w = 0; w < 100; w++) {
                        Sleep(200);
                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                        LONG countNow = g_getDeviceStateCallCount;
                        if (countNow > countBefore + 5) {
                            hookLog("Wake: game resumed! GDS count %ld → %ld (+%ld)",
                                    countBefore, countNow, countNow - countBefore);
                            break;
                        }
                    }

                    fg = GetForegroundWindow();
                    hookLog("Wake: foreground now=%p (game=%p, match=%d)",
                            (void*)fg, (void*)g_gameHwnd, (fg == g_gameHwnd));
                }

                /* Step 2: Re-acquire mouse device (may have been lost on focus change) */
                if (g_mouseDevice) {
                    HRESULT acqHr = g_mouseDevice->lpVtbl->Acquire(g_mouseDevice);
                    hookLog("Wake: Mouse Acquire() = 0x%08X", (unsigned)acqHr);
                }

                /* Step 3: Click using all approaches.
                 * If targetX == -1, scan mode: try multiple positions. */
                if (targetX == -1 && cmdType == CMD_CLICK) {
                    /* SCAN MODE: try clicking at multiple positions across the screen.
                     * This helps find invisible menu buttons. */
                    hookLog("Wake: === SCAN MODE ===");
                    static const int scanPositions[][2] = {
                        /* Common menu button positions for 800x600 games */
                        {400, 350}, {400, 375}, {400, 400}, {400, 425},
                        {400, 450}, {400, 475}, {400, 500}, {400, 525},
                        /* Left side (some menus are left-aligned) */
                        {150, 350}, {150, 375}, {150, 400}, {150, 425},
                        {150, 450}, {150, 475},
                        /* Right side */
                        {650, 350}, {650, 375}, {650, 400}, {650, 425},
                        /* Center top area */
                        {400, 250}, {400, 275}, {400, 300}, {400, 325},
                    };
                    int numPositions = sizeof(scanPositions) / sizeof(scanPositions[0]);

                    for (int si = 0; si < numPositions; si++) {
                        int sx = scanPositions[si][0];
                        int sy = scanPositions[si][1];
                        hookLog("Wake: SCAN[%d] clicking (%d,%d)...", si, sx, sy);
                        triggerInjectionClick(sx, sy, "SCAN");
                        Sleep(3000);
                        /* Check if GetDeviceState count jumped (game might start loading) */
                        hookLog("Wake: SCAN[%d] done, GDS count=%ld", si, g_getDeviceStateCallCount);
                    }
                    hookLog("Wake: === SCAN COMPLETE ===");
                } else {
                    /* Normal click: use triggerInjectionClick (mouse_event approach) */
                    if (cmdType == CMD_CLICK) {
                        triggerInjectionClick((int)targetX, (int)targetY, "IPC click");
                    } else {
                        SetCursorPos((int)targetX, (int)targetY);
                        hookLog("Wake: cursor moved to (%ld,%ld)", targetX, targetY);
                    }
                }

                InterlockedExchange(&g_shm->phase, PHASE_IDLE);
                InterlockedExchange(&g_shm->cmdType, CMD_NONE);
                InterlockedExchange(&g_shm->done, 1);
                hookLog("Wake: IPC command complete");
            }
        }

        /* TCP command polling: connect to host TCP_HOST:18890, send status,
         * receive "click X Y\n" or "nop\n". NON-BLOCKING: just set state
         * variables and return. The actual injection happens in GetDeviceState
         * on the game's main thread. */
        /* Pulse mouse event handle while any queued UI/menu/input work is pending.
         * Title snapshots often never install their own event handle, so a private
         * handle plus periodic pulses is what keeps GetDeviceData alive long enough
         * to process synthetic work and emit follow-up traces. */
        if (g_mouseEventHandle && hasPendingWakeWork()) {
            SetEvent(g_mouseEventHandle);
        }

        {
            static DWORD lastTcpCheck = 0;
            static int wsaInited = 0;
            DWORD now = GetTickCount();
            if (now - lastTcpCheck > 2000) {
                lastTcpCheck = now;

                if (!wsaInited) {
                    WSADATA wsa;
                    int wsaResult = WSAStartup(MAKEWORD(2,2), &wsa);
                    if (wsaResult == 0) {
                        wsaInited = 1;
                        hookLog("TCP: WSAStartup OK (version %d.%d)", wsa.wVersion & 0xFF, wsa.wVersion >> 8);
                    } else {
                        static int wsaLogCount = 0;
                        if (wsaLogCount++ < 5)
                            hookLog("TCP: WSAStartup FAILED err=%d", wsaResult);
                    }
                }

                if (wsaInited) {
                    static int tcpAttempt = 0;
                    tcpAttempt++;
                    if (tcpAttempt <= 3)
                        hookLog("TCP: attempt %d, calling socket()...", tcpAttempt);

                    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
                    if (s == INVALID_SOCKET) {
                        if (tcpAttempt <= 5)
                            hookLog("TCP: socket() FAILED wsa=%d", WSAGetLastError());
                    }
                    if (s != INVALID_SOCKET) {
                        if (tcpAttempt <= 3)
                            hookLog("TCP: socket OK (s=%d), connecting...", (int)s);

                        struct sockaddr_in addr;
                        memset(&addr, 0, sizeof(addr));
                        addr.sin_family = AF_INET;
                        addr.sin_port = htons(18890);
#ifndef TCP_HOST
#define TCP_HOST "10.0.2.2"
#endif
                        addr.sin_addr.s_addr = inet_addr(TCP_HOST);

                        /* Non-blocking connect with 500ms select timeout. */
                        u_long nonBlock = 1;
                        ioctlsocket(s, FIONBIO, &nonBlock);

                        int connResult = connect(s, (struct sockaddr*)&addr, sizeof(addr));
                        int connErr = WSAGetLastError();
                        if (tcpAttempt <= 3)
                            hookLog("TCP: connect()=%d wsa=%d", connResult, connErr);

                        if (connResult != 0 && connErr == WSAEWOULDBLOCK) {
                            fd_set wfds;
                            FD_ZERO(&wfds);
                            FD_SET(s, &wfds);
                            struct timeval tv = { 0, 500000 }; /* 500ms */
                            int selResult = select(0, NULL, &wfds, NULL, &tv);
                            if (tcpAttempt <= 3)
                                hookLog("TCP: select()=%d", selResult);
                            if (selResult > 0 && FD_ISSET(s, &wfds)) {
                                connResult = 0;
                            } else {
                                connResult = -1;
                            }
                        }

                        nonBlock = 0;
                        ioctlsocket(s, FIONBIO, &nonBlock);
                        DWORD timeout = 1000;
                        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (char*)&timeout, sizeof(timeout));
                        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (char*)&timeout, sizeof(timeout));

                        if (connResult != 0) {
                            if (tcpAttempt <= 10)
                                hookLog("TCP: FAILED attempt %d", tcpAttempt);
                        }
                        if (connResult == 0) {
                            hookLog("TCP: CONNECTED on attempt %d!", tcpAttempt);
                            /* Send diagnostic info with poll */
                            char pollMsg[640];
                            POINT pt = {0, 0};
                            if (g_origGetCursorPos) g_origGetCursorPos(&pt);
                            else GetCursorPos(&pt);
                            /* Read CInputLayer cursor position from game thread's last result.
                             * GetMousePos is UNSAFE to call from the TCP thread (causes 0xC0000005).
                             * Instead, the GetDeviceData hook calls it on the game thread and stores
                             * the result in g_gameMouseX/Y globals. */
                            float ciX = (float)g_gameMouseX;
                            float ciY = (float)g_gameMouseY;
                            snprintf(pollMsg, sizeof(pollMsg),
                                "poll state=%d gds=%ld gdd=%ld kbd=%ld gas=%ld gcp=%ld cur=%ld,%ld hwnd=%d evt=%d ax=%ld ay=%ld ab=%ld ci=%.1f,%.1f hr=0x%08X re=%lu rq=%ld ra=0x%08X md=%p eb=0x%08X rc=%d gc=%d mc=%ld mt=%ld ms=%ld so=%ld sp=%ld se=%ld sa=0x%08X pk=%ld pb=%ld\n",
                                (int)g_injState,
                                (long)g_getDeviceStateCallCount,
                                (long)g_getDeviceDataCallCount,
                                (long)g_kbdGetDeviceStateCallCount,
                                (long)g_gasCallCount,
                                (long)g_gcpCallCount,
                                pt.x, pt.y,
                                g_gameHwnd ? 1 : 0,
                                g_mouseEventHandle ? 1 : 0,
                                (long)g_accumX, (long)g_accumY, (long)g_accumBtn,
                                ciX, ciY,
                                (unsigned)g_lastGddHr,
                                (unsigned long)g_lastGddRealEvents,
                                (long)g_reacqTotal,
                                (unsigned)g_lastGddRetAddr,
                                (void*)g_mouseDevice,
                                (unsigned)g_callerEBP,
                                (int)g_rawclickState,
                                (int)g_gameclickState,
                                (long)g_menuClickState,
                                (long)g_menuClickTarget,
                                (long)g_menuClickStage,
                                (long)g_screenOpenTraceStage,
                                (long)g_screenPendingApplyMode,
                                (long)g_screenEntryPending,
                                (unsigned)g_screenOpenPendingAddr,
                                (long)g_peekMsgCount,
                                (long)g_peekMouseBtnCount);
                            send(s, pollMsg, (int)strlen(pollMsg), 0);

                            char buf[256] = {0};
                            int n = recv(s, buf, sizeof(buf) - 1, 0);
                            if (n > 0) {
                                buf[n] = 0;
                                int cmdX = 0, cmdY = 0;
                                if (sscanf(buf, "click2 %d %d", &cmdX, &cmdY) == 2) {
                                    /* The old click2 path packed RESET+MOVE into one
                                     * GetDeviceData buffer. The live game binary sums
                                     * all axis events in that buffer before clamping,
                                     * so reset(-10000)+move(+400) collapses back to 0.
                                     * Route click2 through the same cursor-relative
                                     * direct path as click instead. */
                                    hookLog("TCP cmd: click2 at (%d,%d)", cmdX, cmdY);
                                    armDirectClickCommand(cmdX, cmdY, 0, "click2");

                                } else if (sscanf(buf, "click %d %d", &cmdX, &cmdY) == 2) {
                                    hookLog("TCP cmd: click at SCREEN (%d,%d) [cursor-relative DInput injection]", cmdX, cmdY);
                                    armDirectClickCommand(cmdX, cmdY, 0, "click");

                                } else if (strncmp(buf, "fclick", 6) == 0) {
                                    /* Full click: small position delta + button.
                                     * Mimics real mouse input pattern observed during intro:
                                     * [X_delta, Y_delta, btn_down, btn_up] in same buffer.
                                     * The game may require position events alongside button
                                     * events to register a click (observed: btn-only fails). */
                                    int fdx = 0, fdy = 0;
                                    sscanf(buf, "fclick %d %d", &fdx, &fdy);
                                    hookLog("TCP cmd: fclick (dx=%d, dy=%d)", fdx, fdy);
                                    g_injTargetX = fdx;  /* used as delta, not absolute */
                                    g_injTargetY = fdy;
                                    g_injClickRequested = 2;  /* 2 = fclick mode */
                                    g_injFrame = 0;
                                    g_injState = INJ_BTN_ONLY;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    hookLog("TCP: fclick injection armed (dx=%d, dy=%d)", fdx, fdy);

                                } else if (sscanf(buf, "aclick %d %d", &cmdX, &cmdY) == 2) {
                                    /* All-in-one click: reset+move+btn in SINGLE GDD call.
                                     * Hypothesis: game needs position and button events in
                                     * the same GetDeviceData buffer to register a click. */
                                    hookLog("TCP cmd: aclick at (%d,%d) [all-in-one]", cmdX, cmdY);
                                    /* DO NOT call SetCursorPos — breaks fullscreen focus */
                                    g_injTargetX = cmdX;
                                    g_injTargetY = cmdY;
                                    g_injClickRequested = 1;
                                    g_injFrame = 0;
                                    g_injState = INJ_ALLCLICK;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    hookLog("TCP: aclick armed (ALL-IN-ONE at %d,%d)", cmdX, cmdY);

                                } else if (sscanf(buf, "dclick %d %d", &cmdX, &cmdY) == 2) {
                                    /* Direct DInput injection: move + click, NO reset.
                                     * X,Y are absolute screen coords = DInput deltas from (0,0). */
                                    hookLog("TCP cmd: dclick at (%d,%d) [direct, no reset]", cmdX, cmdY);
                                    armDirectClickCommand(cmdX, cmdY, 1, "dclick");

                                } else if (sscanf(buf, "moveclick %d %d", &cmdX, &cmdY) == 2) {
                                    /* Pure DInput click: move+settle+btn via DInput buffer only.
                                     * X,Y are DInput deltas (game cursor pixels from origin).
                                     * Phase 1: write [X, Y] movement events in GDD buffer
                                     * Phase 2: settle 5 frames for CCursor3D hover detection
                                     * Phase 3: write [btn_down, btn_up] in GDD buffer
                                     * NO SendInput, NO SetCursorPos, NO OS cursor manipulation.
                                     * This is the cleanest path for QEMU where OS-level
                                     * input may not reach DirectInput correctly. */
                                    hookLog("TCP cmd: moveclick at (%d,%d) [pure DInput]", cmdX, cmdY);
                                    g_injTargetX = cmdX;
                                    g_injTargetY = cmdY;
                                    g_injScreenX = cmdX;
                                    g_injScreenY = cmdY;
                                    g_injClickRequested = 1;
                                    g_injFrame = 0;
                                    g_injState = INJ_DIRECTCLICK;
                                    /* Override: when SETTLE completes, go to MOVECLICK_BTN
                                     * instead of INJ_BTN_DOWN (which uses SendInput).
                                     * We use a flag to signal this. */
                                    g_injClickRequested = 3;  /* 3 = moveclick mode */
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    hookLog("TCP: moveclick armed at (%d,%d) [pure DInput path]", cmdX, cmdY);
                                    {
                                        char resp[128];
                                        snprintf(resp, sizeof(resp),
                                                "RESP:moveclick armed at (%d,%d)\n", cmdX, cmdY);
                                        send(s, resp, (int)strlen(resp), 0);
                                    }

                                } else if (sscanf(buf, "gasclick %d %d", &cmdX, &cmdY) == 2) {
                                    /* Force ALL input APIs to report click at (X,Y).
                                     * - GetCursorPos returns (X,Y)
                                     * - GetAsyncKeyState(VK_LBUTTON) returns pressed
                                     * - GetKeyState(VK_LBUTTON) returns pressed
                                     * Held for many "frames" (API calls) to ensure the game
                                     * sees the click regardless of which API it polls. */
                                    hookLog("TCP cmd: gasclick at (%d,%d)", cmdX, cmdY);
                                    g_forceX = cmdX;
                                    g_forceY = cmdY;
                                    g_forceClickFrames = 200;  /* 200 API calls worth of override */
                                    hookLog("TCP: gasclick armed at (%d,%d) for 200 frames", cmdX, cmdY);

                                } else if (strncmp(buf, "rawclick ", 9) == 0) {
                                    /* Direct FIFO injection: writes type=3 + type=5 events
                                     * straight into CInputDevice's event queue, bypassing
                                     * ProcessInput's type-4 assignment entirely.
                                     * Usage: rawclick <x> <y> [type] [buttonIndex]
                                     *   type: 4 or 5, default 5
                                     *   buttonIndex: 0..7, default 0 */
                                    float rx = 0, ry = 0;
                                    int rtype = 5;
                                    unsigned int buttonIndex = 0;
                                    sscanf(buf + 9, "%f %f %d %u", &rx, &ry, &rtype, &buttonIndex);
                                    if (buttonIndex > 7) buttonIndex = 7;
                                    g_rawclickX = rx;
                                    g_rawclickY = ry;
                                    g_rawclickType = (DWORD)rtype;
                                    g_rawclickButtonIndex = (DWORD)buttonIndex;
                                    g_rawclickState = RAWCLICK_PENDING;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    hookLog("TCP cmd: rawclick at (%.0f,%.0f) type=%d button=%u",
                                            rx, ry, rtype, buttonIndex);
                                    char resp[128];
                                    snprintf(resp, sizeof(resp),
                                        "RESP:rawclick armed at (%.0f,%.0f) type=%d button=%u\n",
                                        rx, ry, rtype, buttonIndex);
                                    send(s, resp, (int)strlen(resp), 0);

                                } else if (strncmp(buf, "gameclick ", 10) == 0) {
                                    /* Directly call the game's own queue helpers:
                                     *   0x4D3C10(this, x, y)
                                     *   0x4D3D70(this, x, y, buttonIndex, buttonValue)
                                     * This mirrors the WM button wrappers more closely than
                                     * raw queue writes. */
                                    float gx = 0, gy = 0;
                                    unsigned int buttonIndex = 1;
                                    sscanf(buf + 10, "%f %f %u", &gx, &gy, &buttonIndex);
                                    if (buttonIndex > 7) buttonIndex = 7;
                                    g_gameclickX = gx;
                                    g_gameclickY = gy;
                                    g_gameclickButtonIndex = (DWORD)buttonIndex;
                                    g_gameclickHoldFrames = 2;
                                    g_gameclickState = GAMECLICK_PENDING;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    hookLog("TCP cmd: gameclick at (%.0f,%.0f) button=%u",
                                            gx, gy, buttonIndex);
                                    {
                                        char resp[128];
                                        snprintf(resp, sizeof(resp),
                                            "RESP:gameclick armed at (%.0f,%.0f) button=%u\n",
                                            gx, gy, buttonIndex);
                                        send(s, resp, (int)strlen(resp), 0);
                                    }

                                } else if (strncmp(buf, "menuclick", 9) == 0) {
                                    LONG target = MENU_TARGET_SINGLE_PLAYER;
                                    if (strstr(buf, "singleplayer") == NULL &&
                                        strstr(buf, "single player") == NULL &&
                                        strstr(buf, "single-player") == NULL &&
                                        strncmp(buf, "menuclick", 9) != 0) {
                                        target = MENU_TARGET_NONE;
                                    }

                                    if (target == MENU_TARGET_NONE) {
                                        const char *resp = "RESP:menuclick unknown target\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: menuclick unknown target [%s]", buf);
                                    } else {
                                        g_menuClickTarget = target;
                                        g_menuClickStage = 1;
                                        g_menuClickState = MENUCLICK_PENDING_DOWN;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: menuclick target=%s", menuTargetName(target));
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:menuclick armed target=%s\n",
                                                menuTargetName(target));
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }

                                } else if (strncmp(buf, "menudirect", 10) == 0) {
                                    LONG target = MENU_TARGET_SINGLE_PLAYER;
                                    LONG mode = MENUDIRECT_COMBO;
                                    LONG pumpCount = 0;
                                    char *pumpPos = strstr(buf, "pump");

                                    if (strstr(buf, "singleplayer") == NULL &&
                                        strstr(buf, "single player") == NULL &&
                                        strstr(buf, "single-player") == NULL) {
                                        target = MENU_TARGET_NONE;
                                    }

                                    if (strstr(buf, "maincombo")) {
                                        mode = MENUDIRECT_MAINCOMBO;
                                    } else if (strstr(buf, "mainflow")) {
                                        mode = MENUDIRECT_MAINFLOW;
                                    } else if (strstr(buf, "mainscan") || strstr(buf, "scan")) {
                                        mode = MENUDIRECT_MAINSCAN;
                                    } else if (strstr(buf, "maincb") || strstr(buf, "callback")) {
                                        mode = MENUDIRECT_MAINCB;
                                    } else if (strstr(buf, "mainmsg")) {
                                        mode = MENUDIRECT_MAINMSG;
                                    } else if (strstr(buf, "case2")) {
                                        mode = MENUDIRECT_CASE2;
                                    } else if (strstr(buf, "case3")) {
                                        mode = MENUDIRECT_CASE3;
                                    } else if (strstr(buf, "case4")) {
                                        mode = MENUDIRECT_CASE4;
                                    } else if (strstr(buf, "combo")) {
                                        mode = MENUDIRECT_COMBO;
                                    }

                                    if (pumpPos) {
                                        LONG parsedPump = 0;
                                        pumpCount = 1;
                                        if (sscanf(pumpPos + 4, "%ld", &parsedPump) == 1 && parsedPump > 0)
                                            pumpCount = parsedPump;
                                    }

                                    if (target == MENU_TARGET_NONE || mode == MENUDIRECT_NONE) {
                                        const char *resp = "RESP:menudirect invalid target/mode\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: menudirect invalid [%s]", buf);
                                    } else {
                                        g_menuDirectTarget = target;
                                        g_menuDirectMode = mode;
                                        g_menuDirectPumpCount = pumpCount;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: menudirect target=%s mode=%s pump=%ld",
                                                menuTargetName(target), menuDirectModeName(mode),
                                                (long)pumpCount);
                                        {
                                            char resp[160];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:menudirect armed target=%s mode=%s pump=%ld\n",
                                                menuTargetName(target), menuDirectModeName(mode),
                                                (long)pumpCount);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }

                                } else if (strncmp(buf, "menuwatch", 9) == 0) {
                                    LONG hits = 24;

                                    if (strstr(buf, "off")) {
                                        g_menuWatchPendingCommand = -1;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: menuwatch off");
                                        send(s, "RESP:menuwatch off\n", 19, 0);
                                    } else {
                                        if (sscanf(buf + 9, "%ld", &hits) != 1)
                                            hits = 24;
                                        hits = clampMenuWatchHits(hits);
                                        g_menuWatchPendingHits = hits;
                                        g_menuWatchPendingCommand = MENUWATCH_TARGET_MANAGER;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: menuwatch hits=%ld", (long)hits);
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:menuwatch armed hits=%ld\n",
                                                     (long)hits);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }

                                } else if (strncmp(buf, "screenwatch", 11) == 0) {
                                    LONG hits = 24;

                                    if (strstr(buf, "off")) {
                                        g_menuWatchPendingCommand = -1;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: screenwatch off");
                                        send(s, "RESP:screenwatch off\n", 21, 0);
                                    } else {
                                        if (sscanf(buf + 11, "%ld", &hits) != 1)
                                            hits = 24;
                                        hits = clampMenuWatchHits(hits);
                                        g_menuWatchPendingHits = hits;
                                        g_menuWatchPendingCommand = MENUWATCH_TARGET_PENDING;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: screenwatch hits=%ld", (long)hits);
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:screenwatch armed hits=%ld\n",
                                                     (long)hits);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }

                                } else if (strncmp(buf, "screenentries", 13) == 0) {
                                    logActiveScreenEntries("tcp");
                                    send(s, "RESP:screenentries logged\n", 26, 0);

                                } else if (strncmp(buf, "screenstate", 11) == 0) {
                                    logActiveScreenState("tcp");
                                    send(s, "RESP:screenstate logged\n", 24, 0);

                                } else if (strncmp(buf, "screenentrysync ", 16) == 0 ||
                                           strncmp(buf, "screenentry ", 12) == 0) {
                                    int entrySync = (strncmp(buf, "screenentrysync ", 16) == 0);
                                    const char *argBase = entrySync ? (buf + 16) : (buf + 12);
                                    char name[64];

                                    memset(name, 0, sizeof(name));
                                    if (sscanf(argBase, "%63s", name) != 1) {
                                        send(s,
                                             entrySync ? "RESP:screenentrysync badarg\n"
                                                       : "RESP:screenentry badarg\n",
                                             entrySync ? 28 : 24,
                                             0);
                                    } else {
                                        memcpy(g_screenEntryName, name, sizeof(g_screenEntryName));
                                        g_screenEntryName[sizeof(g_screenEntryName) - 1] = 0;
                                        g_screenEntryPending = 1;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        if (entrySync) {
                                            DWORD_PTR dispatchResult = 0;
                                            LONG seq = InterlockedIncrement(&g_pendingUiDispatchSeq);
                                            DWORD err = 0;

                                            g_screenOpenTraceStage = 185;
                                            hookLog("TCP cmd: screenentrysync name=%s", name);
                                            if (!g_gameHwnd) {
                                                send(s, "RESP:screenentrysync nohwnd\n", 29, 0);
                                                hookLog("UIWORK: sync reason=screenentrysync FAILED no hwnd name=%s",
                                                        name);
                                            } else if (SendMessageTimeoutA(g_gameHwnd, WM_APP_PENDING_UI, (WPARAM)seq, 0,
                                                                          SMTO_ABORTIFHUNG | SMTO_BLOCK,
                                                                          120000, &dispatchResult)) {
                                                char resp[160];
                                                snprintf(resp, sizeof(resp),
                                                         "RESP:screenentrysync done name=%s stage=%ld\n",
                                                         name, (long)g_screenOpenTraceStage);
                                                send(s, resp, (int)strlen(resp), 0);
                                                hookLog("UIWORK: sync reason=screenentrysync seq=%ld name=%s done stage=%ld result=%lu",
                                                        (long)seq, name, (long)g_screenOpenTraceStage,
                                                        (unsigned long)dispatchResult);
                                            } else {
                                                char resp[192];
                                                err = GetLastError();
                                                snprintf(resp, sizeof(resp),
                                                         "RESP:screenentrysync timeout err=%lu name=%s stage=%ld\n",
                                                         (unsigned long)err, name, (long)g_screenOpenTraceStage);
                                                send(s, resp, (int)strlen(resp), 0);
                                                hookLog("UIWORK: sync reason=screenentrysync seq=%ld name=%s timeout err=%lu stage=%ld",
                                                        (long)seq, name, (unsigned long)err,
                                                        (long)g_screenOpenTraceStage);
                                            }
                                        } else {
                                            postPendingUiWork("screenentry");
                                            hookLog("TCP cmd: screenentry name=%s", name);
                                            {
                                                char resp[128];
                                                snprintf(resp, sizeof(resp),
                                                         "RESP:screenentry armed name=%s\n", name);
                                                send(s, resp, (int)strlen(resp), 0);
                                            }
                                        }
                                    }

                                } else if (strncmp(buf, "screenpendingsync", 17) == 0 ||
                                           strncmp(buf, "screenpending", 13) == 0) {
                                    int pendingSync = (strncmp(buf, "screenpendingsync", 17) == 0);
                                    const char *argBase = pendingSync ? (buf + 17) : (buf + 13);
                                    LONG pendingMode = 1;

                                    if (strstr(argBase, "both")) {
                                        pendingMode = 3;
                                    } else if (strstr(argBase, "dc")) {
                                        pendingMode = 2;
                                    }

                                    g_screenPendingApplyMode = pendingMode;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    if (pendingSync) {
                                        DWORD_PTR dispatchResult = 0;
                                        LONG seq = InterlockedIncrement(&g_pendingUiDispatchSeq);
                                        DWORD err = 0;

                                        g_screenOpenTraceStage = 184;
                                        if (!g_gameHwnd) {
                                            send(s, "RESP:screenpendingsync nohwnd\n", 31, 0);
                                            hookLog("UIWORK: sync reason=screenpendingsync FAILED no hwnd");
                                        } else if (SendMessageTimeoutA(g_gameHwnd, WM_APP_PENDING_UI, (WPARAM)seq, 0,
                                                                      SMTO_ABORTIFHUNG | SMTO_BLOCK,
                                                                      5000, &dispatchResult)) {
                                            char resp[160];
                                            snprintf(resp, sizeof(resp),
                                                     "RESP:screenpendingsync done mode=%ld stage=%ld\n",
                                                     (long)pendingMode, (long)g_screenOpenTraceStage);
                                            send(s, resp, (int)strlen(resp), 0);
                                            hookLog("UIWORK: sync reason=screenpendingsync seq=%ld mode=%ld done stage=%ld result=%lu",
                                                    (long)seq, (long)pendingMode, (long)g_screenOpenTraceStage,
                                                    (unsigned long)dispatchResult);
                                        } else {
                                            char resp[160];
                                            err = GetLastError();
                                            snprintf(resp, sizeof(resp),
                                                     "RESP:screenpendingsync timeout err=%lu mode=%ld stage=%ld\n",
                                                     (unsigned long)err, (long)pendingMode, (long)g_screenOpenTraceStage);
                                            send(s, resp, (int)strlen(resp), 0);
                                            hookLog("UIWORK: sync reason=screenpendingsync seq=%ld mode=%ld timeout err=%lu stage=%ld",
                                                    (long)seq, (long)pendingMode, (unsigned long)err,
                                                    (long)g_screenOpenTraceStage);
                                        }
                                    } else {
                                        postPendingUiWork("screenpending");
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                     "RESP:screenpending armed mode=%ld\n",
                                                     (long)pendingMode);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }
                                    hookLog("TCP cmd: %s mode=%ld",
                                            pendingSync ? "screenpendingsync" : "screenpending",
                                            (long)pendingMode);

                                } else if (strncmp(buf, "screenopen", 10) == 0 ||
                                           strncmp(buf, "screencombo", 11) == 0 ||
                                           strncmp(buf, "screenapply", 11) == 0 ||
                                           strncmp(buf, "screencommitsync", 16) == 0 ||
                                           strncmp(buf, "screencommit", 12) == 0 ||
                                           strncmp(buf, "screencommitgdd", 15) == 0) {
                                    char name[64];
                                    DWORD screenAddr = 0;
                                    LONG autoPumpCount = 0;
                                    int combo = (strncmp(buf, "screencombo", 11) == 0);
                                    int apply = (strncmp(buf, "screenapply", 11) == 0);
                                    int commitSync = (strncmp(buf, "screencommitsync", 16) == 0);
                                    int commit = (strncmp(buf, "screencommit", 12) == 0);
                                    int commitGdd = (strncmp(buf, "screencommitgdd", 15) == 0);
                                    const char *cmdName = combo
                                        ? "screencombo"
                                        : (commitSync
                                           ? "screencommitsync"
                                           : (commitGdd
                                              ? "screencommitgdd"
                                              : (commit
                                                 ? "screencommit"
                                                 : (apply ? "screenapply" : "screenopen"))));
                                    const char *argBase = commitGdd
                                        ? (buf + 15)
                                        : (commitSync
                                           ? (buf + 16)
                                           : (commit ? (buf + 12) : ((combo || apply) ? (buf + 11) : (buf + 10))));

                                    memset(name, 0, sizeof(name));
                                    if (sscanf(argBase, "%63s", name) == 1)
                                        screenAddr = namedScreenAddress(name);
                                    {
                                        char *pumpPos = strstr(argBase, "pump");
                                        if (pumpPos) {
                                            LONG parsedPump = 0;
                                            if (sscanf(pumpPos + 4, "%ld", &parsedPump) == 1 && parsedPump > 0)
                                                autoPumpCount = clampMenuPumpCount(parsedPump);
                                        }
                                    }

                                    if (!screenAddr) {
                                        const char *resp = combo
                                            ? "RESP:screencombo unknown screen\n"
                                            : ((commit || commitSync || commitGdd)
                                               ? "RESP:screencommit unknown screen\n"
                                               : (apply
                                               ? "RESP:screenapply unknown screen\n"
                                               : "RESP:screenopen unknown screen\n"));
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: %s unknown [%s]", cmdName, buf);
                                    } else {
                                        g_screenOpenPendingAddr = screenAddr;
                                        g_screenOpenPendingMode = combo ? 2 : ((commit || commitSync || commitGdd) ? 4 : (apply ? 3 : 1));
                                        g_screenOpenAutoPumpCount = autoPumpCount;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        if (commitSync) {
                                            DWORD_PTR dispatchResult = 0;
                                            LONG seq = InterlockedIncrement(&g_pendingUiDispatchSeq);
                                            DWORD err = 0;

                                            g_screenOpenTraceStage = 1;
                                            if (!g_gameHwnd) {
                                                send(s, "RESP:screencommitsync nohwnd\n", 29, 0);
                                                hookLog("UIWORK: sync reason=%s FAILED no hwnd", cmdName);
                                            } else if (SendMessageTimeoutA(g_gameHwnd, WM_APP_PENDING_UI, (WPARAM)seq, 0,
                                                                          SMTO_ABORTIFHUNG | SMTO_BLOCK,
                                                                          5000, &dispatchResult)) {
                                                char resp[128];
                                                snprintf(resp, sizeof(resp),
                                                         "RESP:%s done stage=%ld\n",
                                                         cmdName, (long)g_screenOpenTraceStage);
                                                send(s, resp, (int)strlen(resp), 0);
                                                hookLog("UIWORK: sync reason=%s seq=%ld done stage=%ld result=%lu",
                                                        cmdName, (long)seq, (long)g_screenOpenTraceStage,
                                                        (unsigned long)dispatchResult);
                                            } else {
                                                char resp[160];
                                                err = GetLastError();
                                                snprintf(resp, sizeof(resp),
                                                         "RESP:%s timeout err=%lu stage=%ld\n",
                                                         cmdName, (unsigned long)err, (long)g_screenOpenTraceStage);
                                                send(s, resp, (int)strlen(resp), 0);
                                                hookLog("UIWORK: sync reason=%s seq=%ld timeout err=%lu stage=%ld",
                                                        cmdName, (long)seq, (unsigned long)err,
                                                        (long)g_screenOpenTraceStage);
                                            }
                                        } else {
                                            if (!commitGdd)
                                                postPendingUiWork(cmdName);
                                            {
                                                char resp[128];
                                                snprintf(resp, sizeof(resp),
                                                         "RESP:%s armed name=%s addr=0x%08X pump=%ld\n",
                                                         cmdName,
                                                         name, (unsigned)screenAddr, (long)autoPumpCount);
                                                send(s, resp, (int)strlen(resp), 0);
                                            }
                                        }
                                        hookLog("TCP cmd: %s name=%s addr=0x%08X pump=%ld post=%s",
                                                cmdName,
                                                name,
                                                (unsigned)screenAddr,
                                                (long)autoPumpCount,
                                                commitSync ? "sync" : (commitGdd ? "gdd" : "ui"));
                                    }

                                } else if (strncmp(buf, "menupump", 8) == 0) {
                                    LONG pumpCount = 1;

                                    if (sscanf(buf + 8, "%ld", &pumpCount) != 1)
                                        pumpCount = 1;

                                    g_menuPumpCount = clampMenuPumpCount(pumpCount);
                                    g_menuPumpPending = 1;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    postPendingUiWork("menupump");
                                    hookLog("TCP cmd: menupump count=%ld", (long)g_menuPumpCount);
                                    {
                                        char resp[96];
                                        snprintf(resp, sizeof(resp),
                                            "RESP:menupump armed count=%ld\n",
                                            (long)g_menuPumpCount);
                                        send(s, resp, (int)strlen(resp), 0);
                                    }

                                } else if (strncmp(buf, "menuwrap", 8) == 0) {
                                    char targetName[64] = {0};
                                    LONG target = MENU_TARGET_NONE;
                                    LONG arg1 = 0;
                                    LONG arg2 = 0;
                                    LONG arg3 = 0;
                                    LONG arg5 = 0;
                                    LONG usePayload = strstr(buf, "payload") ? 1 : 0;
                                    LONG forceClear18 = strstr(buf, "clear18") ? 1 : 0;
                                    LONG forceClear2C = strstr(buf, "clear2c") ? 1 : 0;
                                    LONG arg5FromItem24 = strstr(buf, "a5item24") ? 1 : 0;
                                    LONG autoFlush = strstr(buf, "flush") ? 1 : 0;
                                    int parsed = sscanf(buf, "menuwrap %63s %ld %ld %ld %ld",
                                                        targetName, &arg1, &arg2, &arg3, &arg5);

                                    if (_stricmp(targetName, "singleplayer") == 0 ||
                                        _stricmp(targetName, "single-player") == 0) {
                                        target = MENU_TARGET_SINGLE_PLAYER;
                                    }

                                    if (target == MENU_TARGET_NONE || parsed < 5) {
                                        const char *resp = "RESP:menuwrap invalid target/args\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: menuwrap invalid [%s]", buf);
                                    } else {
                                        g_menuWrapTarget = target;
                                        g_menuWrapArg1 = arg1;
                                        g_menuWrapArg2 = arg2;
                                        g_menuWrapArg3 = arg3;
                                        g_menuWrapArg5 = arg5;
                                        g_menuWrapUsePayload = usePayload;
                                        g_menuWrapForceClear18 = forceClear18;
                                        g_menuWrapForceClear2C = forceClear2C;
                                        g_menuWrapArg5FromItem24 = arg5FromItem24;
                                        g_menuWrapAutoFlush = autoFlush;
                                        g_menuWrapPending = 1;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: menuwrap target=%s a1=%ld a2=%ld a3=%ld a5=%ld payload=%ld clear18=%ld clear2c=%ld a5item24=%ld flush=%ld",
                                                menuTargetName(target),
                                                (long)arg1,
                                                (long)arg2,
                                                (long)arg3,
                                                (long)arg5,
                                                (long)usePayload,
                                                (long)forceClear18,
                                                (long)forceClear2C,
                                                (long)arg5FromItem24,
                                                (long)autoFlush);
                                        {
                                            char resp[192];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:menuwrap armed target=%s a1=%ld a2=%ld a3=%ld a5=%ld payload=%ld clear18=%ld clear2c=%ld a5item24=%ld flush=%ld\n",
                                                menuTargetName(target),
                                                (long)arg1,
                                                (long)arg2,
                                                (long)arg3,
                                                (long)arg5,
                                                (long)usePayload,
                                                (long)forceClear18,
                                                (long)forceClear2C,
                                                (long)arg5FromItem24,
                                                (long)autoFlush);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }

                                } else if (strncmp(buf, "menuitemkey", 11) == 0) {
                                    char targetName[64] = {0};
                                    LONG target = MENU_TARGET_NONE;
                                    LONG arg1 = 0;
                                    LONG arg2 = 0;
                                    LONG arg3 = 0;
                                    LONG autoFlush = strstr(buf, "flush") ? 1 : 0;
                                    int parsed = sscanf(buf, "menuitemkey %63s %ld %ld %ld",
                                                        targetName, &arg1, &arg2, &arg3);

                                    if (_stricmp(targetName, "singleplayer") == 0 ||
                                        _stricmp(targetName, "single-player") == 0) {
                                        target = MENU_TARGET_SINGLE_PLAYER;
                                    }

                                    if (target == MENU_TARGET_NONE || parsed < 4) {
                                        const char *resp = "RESP:menuitemkey invalid target/args\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: menuitemkey invalid [%s]", buf);
                                    } else {
                                        g_menuItemKeyTarget = target;
                                        g_menuItemKeyArg1 = arg1;
                                        g_menuItemKeyArg2 = arg2;
                                        g_menuItemKeyArg3 = arg3;
                                        g_menuItemKeyAutoFlush = autoFlush;
                                        g_menuItemKeyPending = 1;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: menuitemkey target=%s a1=%ld a2=%ld a3=%ld flush=%ld",
                                                menuTargetName(target),
                                                (long)arg1,
                                                (long)arg2,
                                                (long)arg3,
                                                (long)autoFlush);
                                        {
                                            char resp[192];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:menuitemkey armed target=%s a1=%ld a2=%ld a3=%ld flush=%ld\n",
                                                menuTargetName(target),
                                                (long)arg1,
                                                (long)arg2,
                                                (long)arg3,
                                                (long)autoFlush);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }

                                } else if (strncmp(buf, "menuflush", 9) == 0) {
                                    char targetName[64] = {0};
                                    LONG target = MENU_TARGET_NONE;
                                    int parsed = sscanf(buf, "menuflush %63s", targetName);

                                    if (_stricmp(targetName, "singleplayer") == 0 ||
                                        _stricmp(targetName, "single-player") == 0) {
                                        target = MENU_TARGET_SINGLE_PLAYER;
                                    }

                                    if (target == MENU_TARGET_NONE || parsed < 1) {
                                        const char *resp = "RESP:menuflush invalid target\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: menuflush invalid [%s]", buf);
                                    } else {
                                        g_menuItemFlushTarget = target;
                                        g_menuItemFlushPending = 1;
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        hookLog("TCP cmd: menuflush target=%s",
                                                menuTargetName(target));
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:menuflush armed target=%s\n",
                                                menuTargetName(target));
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                    }

                                } else if (strncmp(buf, "btn", 3) == 0) {
                                    /* Button-only injection: no position change.
                                     * Tests if game's internal cursor is already at the right spot. */
                                    hookLog("TCP cmd: btn (button-only injection)");
                                    g_injClickRequested = 1;
                                    g_injFrame = 0;
                                    g_injState = INJ_BTN_ONLY;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    hookLog("TCP: btn-only injection armed");

                                } else if (strncmp(buf, "key", 3) == 0) {
                                    int dikCode = -1;
                                    if (strstr(buf, "enter")) dikCode = 0x1C;      /* DIK_RETURN */
                                    else if (strstr(buf, "space")) dikCode = 0x39; /* DIK_SPACE */
                                    else sscanf(buf + 3, "%d", &dikCode);

                                    if (!g_shm || dikCode < 0 || dikCode > 255) {
                                        const char *resp = "RESP:key invalid\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: key invalid [%s]", buf);
                                    } else {
                                        InterlockedExchange(&g_shm->done, 0);
                                        InterlockedExchange(&g_shm->frameCount, 0);
                                        InterlockedExchange(&g_shm->phase, PHASE_IDLE);
                                        InterlockedExchange(&g_shm->keyCode, dikCode);
                                        InterlockedExchange(&g_shm->cmdType, CMD_KEYPRESS);
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:key armed dik=%d\n", dikCode);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                        hookLog("TCP cmd: key DIK=%d armed", dikCode);
                                    }

                                } else if (strncmp(buf, "wmkey", 5) == 0) {
                                    int vkCode = 0;
                                    if (strstr(buf, "enter")) vkCode = VK_RETURN;
                                    else if (strstr(buf, "space")) vkCode = VK_SPACE;
                                    else sscanf(buf + 5, "%d", &vkCode);

                                    if (vkCode <= 0) {
                                        const char *resp = "RESP:wmkey invalid\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                        hookLog("TCP cmd: wmkey invalid [%s]", buf);
                                    } else {
                                        HWND hw = g_gameHwnd;
                                        if (!hw) hw = GetForegroundWindow();
                                        PostMessageA(hw, WM_KEYDOWN, (WPARAM)vkCode, 0);
                                        Sleep(100);
                                        PostMessageA(hw, WM_KEYUP, (WPARAM)vkCode, 0);
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:wmkey sent vk=%d\n", vkCode);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                        hookLog("TCP cmd: wmkey vk=%d hwnd=%p", vkCode, (void *)hw);
                                    }

                                } else if (strncmp(buf, "fire", 4) == 0) {
                                    /* Fire mouse_event from inside game process.
                                     * Uses current cursor position. */
                                    POINT pt;
                                    GetCursorPos(&pt);
                                    hookLog("TCP cmd: fire at cursor (%ld,%ld)", pt.x, pt.y);
                                    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                                    Sleep(200);
                                    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                                    hookLog("TCP: fire complete");

                                } else if (sscanf(buf, "wpclick %d %d", &cmdX, &cmdY) == 2) {
                                    /* DDraw-bypass click: sets g_bypassDDraw flag then PostMessages.
                                     * When the message arrives at hookedWndProc (on the game's main
                                     * thread), it's forwarded directly to the game's class WndProc,
                                     * skipping DDraw's WndProc which clips cursor coordinates. */
                                    HWND hw = g_gameHwnd;
                                    if (!hw) hw = GetForegroundWindow();
                                    hookLog("TCP cmd: wpclick at (%d,%d) hwnd=%p", cmdX, cmdY, (void*)hw);
                                    LPARAM lp = MAKELPARAM(cmdX, cmdY);
                                    g_bypassDDraw = 1;
                                    PostMessageA(hw, WM_MOUSEMOVE, 0, lp);
                                    Sleep(100);
                                    PostMessageA(hw, WM_LBUTTONDOWN, MK_LBUTTON, lp);
                                    Sleep(200);
                                    PostMessageA(hw, WM_LBUTTONUP, 0, lp);
                                    hookLog("TCP: wpclick complete at (%d,%d)", cmdX, cmdY);

                                } else if (sscanf(buf, "wclick %d %d", &cmdX, &cmdY) == 2) {
                                    /* Window message click: PostMessage WM_LBUTTONDOWN/UP
                                     * directly to game window with coordinates in LPARAM.
                                     * Bypasses DirectInput entirely — for title screen menus
                                     * that may process WM_ messages instead of DInput events. */
                                    HWND hw = g_gameHwnd;
                                    if (!hw) hw = GetForegroundWindow();
                                    hookLog("TCP cmd: wclick at (%d,%d) hwnd=%p", cmdX, cmdY, (void*)hw);
                                    LPARAM lp = MAKELPARAM(cmdX, cmdY);
                                    /* Send WM_MOUSEMOVE first to update internal position */
                                    PostMessageA(hw, WM_MOUSEMOVE, 0, lp);
                                    Sleep(100);
                                    PostMessageA(hw, WM_LBUTTONDOWN, MK_LBUTTON, lp);
                                    Sleep(200);
                                    PostMessageA(hw, WM_LBUTTONUP, 0, lp);
                                    hookLog("TCP: wclick complete at (%d,%d)", cmdX, cmdY);

                                } else if (sscanf(buf, "sclick %d %d", &cmdX, &cmdY) == 2) {
                                    /* SendMessage click: synchronous WM_LBUTTONDOWN/UP.
                                     * Unlike PostMessage, SendMessage processes immediately
                                     * on the target window's thread. */
                                    HWND hw = g_gameHwnd;
                                    if (!hw) hw = GetForegroundWindow();
                                    hookLog("TCP cmd: sclick at (%d,%d) hwnd=%p", cmdX, cmdY, (void*)hw);
                                    LPARAM lp = MAKELPARAM(cmdX, cmdY);
                                    SendMessageA(hw, WM_MOUSEMOVE, 0, lp);
                                    SendMessageA(hw, WM_LBUTTONDOWN, MK_LBUTTON, lp);
                                    Sleep(200);
                                    SendMessageA(hw, WM_LBUTTONUP, 0, lp);
                                    hookLog("TCP: sclick complete at (%d,%d)", cmdX, cmdY);

                                } else if (strncmp(buf, "getmousepos", 11) == 0) {
                                    /* Report last known game cursor position
                                     * (updated by GetDeviceData hook on game thread) */
                                    char out[128];
                                    snprintf(out, sizeof(out),
                                        "RESP:getmousepos x=%ld y=%ld\n",
                                        (long)g_gameMouseX, (long)g_gameMouseY);
                                    send(s, out, (int)strlen(out), 0);

                                } else if (sscanf(buf, "sinput %d %d", &cmdX, &cmdY) == 2) {
                                    /* SendInput click: goes through full Windows input pipeline.
                                     * Absolute coords, then button down/up. Should reach
                                     * DirectInput and also generate WM_ messages. */
                                    hookLog("TCP cmd: sinput click at (%d,%d)", cmdX, cmdY);
                                    INPUT inp[3];
                                    memset(inp, 0, sizeof(inp));
                                    /* Move to absolute position */
                                    inp[0].type = INPUT_MOUSE;
                                    inp[0].mi.dx = (cmdX * 65535) / 800;
                                    inp[0].mi.dy = (cmdY * 65535) / 600;
                                    inp[0].mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;
                                    /* Button down */
                                    inp[1].type = INPUT_MOUSE;
                                    inp[1].mi.dx = (cmdX * 65535) / 800;
                                    inp[1].mi.dy = (cmdY * 65535) / 600;
                                    inp[1].mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTDOWN;
                                    /* Button up */
                                    inp[2].type = INPUT_MOUSE;
                                    inp[2].mi.dx = (cmdX * 65535) / 800;
                                    inp[2].mi.dy = (cmdY * 65535) / 600;
                                    inp[2].mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTUP;
                                    UINT sent = SendInput(1, &inp[0], sizeof(INPUT)); /* move first */
                                    Sleep(100);
                                    sent += SendInput(1, &inp[1], sizeof(INPUT)); /* button down */
                                    Sleep(200);
                                    sent += SendInput(1, &inp[2], sizeof(INPUT)); /* button up */
                                    hookLog("TCP: sinput complete at (%d,%d), sent=%u events", cmdX, cmdY, sent);

                                } else if (sscanf(buf, "callwp %d %d", &cmdX, &cmdY) == 2) {
                                    /* Bypass DDraw's WndProc: call game's CLASS WndProc directly.
                                     * DDraw subclasses via SetWindowLongPtr, but the class-level
                                     * WndProc (GetClassLongPtr GCLP_WNDPROC) still points to the
                                     * game's original handler that processes WM_MOUSEMOVE for
                                     * cursor positioning. */
                                    HWND hw = g_gameHwnd;
                                    if (!hw) hw = GetForegroundWindow();
                                    WNDPROC classWp = (WNDPROC)GetClassLongPtrA(hw, GCLP_WNDPROC);
                                    WNDPROC windowWp = (WNDPROC)GetWindowLongPtrA(hw, GWLP_WNDPROC);
                                    hookLog("TCP cmd: callwp at (%d,%d) hwnd=%p classWP=%p windowWP=%p origWP=%p",
                                            cmdX, cmdY, (void*)hw, (void*)classWp, (void*)windowWp, (void*)g_origWndProc);
                                    LPARAM lp = MAKELPARAM(cmdX, cmdY);
                                    /* Call game's class WndProc directly — bypasses DDraw's subclass */
                                    if (classWp) {
                                        CallWindowProcA(classWp, hw, WM_MOUSEMOVE, 0, lp);
                                        Sleep(50);
                                        CallWindowProcA(classWp, hw, WM_LBUTTONDOWN, MK_LBUTTON, lp);
                                        Sleep(200);
                                        CallWindowProcA(classWp, hw, WM_LBUTTONUP, 0, lp);
                                    }
                                    hookLog("TCP: callwp complete at (%d,%d)", cmdX, cmdY);

                                } else if (strncmp(buf, "getwp", 5) == 0) {
                                    /* Report WndProc addresses for debugging */
                                    HWND hw = g_gameHwnd;
                                    if (!hw) hw = GetForegroundWindow();
                                    WNDPROC classWp = (WNDPROC)GetClassLongPtrA(hw, GCLP_WNDPROC);
                                    WNDPROC windowWp = (WNDPROC)GetWindowLongPtrA(hw, GWLP_WNDPROC);
                                    char out[256];
                                    snprintf(out, sizeof(out),
                                        "RESP:getwp hwnd=%p classWP=%p windowWP=%p origWP=%p\n",
                                        (void*)hw, (void*)classWp, (void*)windowWp, (void*)g_origWndProc);
                                    send(s, out, (int)strlen(out), 0);
                                    hookLog("TCP: getwp classWP=%p windowWP=%p origWP=%p",
                                            (void*)classWp, (void*)windowWp, (void*)g_origWndProc);

                                } else if (strncmp(buf, "speedup", 7) == 0) {
                                    /* Force-install event notification on mouse device
                                     * to speed up GetDeviceData polling. Creates an event,
                                     * calls SetEventNotification, starts periodic signaling. */
                                    if (g_mouseDevice && !g_mouseEventHandle) {
                                        HANDLE hEvt = CreateEventA(NULL, FALSE, FALSE, NULL);
                                        if (hEvt) {
                                            HRESULT hr2 = g_origMouseSetEventNotification
                                                ? g_origMouseSetEventNotification(g_mouseDevice, hEvt)
                                                : g_mouseDevice->lpVtbl->SetEventNotification(g_mouseDevice, hEvt);
                                            if (SUCCEEDED(hr2)) {
                                                g_mouseEventHandle = hEvt;
                                                hookLog("TCP: speedup OK — event=%p, SetEventNotification=0x%08X",
                                                        (void*)hEvt, (unsigned)hr2);
                                                /* Signal it immediately and let wake thread pulse it */
                                                SetEvent(hEvt);
                                            } else {
                                                hookLog("TCP: speedup FAILED — SetEventNotification=0x%08X",
                                                        (unsigned)hr2);
                                                CloseHandle(hEvt);
                                            }
                                        }
                                    } else if (g_mouseEventHandle) {
                                        hookLog("TCP: speedup — event already set, pulsing");
                                        SetEvent(g_mouseEventHandle);
                                    } else {
                                        hookLog("TCP: speedup — no mouse device yet");
                                    }

                                } else if (strncmp(buf, "intscan", 7) == 0) {
                                    /* Scan memory for integer value: intscan START END VALUE */
                                    unsigned int start = 0x808000, end = 0x812000, target = 0x190;
                                    sscanf(buf + 8, "%x %x %x", &start, &end, &target);
                                    char out[4096];
                                    int pos = snprintf(out, sizeof(out), "intscan 0x%X-0x%X val=0x%X:", start, end, target);
                                    int found = 0;
                                    for (unsigned int a = start; a < end && a < start + 0x20000; a += 4) {
                                        if (!IsBadReadPtr((void *)a, 4) && *(unsigned int *)a == target) {
                                            pos += snprintf(out+pos, sizeof(out)-pos, " 0x%X", a);
                                            found++;
                                            if (found >= 40 || pos > 3800) break;
                                        }
                                    }
                                    pos += snprintf(out+pos, sizeof(out)-pos, " (%d found)\n", found);
                                    send(s, out, pos, 0);

                                } else if (sscanf(buf, "move %d %d", &cmdX, &cmdY) == 2) {
                                    SetCursorPos(cmdX, cmdY);
                                    hookLog("TCP cmd: move to (%d,%d)", cmdX, cmdY);
                                } else if (strncmp(buf, "resetacc", 8) == 0) {
                                    /* Reset accumulators — for calibration */
                                    g_accumX = 0;
                                    g_accumY = 0;
                                    g_accumBtn = 0;
                                    hookLog("TCP cmd: accumulators reset");
                                } else if (strncmp(buf, "cursorinfo", 10) == 0) {
                                    /* Dump CInputLayer cursor state.
                                     * g_gameMouseX/Y are set by GetDeviceData hook on game thread. */
                                    char info[512];
                                    DWORD *pCIL = (DWORD *)0x809830;

                                    /* Dump first 64 bytes of CInputLayer */
                                    char hexbuf[256] = {0};
                                    int hp = 0;
                                    for (int i = 0; i < 16; i++)
                                        hp += snprintf(hexbuf+hp, sizeof(hexbuf)-hp, " %08X", pCIL[i]);

                                    snprintf(info, sizeof(info),
                                        "RESP:cursorinfo gmp=(%ld,%ld) accum=(%ld,%ld) "
                                        "gdd=%ld gds=%ld cilDump=%s\n",
                                        (long)g_gameMouseX, (long)g_gameMouseY,
                                        (long)g_accumX, (long)g_accumY,
                                        (long)g_getDeviceDataCallCount,
                                        (long)g_getDeviceStateCallCount,
                                        hexbuf);
                                    send(s, info, (int)strlen(info), 0);
                                    hookLog("TCP: sent cursorinfo (gmp=%ld,%ld)",
                                            (long)g_gameMouseX, (long)g_gameMouseY);
                                } else if (strncmp(buf, "readmem", 7) == 0) {
                                    /* Read game memory: readmem HEXADDR [SIZE] */
                                    unsigned int addr = 0, size = 64;
                                    sscanf(buf + 8, "%x %u", &addr, &size);
                                    if (size > 256) size = 256;
                                    /* Allow any readable address (heap, stack, globals).
                                     * Use IsBadReadPtr as safety check. */
                                    if (addr >= 0x10000 && !IsBadReadPtr((void *)addr, size)) {
                                        char out[1024];
                                        int pos = snprintf(out, sizeof(out), "MEM:0x%08X:", addr);
                                        for (unsigned int i = 0; i < size; i += 4) {
                                            pos += snprintf(out+pos, sizeof(out)-pos, " %08X",
                                                            *(unsigned int *)(addr + i));
                                        }
                                        pos += snprintf(out+pos, sizeof(out)-pos, "\n");
                                        send(s, out, pos, 0);
                                    } else {
                                        char out[128];
                                        snprintf(out, sizeof(out), "MEM:BAD_ADDR 0x%08X\n", addr);
                                        send(s, out, (int)strlen(out), 0);
                                    }
                                } else if (strncmp(buf, "forceclick ", 11) == 0) {
                                    /* Force-click via hooked GetAsyncKeyState/GetCursorPos.
                                     * Sets g_forceX/Y and g_forceClickFrames so the game's
                                     * own button hit-test code sees a click at (x,y).
                                     * Usage: forceclick X Y [frames]
                                     * Default frames=300 (~100 game frames at 3 GAS calls/frame) */
                                    int fx = 0, fy = 0, ff = 300;
                                    sscanf(buf + 11, "%d %d %d", &fx, &fy, &ff);
                                    if (ff < 10) ff = 10;
                                    if (ff > 2000) ff = 2000;
                                    g_forceX = fx;
                                    g_forceY = fy;
                                    g_forceClickFrames = ff;
                                    {
                                        char resp[128];
                                        snprintf(resp, sizeof(resp),
                                            "RESP:forceclick x=%d y=%d frames=%d\n", fx, fy, ff);
                                        send(s, resp, (int)strlen(resp), 0);
                                    }
                                    hookLog("TCP cmd: forceclick x=%d y=%d frames=%d", fx, fy, ff);

                                } else if (strncmp(buf, "pokevp ", 7) == 0) {
                                    /* VirtualProtect + poke: writable override for any page.
                                     * Usage: pokevp HEXADDR HEXVAL */
                                    unsigned int addr = 0, val = 0;
                                    sscanf(buf + 7, "%x %x", &addr, &val);
                                    if (addr >= 0x10000 && !IsBadReadPtr((void *)addr, 4)) {
                                        DWORD oldProt;
                                        VirtualProtect((void *)(addr & ~0xFFF), 0x1000, PAGE_READWRITE, &oldProt);
                                        *(unsigned int *)addr = val;
                                        VirtualProtect((void *)(addr & ~0xFFF), 0x1000, oldProt, &oldProt);
                                        {
                                            char out[128];
                                            snprintf(out, sizeof(out), "pokevp 0x%08X = 0x%08X (prot=%lu)\n",
                                                     addr, val, (unsigned long)oldProt);
                                            send(s, out, (int)strlen(out), 0);
                                        }
                                        hookLog("TCP: pokevp 0x%08X = 0x%08X (prot=%lu)", addr, val, (unsigned long)oldProt);
                                    } else {
                                        char out[128];
                                        snprintf(out, sizeof(out), "POKEVP:BAD_ADDR 0x%08X\n", addr);
                                        send(s, out, (int)strlen(out), 0);
                                    }

                                } else if (strncmp(buf, "houseselect ", 12) == 0) {
                                    /* Select a house and trigger screen transition.
                                     * Usage: houseselect <houseIdx>
                                     * Sets field_18, [0x817C0C], calls vtable[0x3C] with SEH. */
                                    int houseIdx = 0;
                                    sscanf(buf + 12, "%d", &houseIdx);
                                    {
                                        BYTE *app = (BYTE *)0x818718;
                                        LONG count = *(LONG *)(app + 0x08);
                                        LONG sel = *(LONG *)(app + 0x0C);
                                        LONG idx = (sel >= 0 && sel < count) ? sel : (count - 1);
                                        BYTE *screen = *(BYTE **)(app + (idx * 4));
                                        char out[512];
                                        int pos = 0;

                                        hookLog("HOUSESELECT: houseIdx=%d count=%ld sel=%ld idx=%ld screen=%p",
                                                houseIdx, (long)count, (long)sel, (long)idx, (void *)screen);

                                        if (!screen || IsBadReadPtr(screen, 0x20)) {
                                            pos = snprintf(out, sizeof(out), "RESP:houseselect BAD screen=%p\n", (void *)screen);
                                            send(s, out, pos, 0);
                                        } else {
                                            DWORD oldField18 = *(DWORD *)(screen + 0x18);
                                            DWORD oldGlobal = *(DWORD *)0x817C0C;
                                            DWORD vtbl = *(DWORD *)screen;
                                            DWORD selectFn = *(DWORD *)(vtbl + 0x3C);

                                            /* Set field_18 via VirtualProtect */
                                            {
                                                DWORD oldProt;
                                                VirtualProtect(screen + 0x18, 4, PAGE_READWRITE, &oldProt);
                                                *(LONG *)(screen + 0x18) = houseIdx;
                                                VirtualProtect(screen + 0x18, 4, oldProt, &oldProt);
                                                hookLog("HOUSESELECT: field_18 set %lu -> %d (prot=%lu)",
                                                        (unsigned long)oldField18, houseIdx, (unsigned long)oldProt);
                                            }

                                            /* Set [0x817C0C] if null */
                                            if (oldGlobal == 0) {
                                                *(DWORD *)0x817C0C = (DWORD)(uintptr_t)screen;
                                                hookLog("HOUSESELECT: set [0x817C0C] = %p", (void *)screen);
                                            }

                                            /* Verify writes */
                                            DWORD newField18 = *(DWORD *)(screen + 0x18);
                                            DWORD newGlobal = *(DWORD *)0x817C0C;

                                            pos = snprintf(out, sizeof(out),
                                                "RESP:houseselect idx=%d f18=%lu->%lu g=%08X->%08X fn=%08X\n",
                                                houseIdx, (unsigned long)oldField18, (unsigned long)newField18,
                                                (unsigned)oldGlobal, (unsigned)newGlobal, (unsigned)selectFn);
                                            send(s, out, pos, 0);

                                            /* Call vtable[0x3C](3).
                                             * entryIdx=3 checks field_18 for house selection.
                                             * NOTE: This runs on the TCP thread. If the game
                                             * crashes, the process dies. Use a timer for safety. */
                                            hookLog("HOUSESELECT: arming timer selectidx screen=%ld entry=3",
                                                    (long)idx);
                                            g_timerSelectIdxScreen = idx;
                                            g_timerSelectIdxEntry = 3;
                                            g_timerSelectIdxArmed = 1;
                                            if (g_gameHwnd)
                                                SetTimer(g_gameHwnd, TIMER_ID_SELECTIDX, 50, timerSelectIdxCallback);
                                            {
                                                char rok[256];
                                                int rp = snprintf(rok, sizeof(rok),
                                                    "RESP:houseselect armed idx=%d f18=%lu->%lu g=%08X->%08X timer=3\n",
                                                    houseIdx, (unsigned long)oldField18, (unsigned long)newField18,
                                                    (unsigned)oldGlobal, (unsigned)newGlobal);
                                                send(s, rok, rp, 0);
                                            }
                                        }
                                    }

                                } else if (strncmp(buf, "poke ", 5) == 0) {
                                    /* Poke game memory: poke HEXADDR HEXVAL
                                     * Like writemem but skips IsBadWritePtr — works on heap.
                                     * Uses IsBadReadPtr as a weaker safety check. */
                                    unsigned int addr = 0, val = 0;
                                    sscanf(buf + 5, "%x %x", &addr, &val);
                                    if (addr >= 0x10000 && !IsBadReadPtr((void *)addr, 4)) {
                                        DWORD oldProt;
                                        VirtualProtect((void *)(addr & ~0xFFF), 0x1000, PAGE_READWRITE, &oldProt);
                                        *(unsigned int *)addr = val;
                                        VirtualProtect((void *)(addr & ~0xFFF), 0x1000, oldProt, &oldProt);
                                        {
                                            char out[128];
                                            snprintf(out, sizeof(out), "poked 0x%08X to 0x%08X (prot=%lu)\n",
                                                     val, addr, (unsigned long)oldProt);
                                            send(s, out, (int)strlen(out), 0);
                                        }
                                        hookLog("TCP: poke 0x%08X = 0x%08X (prot=%lu)", addr, val, (unsigned long)oldProt);
                                    } else {
                                        char out[128];
                                        snprintf(out, sizeof(out), "POKE:BAD_ADDR 0x%08X\n", addr);
                                        send(s, out, (int)strlen(out), 0);
                                    }
                                } else if (strncmp(buf, "writemem", 8) == 0) {
                                    /* Write game memory: writemem HEXADDR HEXVAL */
                                    unsigned int addr = 0, val = 0;
                                    sscanf(buf + 9, "%x %x", &addr, &val);
                                    if (addr >= 0x10000 && !IsBadWritePtr((void *)addr, 4)) {
                                        DWORD oldProt;
                                        VirtualProtect((void *)addr, 4, PAGE_READWRITE, &oldProt);
                                        *(unsigned int *)addr = val;
                                        VirtualProtect((void *)addr, 4, oldProt, &oldProt);
                                        char out[128];
                                        snprintf(out, sizeof(out), "wrote 0x%08X to 0x%08X\n", val, addr);
                                        send(s, out, (int)strlen(out), 0);
                                        hookLog("TCP: writemem 0x%08X = 0x%08X", addr, val);
                                    }
                                } else if (strncmp(buf, "selectidx ", 10) == 0) {
                                    /* Select entry by index on a specific screen via SetTimer.
                                     * Calls vtable[0x3C](entryIdx) on screen[screenIdx].
                                     * Usage: selectidx <screenIdx> <entryIdx>
                                     * Example: selectidx 1 0  (select entry 0 on screen[1]) */
                                    int sidx = -1, eidx = 0;
                                    if (sscanf(buf + 10, "%d %d", &sidx, &eidx) >= 2 && g_gameHwnd) {
                                        g_timerSelectIdxScreen = sidx;
                                        g_timerSelectIdxEntry = eidx;
                                        g_timerSelectIdxArmed = 1;
                                        SetTimer(g_gameHwnd, TIMER_ID_SELECTIDX, 50, timerSelectIdxCallback);
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:selectidx armed screen=%d entry=%d\n", sidx, eidx);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                        hookLog("TCP cmd: selectidx screen=%d entry=%d", sidx, eidx);
                                    } else {
                                        const char *resp = !g_gameHwnd
                                            ? "RESP:selectidx nohwnd\n"
                                            : "RESP:selectidx badarg (usage: selectidx <screenIdx> <entryIdx>)\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                    }

                                } else if (strncmp(buf, "timernav ", 9) == 0) {
                                    /* Navigate to a screen via SetTimer callback.
                                     * Usage: timernav Campaign [screenIdx]
                                     * screenIdx: -1=use sel (default), 0=screen[0], 1=screen[1] */
                                    char name[64];
                                    int sidx = -1;
                                    memset(name, 0, sizeof(name));
                                    if (sscanf(buf + 9, "%63s %d", name, &sidx) >= 1 && g_gameHwnd) {
                                        memcpy(g_timerNavName, name, sizeof(g_timerNavName));
                                        g_timerNavName[sizeof(g_timerNavName) - 1] = 0;
                                        g_timerNavScreenIdx = sidx;
                                        g_timerNavArmed = 1;
                                        SetTimer(g_gameHwnd, TIMER_ID_NAV, 50, timerNavCallback);
                                        {
                                            char resp[160];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:timernav armed name=%s idx=%d hwnd=%p\n",
                                                name, sidx, (void *)g_gameHwnd);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                        hookLog("TCP cmd: timernav name=%s idx=%d hwnd=%p", name, sidx, (void *)g_gameHwnd);
                                    } else {
                                        const char *resp = !g_gameHwnd
                                            ? "RESP:timernav nohwnd\n"
                                            : "RESP:timernav badarg\n";
                                        send(s, resp, (int)strlen(resp), 0);
                                    }

                                } else if (strncmp(buf, "timerpop", 8) == 0) {
                                    /* Pop the top screen from the stack via SetTimer.
                                     * Removes screen[0] overlay, exposing screen[1].
                                     * Usage: timerpop */
                                    if (g_gameHwnd) {
                                        g_timerPopArmed = 1;
                                        SetTimer(g_gameHwnd, TIMER_ID_POPSCREEN, 50, timerPopScreenCallback);
                                        {
                                            char resp[128];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:timerpop armed hwnd=%p\n", (void *)g_gameHwnd);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                        hookLog("TCP cmd: timerpop hwnd=%p", (void *)g_gameHwnd);
                                    } else {
                                        send(s, "RESP:timerpop nohwnd\n", 21, 0);
                                    }

                                } else if (strncmp(buf, "timerscreen ", 12) == 0) {
                                    /* Open a screen via timer callback using prepScreen+openScreen+commitScreen.
                                     * Usage: timerscreen Campaign */
                                    char name[64];
                                    DWORD addr = 0;
                                    memset(name, 0, sizeof(name));
                                    if (sscanf(buf + 12, "%63s", name) == 1) {
                                        addr = namedScreenAddress(name);
                                    }
                                    if (addr && g_gameHwnd) {
                                        g_timerScreenAddr = addr;
                                        SetTimer(g_gameHwnd, TIMER_ID_OPENSCREEN, 50, timerOpenScreenCallback);
                                        {
                                            char resp[160];
                                            snprintf(resp, sizeof(resp),
                                                "RESP:timerscreen armed name=%s addr=0x%08X hwnd=%p\n",
                                                name, (unsigned)addr, (void *)g_gameHwnd);
                                            send(s, resp, (int)strlen(resp), 0);
                                        }
                                        hookLog("TCP cmd: timerscreen name=%s addr=0x%08X", name, (unsigned)addr);
                                    } else {
                                        char resp[128];
                                        snprintf(resp, sizeof(resp),
                                            "RESP:timerscreen failed name=%s addr=0x%08X hwnd=%d\n",
                                            name, (unsigned)addr, g_gameHwnd ? 1 : 0);
                                        send(s, resp, (int)strlen(resp), 0);
                                    }

                                } else if (strncmp(buf, "floatscan", 9) == 0) {
                                    /* Scan memory for float values in range: floatscan START END MIN MAX */
                                    unsigned int start = 0x808000, end = 0x812000;
                                    float fmin = 100.0f, fmax = 500.0f;
                                    sscanf(buf + 10, "%x %x %f %f", &start, &end, &fmin, &fmax);
                                    char out[4096];
                                    int pos = snprintf(out, sizeof(out), "floatscan 0x%X-0x%X [%.1f,%.1f]:", start, end, fmin, fmax);
                                    int found = 0;
                                    for (unsigned int a = start; a < end && a < start + 0x10000; a += 4) {
                                        float v = *(float *)a;
                                        if (v >= fmin && v <= fmax) {
                                            pos += snprintf(out+pos, sizeof(out)-pos, " 0x%X=%.2f", a, v);
                                            found++;
                                            if (found >= 30 || pos > 3800) break;
                                        }
                                    }
                                    pos += snprintf(out+pos, sizeof(out)-pos, " (%d found)\n", found);
                                    send(s, out, pos, 0);
                                } else if (strncmp(buf, "gaslog", 6) == 0) {
                                    /* Report which VK codes the game polls with GetAsyncKeyState */
                                    char out[512];
                                    int pos = 0;
                                    LONG slots = g_gasVkSlotCount;
                                    if (slots > GAS_VK_SLOTS) slots = GAS_VK_SLOTS;
                                    pos += snprintf(out+pos, sizeof(out)-pos, "RESP:gaslog slots=%ld total=%ld:",
                                                    (long)slots, (long)g_gasCallCount);
                                    for (LONG i = 0; i < slots; i++) {
                                        pos += snprintf(out+pos, sizeof(out)-pos, " vk=0x%02X(%d)x%ld",
                                                        g_gasVkCodes[i], g_gasVkCodes[i], (long)g_gasVkCounts[i]);
                                    }
                                    pos += snprintf(out+pos, sizeof(out)-pos, "\n");
                                    send(s, out, pos, 0);
                                } else if (strncmp(buf, "fulllog", 7) == 0) {
                                    /* Return last 32KB of hook log */
                                    FILE *lf = fopen("dinput-hook.log", "r");
                                    if (lf) {
                                        fseek(lf, 0, SEEK_END);
                                        long sz = ftell(lf);
                                        long start = sz > 32768 ? sz - 32768 : 0;
                                        fseek(lf, start, SEEK_SET);
                                        char logbuf[33024];
                                        int nread = (int)fread(logbuf, 1, sizeof(logbuf)-1, lf);
                                        logbuf[nread] = 0;
                                        fclose(lf);
                                        send(s, logbuf, nread, 0);
                                        hookLog("TCP: sent %d bytes of fulllog", nread);
                                    }
                                } else if (strncmp(buf, "log", 3) == 0) {
                                    /* Return last 8KB of hook log */
                                    FILE *lf = fopen("dinput-hook.log", "r");
                                    if (lf) {
                                        fseek(lf, 0, SEEK_END);
                                        long sz = ftell(lf);
                                        long start = sz > 8192 ? sz - 8192 : 0;
                                        fseek(lf, start, SEEK_SET);
                                        char logbuf[8304];
                                        int nread = (int)fread(logbuf, 1, sizeof(logbuf)-1, lf);
                                        logbuf[nread] = 0;
                                        fclose(lf);
                                        send(s, logbuf, nread, 0);
                                        hookLog("TCP: sent %d bytes of log", nread);
                                    }
                                }
                                /* "nop" or anything else = do nothing */
                            }
                        }
                        closesocket(s);
                    }
                }
            }
        }

        /* Periodically signal event handle during active injection
         * to keep the game polling GetDeviceData */
        if (g_injState != INJ_IDLE && g_injState != INJ_COMPLETE) {
            if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
        }

        Sleep(8);
    }

    hookLog("Wake thread exiting");
    return 0;
}

static void startWakeThread(void) {
    if (g_wakeThread) return;
    g_wakeThreadStop = 0;
    g_wakeThread = CreateThread(NULL, 0, wakeThreadProc, NULL, 0, NULL);
    if (g_wakeThread) {
        hookLog("Wake thread created (handle=%p)", (void*)g_wakeThread);
    } else {
        hookLog("ERROR: Failed to create wake thread: %lu", GetLastError());
    }
}

/* --- Device hook installation (shared by CreateDevice and CreateDeviceEx) --- */

static void installDeviceHooks(REFGUID rguid, LPDIRECTINPUTDEVICEA dev, const char *source) {
    void **vtable = *(void ***)dev;

    /* Install Win32 API hooks (GetAsyncKeyState, GetKeyState, GetCursorPos)
     * on first device creation. Must happen after game EXE is fully loaded. */
    installWin32Hooks();

    /* Patch game memory: set the legacy -W flag (0x808d74 = 1) so WndProc takes
     * the WM_MOUSE path instead of falling through to DefWindowProcA.
     *
     * The extracted snapshot binary also gates that same path on a second byte at
     * 0x817c6c. In the live title snapshots that dword is 0x00000100, meaning the
     * first byte is still zero even though the neighboring flag byte is set.
     * Patch both locations so WM mouse injection actually reaches the game's
     * message-side input translator. */
    {
        static int patched = 0;
        if (!patched) {
            BYTE *flagAddr = (BYTE *)0x808d74;
            BYTE *wmGateAddr = (BYTE *)0x817c6c;
            DWORD oldProt2;
            if (VirtualProtect(flagAddr, 1, PAGE_READWRITE, &oldProt2)) {
                BYTE oldVal = *flagAddr;
                *flagAddr = 1;
                VirtualProtect(flagAddr, 1, oldProt2, &oldProt2);
                hookLog("PATCH: set 0x808d74 = 1 (was %d) — WM_MOUSE processing enabled (-W flag)", oldVal);
            } else {
                hookLog("PATCH: VirtualProtect on 0x808d74 FAILED (err=%lu)", GetLastError());
            }

            if (VirtualProtect(wmGateAddr, 1, PAGE_READWRITE, &oldProt2)) {
                BYTE oldVal = *wmGateAddr;
                *wmGateAddr = 1;
                VirtualProtect(wmGateAddr, 1, oldProt2, &oldProt2);
                hookLog("PATCH: set 0x817c6c = 1 (was %d) — WndProc mouse gate enabled", oldVal);
                patched = 1;
            } else {
                hookLog("PATCH: VirtualProtect on 0x817c6c FAILED (err=%lu)", GetLastError());
            }
        }
    }

    /* PATCH 2: NOP out the input-enabled check at 0x4D36EA.
     * The function at 0x4D36C0 processes GetDeviceData mouse events.
     * It checks a flag at [this+0x1430] and skips ALL processing if 0.
     * In QEMU, this flag is never set (game init issue), so mouse input
     * is completely ignored. Patching the je to NOPs forces processing.
     * Original bytes: 0F 84 FE 02 00 00  (je +0x2FE)
     * Patched bytes:  90 90 90 90 90 90  (6x NOP) */
    {
        static int patched2 = 0;
        if (!patched2) {
            BYTE *patchAddr = (BYTE *)0x4D36EA;
            BYTE expected[] = {0x0F, 0x84, 0xFE, 0x02, 0x00, 0x00};
            DWORD oldProt3;
            if (VirtualProtect(patchAddr, 6, PAGE_EXECUTE_READWRITE, &oldProt3)) {
                /* Verify bytes before patching */
                if (memcmp(patchAddr, expected, 6) == 0) {
                    memset(patchAddr, 0x90, 6);
                    hookLog("PATCH2: NOP'd input-enabled check at 0x4D36EA (6 bytes)");
                } else {
                    hookLog("PATCH2: UNEXPECTED bytes at 0x4D36EA: %02X %02X %02X %02X %02X %02X",
                            patchAddr[0], patchAddr[1], patchAddr[2],
                            patchAddr[3], patchAddr[4], patchAddr[5]);
                }
                VirtualProtect(patchAddr, 6, oldProt3, &oldProt3);
                patched2 = 1;
            } else {
                hookLog("PATCH2: VirtualProtect on 0x4D36EA FAILED (err=%lu)", GetLastError());
            }
        }
    }

    /* PATCH 3: NOP out the sensitivity multiplier for X and Y axes.
     * At 0x4D376C: fmul dword ptr [ebp+0x10] (X axis, 3 bytes: D8 4D 10)
     * At 0x4D3783: fmul dword ptr [ebp+0x10] (Y axis, 3 bytes: D8 4D 10)
     * If sensitivity is 0.0 (uninitialized object), all mouse deltas become 0.
     * NOP'ing these makes raw DInput deltas go directly to cursor position. */
    {
        static int patched3 = 0;
        if (!patched3) {
            BYTE fmulBytes[] = {0xD8, 0x4D, 0x10};
            DWORD oldProt4;

            /* Patch X axis sensitivity */
            BYTE *xAddr = (BYTE *)0x4D376C;
            if (VirtualProtect(xAddr, 3, PAGE_EXECUTE_READWRITE, &oldProt4)) {
                if (memcmp(xAddr, fmulBytes, 3) == 0) {
                    memset(xAddr, 0x90, 3);
                    hookLog("PATCH3: NOP'd X-axis fmul at 0x4D376C");
                } else {
                    hookLog("PATCH3: UNEXPECTED X bytes: %02X %02X %02X", xAddr[0], xAddr[1], xAddr[2]);
                }
                VirtualProtect(xAddr, 3, oldProt4, &oldProt4);
            }

            /* Patch Y axis sensitivity */
            BYTE *yAddr = (BYTE *)0x4D3783;
            if (VirtualProtect(yAddr, 3, PAGE_EXECUTE_READWRITE, &oldProt4)) {
                if (memcmp(yAddr, fmulBytes, 3) == 0) {
                    memset(yAddr, 0x90, 3);
                    hookLog("PATCH3: NOP'd Y-axis fmul at 0x4D3783");
                } else {
                    hookLog("PATCH3: UNEXPECTED Y bytes: %02X %02X %02X", yAddr[0], yAddr[1], yAddr[2]);
                }
                VirtualProtect(yAddr, 3, oldProt4, &oldProt4);
            }

            patched3 = 1;
        }
    }

    if (IsEqualGUID(rguid, &GUID_SysMouse)) {
        hookLog("Mouse device created via %s — dev=%p, vtable=%p", source, (void*)dev, (void*)vtable);
        hookLog("  vtable[9] (GetDeviceState) = %p", vtable[9]);
        hookLog("  vtable[10] (GetDeviceData) = %p", vtable[10]);
        g_mouseDevice = dev;

        /* Save originals (only if not already hooked) */
        if (!g_origMouseGetDeviceState) {
            g_origMouseGetDeviceState = (GetDeviceState_t)vtable[9];
            g_origMouseGetDeviceData = (GetDeviceData_t)vtable[10];
            g_origMouseSetDataFormat = (SetDataFormat_t)vtable[11];
            g_origMouseSetEventNotification = (SetEventNotification_t)vtable[12];
            g_origMouseSetCooperativeLevel = (SetCooperativeLevel_t)vtable[13];
            g_origMouseSetProperty = (SetProperty_t)vtable[6];
        }

        /* Patch vtable entries:
         *   [6]  SetProperty     — log buffer size
         *   [9]  GetDeviceState  — inject immediate input
         *   [10] GetDeviceData   — inject buffered input
         *   [11] SetDataFormat   — log data format for debugging
         *   [12] SetEventNotification — capture event handle
         *   [13] SetCooperativeLevel  — log coop level
         */
        DWORD oldProt;
        /* Patch 6-7 (SetProperty + Acquire) */
        g_origMouseAcquire = (Acquire_t)vtable[7];
        VirtualProtect(&vtable[6], sizeof(void *) * 2, PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[6] = (void *)hookedMouseSetProperty;
        vtable[7] = (void *)hookedMouseAcquire;
        VirtualProtect(&vtable[6], sizeof(void *) * 2, oldProt, &oldProt);
        /* Patch 9-13 (contiguous range) */
        VirtualProtect(&vtable[9], sizeof(void *) * 5, PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[9] = (void *)hookedMouseGetDeviceState;
        vtable[10] = (void *)hookedMouseGetDeviceData;
        vtable[11] = (void *)hookedMouseSetDataFormat;
        vtable[12] = (void *)hookedMouseSetEventNotification;
        vtable[13] = (void *)hookedMouseSetCooperativeLevel;
        VirtualProtect(&vtable[9], sizeof(void *) * 5, oldProt, &oldProt);

        hookLog("  vtable[9] now = %p (our hook = %p)", vtable[9], (void*)hookedMouseGetDeviceState);
        hookLog("Mouse hooks installed");

        /* Start background wake thread — signals mouse event to wake game
         * when synthetic commands are pending in shared memory */
        startWakeThread();

        /* Also try QueryInterface to get ALL interface versions and patch their vtables.
         * Wine may use separate vtables for IDirectInputDeviceA vs IDirectInputDevice7A.
         * The game may call GetDeviceState through a different interface pointer. */
        {
            LPDIRECTINPUTDEVICEA devA = NULL;
            HRESULT qiHr;

            /* Try IID_IDirectInputDeviceA (base interface) */
            qiHr = dev->lpVtbl->QueryInterface(dev, &IID_IDirectInputDeviceA, (void**)&devA);
            if (SUCCEEDED(qiHr) && devA) {
                void **vtableA = *(void ***)devA;
                hookLog("  QI IDirectInputDeviceA: dev=%p, vtable=%p, vtable[9]=%p", (void*)devA, (void*)vtableA, vtableA[9]);
                if (vtableA != vtable) {
                    hookLog("  *** DIFFERENT VTABLE! Patching IDirectInputDeviceA vtable too ***");
                    if (!g_origMouseGetDeviceState || g_origMouseGetDeviceState == (GetDeviceState_t)vtable[9]) {
                        g_origMouseGetDeviceState = (GetDeviceState_t)vtableA[9];
                        g_origMouseGetDeviceData = (GetDeviceData_t)vtableA[10];
                        g_origMouseSetEventNotification = (SetEventNotification_t)vtableA[12];
                    }
                    DWORD oldProtA;
                    VirtualProtect(&vtableA[9], sizeof(void *) * 4, PAGE_EXECUTE_READWRITE, &oldProtA);
                    vtableA[9] = (void *)hookedMouseGetDeviceState;
                    vtableA[10] = (void *)hookedMouseGetDeviceData;
                    vtableA[12] = (void *)hookedMouseSetEventNotification;
                    VirtualProtect(&vtableA[9], sizeof(void *) * 4, oldProtA, &oldProtA);
                    hookLog("  IDirectInputDeviceA vtable patched");
                }
                devA->lpVtbl->Release(devA);
            }

            /* Try IID_IDirectInputDevice2A */
            LPDIRECTINPUTDEVICEA dev2A = NULL;
            qiHr = dev->lpVtbl->QueryInterface(dev, &IID_IDirectInputDevice2A, (void**)&dev2A);
            if (SUCCEEDED(qiHr) && dev2A) {
                void **vtable2A = *(void ***)dev2A;
                hookLog("  QI IDirectInputDevice2A: dev=%p, vtable=%p, vtable[9]=%p", (void*)dev2A, (void*)vtable2A, vtable2A[9]);
                if (vtable2A != vtable) {
                    hookLog("  *** DIFFERENT VTABLE! Patching IDirectInputDevice2A vtable too ***");
                    DWORD oldProt2A;
                    VirtualProtect(&vtable2A[9], sizeof(void *) * 4, PAGE_EXECUTE_READWRITE, &oldProt2A);
                    vtable2A[9] = (void *)hookedMouseGetDeviceState;
                    vtable2A[10] = (void *)hookedMouseGetDeviceData;
                    vtable2A[12] = (void *)hookedMouseSetEventNotification;
                    VirtualProtect(&vtable2A[9], sizeof(void *) * 4, oldProt2A, &oldProt2A);
                    hookLog("  IDirectInputDevice2A vtable patched");
                }
                dev2A->lpVtbl->Release(dev2A);
            }

            /* Try IID_IDirectInputDevice7A */
            LPDIRECTINPUTDEVICEA dev7A = NULL;
            qiHr = dev->lpVtbl->QueryInterface(dev, &IID_IDirectInputDevice7A, (void**)&dev7A);
            if (SUCCEEDED(qiHr) && dev7A) {
                void **vtable7A = *(void ***)dev7A;
                hookLog("  QI IDirectInputDevice7A: dev=%p, vtable=%p, vtable[9]=%p", (void*)dev7A, (void*)vtable7A, vtable7A[9]);
                if (vtable7A != vtable) {
                    hookLog("  *** DIFFERENT VTABLE! Patching IDirectInputDevice7A vtable too ***");
                    DWORD oldProt7A;
                    VirtualProtect(&vtable7A[9], sizeof(void *) * 4, PAGE_EXECUTE_READWRITE, &oldProt7A);
                    vtable7A[9] = (void *)hookedMouseGetDeviceState;
                    vtable7A[10] = (void *)hookedMouseGetDeviceData;
                    vtable7A[12] = (void *)hookedMouseSetEventNotification;
                    VirtualProtect(&vtable7A[9], sizeof(void *) * 4, oldProt7A, &oldProt7A);
                    hookLog("  IDirectInputDevice7A vtable patched");
                }
                dev7A->lpVtbl->Release(dev7A);
            }
        }
    }
    else if (IsEqualGUID(rguid, &GUID_SysKeyboard)) {
        hookLog("Keyboard device created via %s — dev=%p, vtable=%p", source, (void*)dev, (void*)vtable);
        g_keyboardDevice = dev;

        if (!g_origKeyboardGetDeviceState) {
            g_origKeyboardGetDeviceState = (GetDeviceState_t)vtable[9];
        }
        if (!g_origKbdSetCooperativeLevel) {
            g_origKbdSetCooperativeLevel = (SetCooperativeLevel_t)vtable[13];
        }

        DWORD oldProt;
        /* Patch GetDeviceState [9] and SetCooperativeLevel [13] */
        VirtualProtect(&vtable[9], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[9] = (void *)hookedKeyboardGetDeviceState;
        VirtualProtect(&vtable[9], sizeof(void *), oldProt, &oldProt);

        VirtualProtect(&vtable[13], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[13] = (void *)hookedKbdSetCooperativeLevel;
        VirtualProtect(&vtable[13], sizeof(void *), oldProt, &oldProt);

        hookLog("Keyboard hooks installed (GetDeviceState + SetCooperativeLevel)");

        /* Also patch all interface versions like we do for mouse */
        {
            LPDIRECTINPUTDEVICEA devA = NULL;
            if (SUCCEEDED(dev->lpVtbl->QueryInterface(dev, &IID_IDirectInputDeviceA, (void**)&devA)) && devA) {
                void **vtableA = *(void ***)devA;
                if (vtableA != *(void ***)dev) {
                    hookLog("  Patching IDirectInputDeviceA keyboard vtable too");
                    DWORD oldProtA;
                    VirtualProtect(&vtableA[9], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProtA);
                    vtableA[9] = (void *)hookedKeyboardGetDeviceState;
                    VirtualProtect(&vtableA[9], sizeof(void *), oldProtA, &oldProtA);
                    VirtualProtect(&vtableA[13], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProtA);
                    vtableA[13] = (void *)hookedKbdSetCooperativeLevel;
                    VirtualProtect(&vtableA[13], sizeof(void *), oldProtA, &oldProtA);
                }
                devA->lpVtbl->Release(devA);
            }
        }
    }
    else {
        hookLog("Unknown device created via %s (GUID not mouse/keyboard)", source);
    }
}

/* --- Hooked CreateDevice (vtable[3]) --- */

static HRESULT WINAPI hookedCreateDevice(
    LPDIRECTINPUTA self, REFGUID rguid,
    LPDIRECTINPUTDEVICEA *lplpDirectInputDevice,
    LPUNKNOWN pUnkOuter
) {
    HRESULT hr = g_origCreateDevice(self, rguid, lplpDirectInputDevice, pUnkOuter);
    if (FAILED(hr) || !lplpDirectInputDevice || !*lplpDirectInputDevice)
        return hr;

    installDeviceHooks(rguid, *lplpDirectInputDevice, "CreateDevice");
    return hr;
}

/* --- Hooked CreateDeviceEx (vtable[9] on IDirectInput7A) --- */

static HRESULT WINAPI hookedCreateDeviceEx(
    LPDIRECTINPUTA self, REFGUID rguid, REFIID riid,
    LPVOID *ppvOut, LPUNKNOWN pUnkOuter
) {
    HRESULT hr = g_origCreateDeviceEx(self, rguid, riid, ppvOut, pUnkOuter);
    if (FAILED(hr) || !ppvOut || !*ppvOut)
        return hr;

    installDeviceHooks(rguid, (LPDIRECTINPUTDEVICEA)*ppvOut, "CreateDeviceEx");
    return hr;
}

/* --- Exported DirectInputCreateEx (the only export) --- */

typedef HRESULT (WINAPI *DirectInputCreateEx_t)(
    HINSTANCE hinst, DWORD dwVersion, REFIID riidltf,
    LPVOID *ppvOut, LPUNKNOWN pUnkOuter
);

HRESULT WINAPI DirectInputCreateEx(
    HINSTANCE hinst, DWORD dwVersion, REFIID riidltf,
    LPVOID *ppvOut, LPUNKNOWN pUnkOuter
) {
    hookLog("=== DirectInputCreateEx intercepted (version 0x%08X) ===", dwVersion);

    /* Load Wine's real dinput implementation from "wdinput7.dll" — a copy of
     * Wine's 32-bit builtin placed alongside our proxy in the game directory.
     * The different name avoids WINEDLLOVERRIDES="dinput=n" and LoadLibrary
     * recursion. Unlike system32 PE stubs, this is the actual PE implementation
     * copied from Wine's i386-windows/ lib directory. */
    if (!g_realDInput) {
        g_realDInput = LoadLibraryA("wdinput7.dll");
        if (!g_realDInput) {
            hookLog("FATAL: Cannot load wdinput7.dll: %lu (is it in the game dir?)", GetLastError());
            return DIERR_GENERIC;
        }
        hookLog("Loaded real dinput from wdinput7.dll");
    }

    /* Get real DirectInputCreateEx */
    DirectInputCreateEx_t realCreate = (DirectInputCreateEx_t)
        GetProcAddress(g_realDInput, "DirectInputCreateEx");
    if (!realCreate) {
        hookLog("FATAL: DirectInputCreateEx not found in dinput_real.dll");
        return DIERR_GENERIC;
    }

    /* Call real implementation */
    HRESULT hr = realCreate(hinst, dwVersion, riidltf, ppvOut, pUnkOuter);
    if (FAILED(hr)) {
        hookLog("Real DirectInputCreateEx failed: 0x%08X", hr);
        return hr;
    }

    hookLog("Real DirectInputCreateEx succeeded");

    /* Set up shared memory for IPC */
    if (!g_shm) {
        setupSharedMemory();
    }

    /* Hook both CreateDevice (vtable[3]) and CreateDeviceEx (vtable[9]).
     * IDirectInput7A vtable layout:
     *   [0] QueryInterface  [1] AddRef  [2] Release
     *   [3] CreateDevice    [4] EnumDevices  [5] GetDeviceStatus
     *   [6] RunControlPanel [7] Initialize
     *   [8] FindDevice (IDirectInput2A)
     *   [9] CreateDeviceEx (IDirectInput7A)
     * Emperor: BfD uses DInput7 and calls CreateDeviceEx, not CreateDevice.
     * We hook both for robustness. */
    LPDIRECTINPUTA dinput = (LPDIRECTINPUTA)*ppvOut;
    void **vtable = *(void ***)dinput;

    g_origCreateDevice = (CreateDevice_t)vtable[3];
    g_origCreateDeviceEx = (CreateDeviceEx_t)vtable[9];

    DWORD oldProt;
    VirtualProtect(&vtable[3], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
    vtable[3] = (void *)hookedCreateDevice;
    VirtualProtect(&vtable[3], sizeof(void *), oldProt, &oldProt);

    VirtualProtect(&vtable[9], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
    vtable[9] = (void *)hookedCreateDeviceEx;
    VirtualProtect(&vtable[9], sizeof(void *), oldProt, &oldProt);

    hookLog("CreateDevice (vtable[3]) and CreateDeviceEx (vtable[9]) hooks installed");
    return hr;
}

/* --- Exported DirectInputCreateA (some games use this instead of Ex) --- */

typedef HRESULT (WINAPI *DirectInputCreateA_t)(
    HINSTANCE hinst, DWORD dwVersion,
    LPDIRECTINPUTA *ppDI, LPUNKNOWN pUnkOuter
);

HRESULT WINAPI DirectInputCreateA(
    HINSTANCE hinst, DWORD dwVersion,
    LPDIRECTINPUTA *ppDI, LPUNKNOWN pUnkOuter
) {
    hookLog("=== DirectInputCreateA intercepted (version 0x%08X) ===", dwVersion);

    if (!g_realDInput) {
        g_realDInput = LoadLibraryA("wdinput7.dll");
        if (!g_realDInput) {
            hookLog("FATAL: Cannot load wdinput7.dll: %lu", GetLastError());
            return DIERR_GENERIC;
        }
        hookLog("Loaded real dinput from wdinput7.dll");
    }

    DirectInputCreateA_t realCreate = (DirectInputCreateA_t)
        GetProcAddress(g_realDInput, "DirectInputCreateA");
    if (!realCreate) {
        hookLog("FATAL: DirectInputCreateA not found in wdinput7.dll");
        return DIERR_GENERIC;
    }

    HRESULT hr = realCreate(hinst, dwVersion, ppDI, pUnkOuter);
    if (FAILED(hr)) {
        hookLog("Real DirectInputCreateA failed: 0x%08X", hr);
        return hr;
    }

    hookLog("Real DirectInputCreateA succeeded — upgrading to DInput7 for hook");

    if (!g_shm) {
        setupSharedMemory();
    }

    /* DirectInputCreateA returns IDirectInputA (version 1).
     * We need to QI up to IDirectInput7A to hook CreateDeviceEx.
     * But we can still hook CreateDevice (vtable[3]) on the base interface. */
    LPDIRECTINPUTA dinput = *ppDI;
    void **vtable = *(void ***)dinput;

    g_origCreateDevice = (CreateDevice_t)vtable[3];

    DWORD oldProt;
    VirtualProtect(&vtable[3], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
    vtable[3] = (void *)hookedCreateDevice;
    VirtualProtect(&vtable[3], sizeof(void *), oldProt, &oldProt);

    /* Try to QI up to IDirectInput7A and hook CreateDeviceEx too */
    {
        LPDIRECTINPUTA di7 = NULL;
        HRESULT qiHr = dinput->lpVtbl->QueryInterface(dinput, &IID_IDirectInput7A, (void**)&di7);
        if (SUCCEEDED(qiHr) && di7) {
            void **vtable7 = *(void ***)di7;
            if (vtable7 != vtable) {
                g_origCreateDeviceEx = (CreateDeviceEx_t)vtable7[9];
                VirtualProtect(&vtable7[9], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
                vtable7[9] = (void *)hookedCreateDeviceEx;
                VirtualProtect(&vtable7[9], sizeof(void *), oldProt, &oldProt);

                /* Also hook CreateDevice on this vtable */
                if (!g_origCreateDevice) g_origCreateDevice = (CreateDevice_t)vtable7[3];
                VirtualProtect(&vtable7[3], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
                vtable7[3] = (void *)hookedCreateDevice;
                VirtualProtect(&vtable7[3], sizeof(void *), oldProt, &oldProt);

                hookLog("Also hooked IDirectInput7A vtable (CreateDevice + CreateDeviceEx)");
            }
            di7->lpVtbl->Release(di7);
        } else {
            hookLog("QI to IDirectInput7A failed (hr=0x%08X) — only CreateDevice hooked", qiHr);
        }
    }

    hookLog("CreateDevice hook installed via DirectInputCreateA path");
    return hr;
}

/* --- Forwarded exports ---
 * Real dinput.dll exports 7 functions. We must export them all or the
 * PE loader will reject our proxy (unresolved imports in the game or
 * its dependencies). Forward COM infrastructure functions to the real DLL. */

static HMODULE ensureRealDInput(void) {
    if (!g_realDInput) {
        g_realDInput = LoadLibraryA("wdinput7.dll");
        if (!g_realDInput)
            hookLog("FATAL: Cannot load wdinput7.dll: %lu", GetLastError());
    }
    return g_realDInput;
}

typedef HRESULT (WINAPI *DirectInputCreateW_t)(HINSTANCE, DWORD, LPVOID*, LPUNKNOWN);

HRESULT WINAPI DirectInputCreateW(
    HINSTANCE hinst, DWORD dwVersion, LPVOID *ppDI, LPUNKNOWN pUnkOuter
) {
    hookLog("DirectInputCreateW intercepted (forwarding)");
    HMODULE real = ensureRealDInput();
    if (!real) return DIERR_GENERIC;
    DirectInputCreateW_t fn = (DirectInputCreateW_t)GetProcAddress(real, "DirectInputCreateW");
    if (!fn) return DIERR_GENERIC;
    return fn(hinst, dwVersion, ppDI, pUnkOuter);
}

HRESULT WINAPI DllCanUnloadNow(void) {
    HMODULE real = ensureRealDInput();
    if (real) {
        typedef HRESULT (WINAPI *Fn)(void);
        Fn fn = (Fn)GetProcAddress(real, "DllCanUnloadNow");
        if (fn) return fn();
    }
    return S_FALSE;
}

HRESULT WINAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, LPVOID *ppv) {
    HMODULE real = ensureRealDInput();
    if (real) {
        typedef HRESULT (WINAPI *Fn)(REFCLSID, REFIID, LPVOID*);
        Fn fn = (Fn)GetProcAddress(real, "DllGetClassObject");
        if (fn) return fn(rclsid, riid, ppv);
    }
    return CLASS_E_CLASSNOTAVAILABLE;
}

HRESULT WINAPI DllRegisterServer(void) { return S_OK; }
HRESULT WINAPI DllUnregisterServer(void) { return S_OK; }

/* --- DllMain --- */

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    switch (fdwReason) {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hinstDLL);
        if (g_logFile) {
            fclose(g_logFile);
            g_logFile = NULL;
        }
        g_logFile = fopen("dinput-hook.log", "w");
        hookLog("=== dinput-hook.dll loaded into process ===");
        break;

    case DLL_PROCESS_DETACH:
        hookLog("=== dinput-hook.dll unloading ===");
        disarmMenuWatchpoint("detach");
        if (g_menuWatchVehHandle) {
            RemoveVectoredExceptionHandler(g_menuWatchVehHandle);
            g_menuWatchVehHandle = NULL;
        }
        /* Stop wake thread */
        if (g_wakeThread) {
            InterlockedExchange(&g_wakeThreadStop, 1);
            WaitForSingleObject(g_wakeThread, 500);
            CloseHandle(g_wakeThread);
            g_wakeThread = NULL;
        }
        if (g_shm) {
            UnmapViewOfFile((LPVOID)g_shm);
            g_shm = NULL;
        }
        if (g_shmHandle) {
            CloseHandle(g_shmHandle);
            g_shmHandle = NULL;
        }
        if (g_realDInput) {
            FreeLibrary(g_realDInput);
            g_realDInput = NULL;
        }
        if (g_logFile) {
            fclose(g_logFile);
            g_logFile = NULL;
        }
        break;
    }
    return TRUE;
}
