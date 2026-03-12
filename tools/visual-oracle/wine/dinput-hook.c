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

static void hookLog(const char *fmt, ...) {
    if (!g_logFile) {
        g_logFile = fopen("dinput-hook.log", "a");
        if (!g_logFile) return;
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
    INJ_CLICK2_UP    /* click2: btn_up in call 2 */
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

static SHORT WINAPI hookedGetAsyncKeyState(int vKey) {
    LONG c = InterlockedIncrement(&g_gasCallCount);
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

    hookLog("Win32 API hooks installed (GetAsyncKeyState=%s, GetKeyState=%s, GetCursorPos=%s)",
            g_origGetAsyncKeyState ? "YES(hooked)" : "NO",
            g_origGetKeyState ? "YES(hooked)" : "NO",
            g_origGetCursorPos ? "YES" : "NO");
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

    case INJ_BTN_DOWN:
        /* Button down WITH position events — game may require position data
         * in the same GetDeviceData buffer as button events to register a click.
         * Inject: [dx=0, dy=0, btn_down] to confirm cursor position + click. */
        if (savedCapacity >= 3) {
            writeInjEvent(writePtr, 0, 0);       /* X delta = 0 (no movement) */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, 0);       /* Y delta = 0 (no movement) */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 12, 0x80);   /* Button 0 down */
            added = 3;
            g_injState = INJ_BTN_HOLD;
            g_injFrame = 0;
            hookLog("INJ/GDD v9: BTN_DOWN [dx=0,dy=0,btn=0x80] at (%d,%d) "
                    "[suppressed %lu real] → next: BTN_HOLD",
                    g_injTargetX, g_injTargetY, (unsigned long)realEvents);

            /* WM messages during injection REMOVED — caused modal drag loop
             * that blocked the game's main loop (gdd stops incrementing). */
        }
        break;

    case INJ_BTN_UP:
        /* Button up WITH position events (matching BTN_DOWN pattern). */
        if (savedCapacity >= 3) {
            writeInjEvent(writePtr, 0, 0);       /* X delta = 0 */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, 0);       /* Y delta = 0 */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 12, 0x00);   /* Button 0 up */
            added = 3;
            g_injState = INJ_COMPLETE;
            hookLog("INJ/GDD v9: BTN_UP [dx=0,dy=0,btn=0x00] → COMPLETE at (%d,%d) "
                    "[suppressed %lu real]",
                    g_injTargetX, g_injTargetY, (unsigned long)realEvents);

            /* WM_LBUTTONUP during injection REMOVED — caused stall. */
        }
        break;

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
            if (g_injClickRequested) {
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

    default:
        hookLog("INJ/GDD v7: unexpected state=%d, suppressing %lu real events",
                (int)g_injState, (unsigned long)realEvents);
        break;
    }

    *pdwInOut = added;

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

        /* TCP command polling: connect to host 10.0.2.2:18890, send status,
         * receive "click X Y\n" or "nop\n". NON-BLOCKING: just set state
         * variables and return. The actual injection happens in GetDeviceState
         * on the game's main thread. */
        /* Pulse mouse event handle when injection is pending —
         * this wakes the game's input polling so GDD fires faster */
        if (g_mouseEventHandle && g_injState != INJ_IDLE && g_injState != INJ_COMPLETE) {
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
                        addr.sin_addr.s_addr = inet_addr("10.0.2.2");

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
                            char pollMsg[512];
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
                                "poll state=%d gds=%ld gdd=%ld kbd=%ld gas=%ld gcp=%ld cur=%ld,%ld hwnd=%d evt=%d ax=%ld ay=%ld ab=%ld ci=%.1f,%.1f hr=0x%08X re=%lu rq=%ld ra=0x%08X md=%p eb=0x%08X\n",
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
                                (unsigned)g_callerEBP);
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

                                } else if (strncmp(buf, "btn", 3) == 0) {
                                    /* Button-only injection: no position change.
                                     * Tests if game's internal cursor is already at the right spot. */
                                    hookLog("TCP cmd: btn (button-only injection)");
                                    g_injClickRequested = 1;
                                    g_injFrame = 0;
                                    g_injState = INJ_BTN_ONLY;
                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                    hookLog("TCP: btn-only injection armed");

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
                                } else if (strncmp(buf, "writemem", 8) == 0) {
                                    /* Write game memory: writemem HEXADDR HEXVAL */
                                    unsigned int addr = 0, val = 0;
                                    sscanf(buf + 9, "%x %x", &addr, &val);
                                    if (addr >= 0x400000 && addr < 0x900000) {
                                        DWORD oldProt;
                                        VirtualProtect((void *)addr, 4, PAGE_READWRITE, &oldProt);
                                        *(unsigned int *)addr = val;
                                        VirtualProtect((void *)addr, 4, oldProt, &oldProt);
                                        char out[128];
                                        snprintf(out, sizeof(out), "wrote 0x%08X to 0x%08X\n", val, addr);
                                        send(s, out, (int)strlen(out), 0);
                                        hookLog("TCP: writemem 0x%08X = 0x%08X", addr, val);
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
                                } else if (strncmp(buf, "fulllog", 7) == 0) {
                                    /* Return last 8KB of hook log */
                                    FILE *lf = fopen("dinput-hook.log", "r");
                                    if (lf) {
                                        fseek(lf, 0, SEEK_END);
                                        long sz = ftell(lf);
                                        long start = sz > 8192 ? sz - 8192 : 0;
                                        fseek(lf, start, SEEK_SET);
                                        char logbuf[8300];
                                        int nread = (int)fread(logbuf, 1, sizeof(logbuf)-1, lf);
                                        logbuf[nread] = 0;
                                        fclose(lf);
                                        send(s, logbuf, nread, 0);
                                        hookLog("TCP: sent %d bytes of fulllog", nread);
                                    }
                                } else if (strncmp(buf, "log", 3) == 0) {
                                    /* Return last 2KB of hook log */
                                    FILE *lf = fopen("dinput-hook.log", "r");
                                    if (lf) {
                                        fseek(lf, 0, SEEK_END);
                                        long sz = ftell(lf);
                                        long start = sz > 2048 ? sz - 2048 : 0;
                                        fseek(lf, start, SEEK_SET);
                                        char logbuf[2100];
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

    /* Patch game memory: set the -W flag (0x808d74 = 1) so WndProc processes
     * WM_MOUSE messages instead of passing them to DefWindowProcA.
     * Without this, PostMessage WM_LBUTTONDOWN is silently ignored.
     * This is equivalent to launching GAME.EXE with the -W command-line flag. */
    {
        static int patched = 0;
        if (!patched) {
            BYTE *flagAddr = (BYTE *)0x808d74;
            DWORD oldProt2;
            if (VirtualProtect(flagAddr, 1, PAGE_READWRITE, &oldProt2)) {
                BYTE oldVal = *flagAddr;
                *flagAddr = 1;
                VirtualProtect(flagAddr, 1, oldProt2, &oldProt2);
                hookLog("PATCH: set 0x808d74 = 1 (was %d) — WM_MOUSE processing enabled (-W flag)", oldVal);
                patched = 1;
            } else {
                hookLog("PATCH: VirtualProtect on 0x808d74 FAILED (err=%lu)", GetLastError());
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
        hookLog("=== dinput-hook.dll loaded into process ===");
        break;

    case DLL_PROCESS_DETACH:
        hookLog("=== dinput-hook.dll unloading ===");
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
