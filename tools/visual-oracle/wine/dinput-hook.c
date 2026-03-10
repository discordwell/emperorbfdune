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

/* Saved device pointers for identifying mouse vs keyboard in GetDeviceState */
static LPDIRECTINPUTDEVICEA g_mouseDevice = NULL;
static LPDIRECTINPUTDEVICEA g_keyboardDevice = NULL;

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
    INJ_COMPLETE    /* Injection done, ready for next command */
} InjectState;

static volatile InjectState g_injState = INJ_IDLE;
static volatile int g_injTargetX = 0;
static volatile int g_injTargetY = 0;
static volatile int g_injFrame = 0;
static volatile int g_injClickRequested = 1;  /* 1=click after move, 0=move only */

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
                hookLog("INJ/GDS: button DOWN");
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

#define DINPUT7_OBJECTDATA_SIZE 16

/* Write a single DInput7 event into the buffer at the given pointer.
 * Layout: dwOfs(4) + dwData(4) + dwTimeStamp(4) + dwSequence(4) = 16 bytes */
static void writeInjEvent(BYTE *buf, DWORD dwOfs, DWORD dwData) {
    *(DWORD *)(buf + 0)  = dwOfs;
    *(DWORD *)(buf + 4)  = dwData;
    *(DWORD *)(buf + 8)  = GetTickCount();
    *(DWORD *)(buf + 12) = g_injectSequence++;
}

static HRESULT WINAPI hookedMouseGetDeviceData(
    LPDIRECTINPUTDEVICEA self, DWORD cbObjectData,
    LPDIDEVICEOBJECTDATA rgdod, LPDWORD pdwInOut, DWORD dwFlags
) {
    /* Save buffer capacity BEFORE calling original (it overwrites pdwInOut) */
    DWORD savedCapacity = (pdwInOut && rgdod) ? *pdwInOut : 0;

    HRESULT hr = g_origMouseGetDeviceData(self, cbObjectData, rgdod, pdwInOut, dwFlags);

    LONG count = InterlockedIncrement(&g_getDeviceDataCallCount);
    DWORD realEvents = pdwInOut ? *pdwInOut : 0;

    /* Log periodically and when events arrive */
    if (count == 1 || (count % 1000 == 0) || realEvents > 0) {
        hookLog("GetDeviceData #%ld: events=%lu cbObj=%lu hr=0x%08X",
                count, (unsigned long)realEvents, (unsigned long)cbObjectData, (unsigned)hr);
        if (realEvents > 0 && rgdod && cbObjectData >= DINPUT7_OBJECTDATA_SIZE) {
            for (DWORD i = 0; i < realEvents && i < 4; i++) {
                BYTE *ev = (BYTE *)rgdod + (i * cbObjectData);
                hookLog("  real[%lu]: ofs=%lu data=%ld", (unsigned long)i,
                        (unsigned long)*(DWORD*)(ev+0), (long)(int)*(DWORD*)(ev+4));
            }
        }
    }

    /* --- Direct buffer injection --- */
    if (g_injState == INJ_IDLE || g_injState == INJ_COMPLETE)
        return hr;
    if (!rgdod || !pdwInOut || cbObjectData < DINPUT7_OBJECTDATA_SIZE)
        return hr;
    if (dwFlags & 0x1) /* DIGDD_PEEK — don't inject on peek calls */
        return hr;

    DWORD used = *pdwInOut;
    DWORD room = savedCapacity > used ? savedCapacity - used : 0;
    BYTE *writePtr = (BYTE *)rgdod + (used * cbObjectData);
    DWORD added = 0;

    switch (g_injState) {
    case INJ_RESET:
        /* Send large negative deltas to slam cursor to (0,0).
         * Repeat for 3 frames to ensure the game processes it. */
        if (room >= 2) {
            writeInjEvent(writePtr, 0, (DWORD)(int)-800);  /* X = -800 */
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)-600);  /* Y = -600 */
            added = 2;
        }
        g_injFrame++;
        if (g_injFrame >= 3) {
            g_injState = INJ_MOVE;
            g_injFrame = 0;
            hookLog("INJ: reset done (3 frames of -800,-600), moving to target (%d,%d)",
                    g_injTargetX, g_injTargetY);
        }
        break;

    case INJ_MOVE:
        /* Send exact delta to target position.
         * After reset, game cursor is at (0,0). This delta lands on target. */
        if (room >= 2) {
            writeInjEvent(writePtr, 0, (DWORD)(int)g_injTargetX);
            writePtr += cbObjectData;
            writeInjEvent(writePtr, 4, (DWORD)(int)g_injTargetY);
            added = 2;
        }
        g_injState = INJ_SETTLE;
        g_injFrame = 0;
        hookLog("INJ: move event injected (dx=%d, dy=%d)", g_injTargetX, g_injTargetY);
        break;

    case INJ_SETTLE:
        /* No events — let game process the movement and detect hover */
        g_injFrame++;
        if (g_injFrame >= 8) {
            if (g_injClickRequested) {
                g_injState = INJ_BTN_DOWN;
            } else {
                g_injState = INJ_COMPLETE;
            }
            g_injFrame = 0;
            hookLog("INJ: settle done (%d frames)", 8);
        }
        break;

    case INJ_BTN_DOWN:
        if (room >= 1) {
            writeInjEvent(writePtr, 12, 0x80);  /* Button 0 down */
            added = 1;
        }
        g_injState = INJ_BTN_HOLD;
        g_injFrame = 0;
        hookLog("INJ: button DOWN injected");
        break;

    case INJ_BTN_HOLD:
        g_injFrame++;
        if (g_injFrame >= 4) {
            g_injState = INJ_BTN_UP;
            g_injFrame = 0;
        }
        break;

    case INJ_BTN_UP:
        if (room >= 1) {
            writeInjEvent(writePtr, 12, 0x00);  /* Button 0 up */
            added = 1;
        }
        g_injState = INJ_COMPLETE;
        hookLog("INJ: button UP injected — click sequence COMPLETE");
        break;

    default:
        break;
    }

    if (added > 0) {
        *pdwInOut = used + added;
        /* Also signal the event handle to keep the game polling */
        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
    }

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

/* Capture game's hwnd for direct message injection */
static HWND g_gameHwnd = NULL;

/* Forward declarations for WndProc hook (defined later) */
static WNDPROC g_origWndProc;
static LRESULT CALLBACK hookedWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

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

    /* Force NON-EXCLUSIVE + BACKGROUND mode for synthetic input injection.
     * EXCLUSIVE mode: Wine captures mouse at OS level, all synthetic APIs bypassed.
     * FOREGROUND mode: DInput stops working when Wine loses macOS foreground.
     * NON-EXCLUSIVE + BACKGROUND: DInput reads from message queue and works
     * even when Wine isn't frontmost. mouse_event() generates events that
     * DInput picks up regardless of focus state. */
    dwFlags = DISCL_NONEXCLUSIVE | DISCL_BACKGROUND;

    hookLog("SetCooperativeLevel: hwnd=%p, origFlags=0x%lX → newFlags=0x%lX (forced NONEXCL)",
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
            hookLog("WndProc: msg=0x%04X (%s) x=%d y=%d wParam=0x%lX [#%ld]",
                    msg,
                    msg == WM_MOUSEMOVE ? "MOUSEMOVE" :
                    msg == WM_LBUTTONDOWN ? "LBUTTONDOWN" :
                    msg == WM_LBUTTONUP ? "LBUTTONUP" : "?",
                    x, y, (unsigned long)wParam, c);
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

        /* TCP command polling: connect to host 10.0.2.2:18890, send "poll\n",
         * receive "click X Y\n" or "none\n". Uses raw Winsock (no WinInet)
         * to avoid focus-stealing that WinInet causes. */
        {
            static DWORD lastTcpCheck = 0;
            static int wsaInited = 0;
            DWORD now = GetTickCount();
            if (now - lastTcpCheck > 2000) {
                lastTcpCheck = now;

                if (!wsaInited) {
                    WSADATA wsa;
                    if (WSAStartup(MAKEWORD(2,2), &wsa) == 0)
                        wsaInited = 1;
                }

                if (wsaInited) {
                    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
                    if (s != INVALID_SOCKET) {
                        /* Non-blocking connect with short timeout */
                        struct sockaddr_in addr;
                        addr.sin_family = AF_INET;
                        addr.sin_port = htons(18890);
                        addr.sin_addr.s_addr = inet_addr("10.0.2.2");

                        /* Set socket timeout to 1 second */
                        DWORD timeout = 1000;
                        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (char*)&timeout, sizeof(timeout));
                        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (char*)&timeout, sizeof(timeout));

                        if (connect(s, (struct sockaddr*)&addr, sizeof(addr)) == 0) {
                            send(s, "poll\n", 5, 0);
                            char buf[256] = {0};
                            int n = recv(s, buf, sizeof(buf) - 1, 0);
                            if (n > 0) {
                                buf[n] = 0;
                                int cmdX = 0, cmdY = 0;
                                if (sscanf(buf, "click %d %d", &cmdX, &cmdY) == 2) {
                                    hookLog("TCP cmd: click at (%d,%d)", cmdX, cmdY);

                                    /* Direct buffer injection into GetDeviceData */
                                    g_injTargetX = cmdX;
                                    g_injTargetY = cmdY;
                                    g_injClickRequested = 1;
                                    g_injFrame = 0;
                                    g_injState = INJ_RESET;
                                    hookLog("TCP: started injection to (%d,%d)", cmdX, cmdY);

                                    if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);

                                    /* Wait for injection to complete */
                                    for (int w = 0; w < 60; w++) {
                                        Sleep(500);
                                        if (g_mouseEventHandle) SetEvent(g_mouseEventHandle);
                                        if (g_injState == INJ_COMPLETE) break;
                                    }
                                    hookLog("TCP: injection %s (state=%d)",
                                            g_injState == INJ_COMPLETE ? "COMPLETE" : "TIMEOUT",
                                            (int)g_injState);
                                }
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
        /* Patch 6 */
        VirtualProtect(&vtable[6], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[6] = (void *)hookedMouseSetProperty;
        VirtualProtect(&vtable[6], sizeof(void *), oldProt, &oldProt);
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
