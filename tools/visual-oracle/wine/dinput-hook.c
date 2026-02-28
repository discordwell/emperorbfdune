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

/* Original vtable function pointers */
typedef HRESULT (WINAPI *CreateDevice_t)(LPDIRECTINPUTA, REFGUID, LPDIRECTINPUTDEVICEA*, LPUNKNOWN);
static CreateDevice_t g_origCreateDevice = NULL;

typedef HRESULT (WINAPI *GetDeviceState_t)(LPDIRECTINPUTDEVICEA, DWORD, LPVOID);
static GetDeviceState_t g_origMouseGetDeviceState = NULL;
static GetDeviceState_t g_origKeyboardGetDeviceState = NULL;

typedef HRESULT (WINAPI *GetDeviceData_t)(LPDIRECTINPUTDEVICEA, DWORD, LPDIDEVICEOBJECTDATA, LPDWORD, DWORD);
static GetDeviceData_t g_origMouseGetDeviceData = NULL;

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

static HRESULT WINAPI hookedMouseGetDeviceState(
    LPDIRECTINPUTDEVICEA self, DWORD cbData, LPVOID lpvData
) {
    /* Always call real GetDeviceState first to clear internal buffer */
    HRESULT hr = g_origMouseGetDeviceState(self, cbData, lpvData);

    if (!g_shm || g_shm->cmdType == CMD_NONE || g_shm->done)
        return hr;

    /* Only handle mouse commands */
    if (g_shm->cmdType != CMD_CLICK && g_shm->cmdType != CMD_MOVE)
        return hr;

    if (cbData < sizeof(DIMOUSESTATE))
        return hr;

    DIMOUSESTATE *ms = (DIMOUSESTATE *)lpvData;
    LONG phase = InterlockedCompareExchange(&g_shm->phase, 0, 0);

    /* If phase is IDLE, start execution */
    if (phase == PHASE_IDLE) {
        if (g_shm->cmdType == CMD_CLICK) {
            InterlockedExchange(&g_shm->phase, PHASE_RESET);
        } else {
            InterlockedExchange(&g_shm->phase, PHASE_MOVE_RESET);
        }
        phase = InterlockedCompareExchange(&g_shm->phase, 0, 0);
        g_shm->frameCount = 0;
    }

    switch (phase) {
    /* --- CLICK sequence --- */
    case PHASE_RESET:
        /* Large negative delta to push cursor to (0,0) corner */
        ms->lX = -10000;
        ms->lY = -10000;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0;
        ms->rgbButtons[1] = 0;
        g_shm->cursorX = 0;
        g_shm->cursorY = 0;
        InterlockedExchange(&g_shm->phase, PHASE_MOVETO);
        g_shm->frameCount = 0;
        break;

    case PHASE_MOVETO:
        /* Move to target position */
        ms->lX = g_shm->targetX;
        ms->lY = g_shm->targetY;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0;
        ms->rgbButtons[1] = 0;
        g_shm->cursorX = g_shm->targetX;
        g_shm->cursorY = g_shm->targetY;
        InterlockedExchange(&g_shm->phase, PHASE_SETTLE);
        g_shm->frameCount = 0;
        break;

    case PHASE_SETTLE:
        /* Zero delta — let game process the position */
        ms->lX = 0;
        ms->lY = 0;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0;
        ms->rgbButtons[1] = 0;
        InterlockedExchange(&g_shm->phase, PHASE_BTN_DOWN);
        g_shm->frameCount = 0;
        break;

    case PHASE_BTN_DOWN:
        ms->lX = 0;
        ms->lY = 0;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0x80;  /* Left button down */
        ms->rgbButtons[1] = 0;
        InterlockedExchange(&g_shm->phase, PHASE_BTN_HOLD);
        g_shm->frameCount = 0;
        break;

    case PHASE_BTN_HOLD:
        ms->lX = 0;
        ms->lY = 0;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0x80;  /* Still held */
        ms->rgbButtons[1] = 0;
        g_shm->frameCount++;
        if (g_shm->frameCount >= 2) {
            InterlockedExchange(&g_shm->phase, PHASE_BTN_UP);
            g_shm->frameCount = 0;
        }
        break;

    case PHASE_BTN_UP:
        ms->lX = 0;
        ms->lY = 0;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0x00;  /* Released */
        ms->rgbButtons[1] = 0;
        hookLog("Click complete at (%d, %d)", g_shm->targetX, g_shm->targetY);
        InterlockedExchange(&g_shm->phase, PHASE_IDLE);
        InterlockedExchange(&g_shm->cmdType, CMD_NONE);
        InterlockedExchange(&g_shm->done, 1);
        g_shm->frameCount = 0;
        break;

    /* --- MOVE sequence (no click) --- */
    case PHASE_MOVE_RESET:
        ms->lX = -10000;
        ms->lY = -10000;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0;
        ms->rgbButtons[1] = 0;
        InterlockedExchange(&g_shm->phase, PHASE_MOVE_TO);
        g_shm->frameCount = 0;
        break;

    case PHASE_MOVE_TO:
        ms->lX = g_shm->targetX;
        ms->lY = g_shm->targetY;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0;
        ms->rgbButtons[1] = 0;
        InterlockedExchange(&g_shm->phase, PHASE_MOVE_SETTLE);
        g_shm->frameCount = 0;
        break;

    case PHASE_MOVE_SETTLE:
        ms->lX = 0;
        ms->lY = 0;
        ms->lZ = 0;
        ms->rgbButtons[0] = 0;
        ms->rgbButtons[1] = 0;
        hookLog("Move complete to (%d, %d)", g_shm->targetX, g_shm->targetY);
        InterlockedExchange(&g_shm->phase, PHASE_IDLE);
        InterlockedExchange(&g_shm->cmdType, CMD_NONE);
        InterlockedExchange(&g_shm->done, 1);
        g_shm->frameCount = 0;
        break;

    default:
        /* Unknown phase — pass through real input unchanged */
        return hr;
    }

    return DI_OK;
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

static HRESULT WINAPI hookedMouseGetDeviceData(
    LPDIRECTINPUTDEVICEA self, DWORD cbObjectData,
    LPDIDEVICEOBJECTDATA rgdod, LPDWORD pdwInOut, DWORD dwFlags
) {
    /* If we're mid-injection, report no buffered data so the game
       falls through to GetDeviceState (where we inject). */
    if (g_shm && g_shm->cmdType != CMD_NONE && !g_shm->done) {
        if (pdwInOut) *pdwInOut = 0;
        return DI_OK;
    }
    return g_origMouseGetDeviceData(self, cbObjectData, rgdod, pdwInOut, dwFlags);
}

/* --- Hooked CreateDevice --- */

static HRESULT WINAPI hookedCreateDevice(
    LPDIRECTINPUTA self, REFGUID rguid,
    LPDIRECTINPUTDEVICEA *lplpDirectInputDevice,
    LPUNKNOWN pUnkOuter
) {
    HRESULT hr = g_origCreateDevice(self, rguid, lplpDirectInputDevice, pUnkOuter);
    if (FAILED(hr) || !lplpDirectInputDevice || !*lplpDirectInputDevice)
        return hr;

    LPDIRECTINPUTDEVICEA dev = *lplpDirectInputDevice;
    void **vtable = *(void ***)dev;

    if (IsEqualGUID(rguid, &GUID_SysMouse)) {
        hookLog("Mouse device created — hooking GetDeviceState (vtable[9]) and GetDeviceData (vtable[10])");
        g_mouseDevice = dev;

        /* Save originals */
        g_origMouseGetDeviceState = (GetDeviceState_t)vtable[9];
        g_origMouseGetDeviceData = (GetDeviceData_t)vtable[10];

        /* Patch vtable — all instances share the same vtable */
        DWORD oldProt;
        VirtualProtect(&vtable[9], sizeof(void *) * 2, PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[9] = (void *)hookedMouseGetDeviceState;
        vtable[10] = (void *)hookedMouseGetDeviceData;
        VirtualProtect(&vtable[9], sizeof(void *) * 2, oldProt, &oldProt);

        hookLog("Mouse hooks installed");
    }
    else if (IsEqualGUID(rguid, &GUID_SysKeyboard)) {
        hookLog("Keyboard device created — hooking GetDeviceState (vtable[9])");
        g_keyboardDevice = dev;

        g_origKeyboardGetDeviceState = (GetDeviceState_t)vtable[9];

        DWORD oldProt;
        VirtualProtect(&vtable[9], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
        vtable[9] = (void *)hookedKeyboardGetDeviceState;
        VirtualProtect(&vtable[9], sizeof(void *), oldProt, &oldProt);

        hookLog("Keyboard hooks installed");
    }

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

    /* Hook IDirectInput7A::CreateDevice (vtable index 3) */
    LPDIRECTINPUTA dinput = (LPDIRECTINPUTA)*ppvOut;
    void **vtable = *(void ***)dinput;

    g_origCreateDevice = (CreateDevice_t)vtable[3];

    DWORD oldProt;
    VirtualProtect(&vtable[3], sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
    vtable[3] = (void *)hookedCreateDevice;
    VirtualProtect(&vtable[3], sizeof(void *), oldProt, &oldProt);

    hookLog("CreateDevice hook installed (vtable[3])");
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
