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

#define WIN32_LEAN_AND_MEAN
#define CINTERFACE
#define COBJMACROS
#define INITGUID

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
        g_logFile = fopen("C:\\Westwood\\Emperor\\dinput-hook.log", "a");
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

/* --- Hooked GetDeviceState for MOUSE --- */

static volatile LONG g_getDeviceStateCallCount = 0;
static volatile LONG g_lastLoggedCallCount = 0;

static HRESULT WINAPI hookedMouseGetDeviceState(
    LPDIRECTINPUTDEVICEA self, DWORD cbData, LPVOID lpvData
) {
    /* Mouse commands now go through mouse_event() in the wake thread
     * (NON-EXCLUSIVE mode reads from normal message queue).
     * GetDeviceState is just a passthrough with diagnostics. */
    HRESULT hr = g_origMouseGetDeviceState(self, cbData, lpvData);

    LONG count = InterlockedIncrement(&g_getDeviceStateCallCount);
    if (count == 1 || (count % 1000 == 0)) {
        hookLog("Mouse GetDeviceState (count=%ld, cbData=%lu)", count, (unsigned long)cbData);
    }

    return hr;
}

/* --- Hooked GetDeviceState for KEYBOARD --- */

static HRESULT WINAPI hookedKeyboardGetDeviceState(
    LPDIRECTINPUTDEVICEA self, DWORD cbData, LPVOID lpvData
) {
    HRESULT hr = g_origKeyboardGetDeviceState(self, cbData, lpvData);

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

/* --- Hooked GetDeviceData for MOUSE (buffered mode fallback) --- */

static volatile LONG g_getDeviceDataCallCount = 0;

/* Sequence counter for injected events */
static DWORD g_injectSequence = 1000000;

/* DIMOFS_X, DIMOFS_Y, DIMOFS_Z, DIMOFS_BUTTON0, DIMOFS_BUTTON1
 * are defined in <dinput.h> — used as dwOfs in DIDEVICEOBJECTDATA events.
 *
 * mingw's <dinput.h> defines DIDEVICEOBJECTDATA with a 5th field (uAppData)
 * making sizeof() = 20. But DInput7 uses a 16-byte struct without uAppData.
 * Emperor passes cbObjectData=16. We use this constant for size checks. */
#define DINPUT7_OBJECTDATA_SIZE 16

static HRESULT WINAPI hookedMouseGetDeviceData(
    LPDIRECTINPUTDEVICEA self, DWORD cbObjectData,
    LPDIDEVICEOBJECTDATA rgdod, LPDWORD pdwInOut, DWORD dwFlags
) {
    /* In NON-EXCLUSIVE mode, DInput fills the buffer naturally from OS-level
     * mouse events (generated by mouse_event() in the wake thread).
     * We just pass through and log for diagnostics. */
    HRESULT hr = g_origMouseGetDeviceData(self, cbObjectData, rgdod, pdwInOut, dwFlags);

    LONG count = InterlockedIncrement(&g_getDeviceDataCallCount);
    DWORD numEvents = pdwInOut ? *pdwInOut : 0;

    /* Log first call, every 500th, and whenever events are returned */
    if (count == 1 || (count % 500 == 0) || numEvents > 0) {
        hookLog("GetDeviceData (count=%ld, events=%lu, cbObj=%lu, hr=0x%08X)",
                count, (unsigned long)numEvents, (unsigned long)cbObjectData, (unsigned)hr);

        /* Log actual event data when events arrive (for diagnostics) */
        if (numEvents > 0 && rgdod && cbObjectData >= DINPUT7_OBJECTDATA_SIZE) {
            for (DWORD i = 0; i < numEvents && i < 8; i++) {
                BYTE *ev = (BYTE *)rgdod + (i * cbObjectData);
                DWORD dwOfs = *(DWORD *)(ev + 0);
                DWORD dwData = *(DWORD *)(ev + 4);
                hookLog("  ev[%lu]: ofs=%lu data=%ld", (unsigned long)i,
                        (unsigned long)dwOfs, (long)(int)dwData);
            }
        }
    }

    return hr;
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

/* --- Hooked SetCooperativeLevel for MOUSE --- */

static HRESULT WINAPI hookedMouseSetCooperativeLevel(
    LPDIRECTINPUTDEVICEA self, HWND hwnd, DWORD dwFlags
) {
    g_gameHwnd = hwnd;
    DWORD origFlags = dwFlags;

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
 * When we inject synthetic input via shared memory, the game is asleep in WaitForSingleObject.
 * This thread monitors shared memory and signals the event to wake the game.
 */

static DWORD WINAPI wakeThreadProc(LPVOID param) {
    (void)param;
    hookLog("Wake thread started");

    while (!InterlockedCompareExchange(&g_wakeThreadStop, 0, 0)) {
        if (g_shm && g_shm->cmdType != CMD_NONE && !g_shm->done) {
            LONG cmdType = g_shm->cmdType;
            LONG phase = InterlockedCompareExchange(&g_shm->phase, 0, 0);

            /* Handle mouse commands via mouse_event (works in NON-EXCLUSIVE mode).
             * mouse_event with MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE generates
             * proper mouse hardware events that DInput picks up as relative deltas.
             * SetCursorPos does NOT generate DInput events — confirmed by testing. */
            if (phase == PHASE_IDLE && (cmdType == CMD_CLICK || cmdType == CMD_MOVE)) {
                LONG targetX = g_shm->targetX;
                LONG targetY = g_shm->targetY;

                /* mouse_event(ABSOLUTE) generates DInput relative deltas.
                 * Strategy: reset cursor to (0,0), then move to game coords.
                 * The DInput delta from reset→target = (gameX, gameY) in pixels.
                 * Game cursor: (0,0) + (gameX, gameY) = (gameX, gameY).
                 *
                 * Use SM_CXSCREEN/SM_CYSCREEN (800x600 after SetDisplayMode)
                 * for ABSOLUTE coordinate mapping. Game coords map 1:1 to screen
                 * pixels since the virtual desktop matches the game resolution.
                 * Do NOT apply ClientToScreen — that would add the title bar
                 * offset, making the delta too large in Y. */
                int screenW = GetSystemMetrics(SM_CXSCREEN);
                int screenH = GetSystemMetrics(SM_CYSCREEN);

                /* Step 1: Reset cursor to corner (0,0).
                 * This generates a large negative DInput delta, clamping the
                 * game's internal cursor to (0,0). */
                mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, 0, 0, 0);
                Sleep(50);

                /* Step 2: Move to target game coordinates.
                 * DInput delta = (targetX, targetY) pixels. */
                DWORD absX = (DWORD)((targetX * 65535) / screenW);
                DWORD absY = (DWORD)((targetY * 65535) / screenH);
                mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, absX, absY, 0, 0);
                Sleep(50);

                hookLog("Wake thread: game(%ld,%ld) abs(%lu,%lu) screen=%dx%d",
                        targetX, targetY, (unsigned long)absX, (unsigned long)absY,
                        screenW, screenH);

                if (cmdType == CMD_CLICK) {
                    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                    Sleep(100);  /* Hold for 100ms */
                    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                    hookLog("Wake thread: CLICK complete");
                } else {
                    hookLog("Wake thread: MOVE complete");
                }

                InterlockedExchange(&g_shm->phase, PHASE_IDLE);
                InterlockedExchange(&g_shm->cmdType, CMD_NONE);
                InterlockedExchange(&g_shm->done, 1);
            }

            /* Signal DInput event handle to wake game loop so it calls GetDeviceData */
            if (g_mouseEventHandle) {
                SetEvent(g_mouseEventHandle);
            }
        }
        Sleep(8);  /* ~120Hz polling */
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

        DWORD oldProt;
        VirtualProtect(&vtable[9], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[9] = (void *)hookedKeyboardGetDeviceState;
        VirtualProtect(&vtable[9], sizeof(void *), oldProt, &oldProt);

        hookLog("Keyboard hooks installed");

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
