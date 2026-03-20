/**
 * binkw32-stub.c — Complete replacement for Bink Video DLL.
 *
 * Returns valid (but empty) data structures so the game doesn't crash
 * when it calls Bink functions during house selection and campaign transitions.
 *
 * The key function is BinkOpen which must return a valid BINK handle struct.
 * All other functions return 0/NULL or operate as no-ops.
 *
 * Build:
 *   i686-w64-mingw32-gcc -shared -O2 -o binkw32.dll binkw32-stub.c binkw32-stub.def
 */

#include <windows.h>
#include <string.h>

/* Fake BINK handle — must survive dereferences at common offsets.
 * The game reads fields at +0x00 (width), +0x04 (height), +0x08 (frames),
 * +0x0C (current frame), +0x10 (last frame), +0x14 (fps), +0x20 (?),
 * +0x28 (flags), and more. We allocate a large zeroed struct. */
typedef struct {
    DWORD width;          /* +0x00 */
    DWORD height;         /* +0x04 */
    DWORD frames;         /* +0x08 */
    DWORD currentFrame;   /* +0x0C */
    DWORD lastFrame;      /* +0x10 */
    DWORD framesPerSecond;/* +0x14 */
    DWORD padding1[2];    /* +0x18, +0x1C */
    DWORD flags;          /* +0x20 */
    BYTE  data[4096];     /* Large buffer for any field access */
} FakeBink;

/* Single global fake handle — game typically only opens one Bink at a time */
static FakeBink g_fakeBink;
static int g_initialized = 0;

/* Fake BinkBuffer handle */
typedef struct {
    DWORD width;
    DWORD height;
    DWORD windowWidth;
    DWORD windowHeight;
    DWORD surfaceType;
    void *buffer;
    DWORD bufferPitch;
    BYTE  data[1024];
} FakeBinkBuffer;

static FakeBinkBuffer g_fakeBinkBuffer;
static char g_errorStr[] = "";

static void initFake(void) {
    if (g_initialized) return;
    memset(&g_fakeBink, 0, sizeof(g_fakeBink));
    g_fakeBink.width = 640;
    g_fakeBink.height = 480;
    g_fakeBink.frames = 1;
    g_fakeBink.currentFrame = 1;
    g_fakeBink.lastFrame = 1;
    g_fakeBink.framesPerSecond = 15;
    memset(&g_fakeBinkBuffer, 0, sizeof(g_fakeBinkBuffer));
    g_fakeBinkBuffer.width = 640;
    g_fakeBinkBuffer.height = 480;
    g_initialized = 1;
}

/* === Core Bink functions === */

void * __stdcall _BinkOpen(const char *name, DWORD flags) {
    initFake();
    return &g_fakeBink;
}

void __stdcall _BinkClose(void *bink) {
    /* no-op */
}

int __stdcall _BinkDoFrame(void *bink) {
    return 0;
}

int __stdcall _BinkNextFrame(void *bink) {
    if (bink) {
        FakeBink *b = (FakeBink *)bink;
        b->currentFrame = b->lastFrame; /* Mark as done */
    }
    return 0;
}

int __stdcall _BinkWait(void *bink) {
    return 0; /* 0 = don't wait, frame ready */
}

int __stdcall _BinkCopyToBuffer(void *bink, void *dest, int pitch,
                                 int height, int x, int y, int flags) {
    return 0;
}

void * __stdcall _BinkGoto(void *bink, int frame, int flags) {
    return bink;
}

int __stdcall _BinkPause(void *bink, int pause) {
    return 0;
}

int __stdcall _BinkSetSoundOnOff(void *bink, int onoff) {
    return 0;
}

int __stdcall _BinkSetVolume(void *bink, int volume) {
    return 0;
}

int __stdcall _BinkSetSoundSystem(void *system, int param) {
    return 0;
}

char * __stdcall _BinkGetError(void) {
    return g_errorStr;
}

int __stdcall _BinkSetError(const char *err) {
    return 0;
}

/* === BinkBuffer functions === */

void * __stdcall _BinkBufferOpen(HWND hwnd, int width, int height, int flags) {
    initFake();
    g_fakeBinkBuffer.width = width;
    g_fakeBinkBuffer.height = height;
    return &g_fakeBinkBuffer;
}

void __stdcall _BinkBufferClose(void *buf) {
    /* no-op */
}

int __stdcall _BinkBufferLock(void *buf) {
    return 1; /* success */
}

int __stdcall _BinkBufferUnlock(void *buf) {
    return 1;
}

int __stdcall _BinkBufferBlit(void *buf, void *rects, int numrects) {
    return 0;
}

int __stdcall _BinkBufferClear(void *buf, int color) {
    return 0;
}

int __stdcall _BinkBufferSetDirectDraw(void *buf, void *ddraw) {
    return 0;
}

int __stdcall _BinkBufferSetHWND(void *buf, HWND hwnd) {
    return 0;
}

int __stdcall _BinkBufferSetOffset(void *buf, int x, int y) {
    return 0;
}

int __stdcall _BinkBufferSetResolution(void *buf, int width, int height) {
    return 0;
}

int __stdcall _BinkBufferSetScale(void *buf, int width, int height) {
    return 0;
}

int __stdcall _BinkBufferCheckWinPos(void *buf, int *x, int *y) {
    return 0;
}

char * __stdcall _BinkBufferGetError(void) {
    return g_errorStr;
}

char * __stdcall _BinkBufferGetDescription(void *buf) {
    return g_errorStr;
}

/* === Track functions === */

void * __stdcall _BinkOpenTrack(void *bink, int track) {
    return NULL;
}

void __stdcall _BinkCloseTrack(void *track) {
}

int __stdcall _BinkGetTrackData(void *track, void *buf) {
    return 0;
}

int __stdcall _BinkGetTrackID(void *track, int idx) {
    return 0;
}

int __stdcall _BinkGetTrackMaxSize(void *track, int idx) {
    return 0;
}

int __stdcall _BinkGetTrackType(void *track, int idx) {
    return 0;
}

/* === Misc functions === */

int __stdcall _BinkDDSurfaceType(void *surface) {
    return 0;
}

int __stdcall _BinkCheckCursor(HWND hwnd, int x, int y, int w, int h) {
    return 0;
}

int __stdcall _BinkIsSoftwareCursor(void *cursor, int flag) {
    return 0;
}

void __stdcall _BinkRestoreCursor(int flag) {
}

void * __stdcall _BinkLogoAddress(void) {
    return NULL;
}

int __stdcall _BinkGetKeyFrame(void *bink, int frame, int flags) {
    return 0;
}

int __stdcall _BinkGetRealtime(void *bink, void *out, int flags) {
    return 0;
}

int __stdcall _BinkGetRects(void *bink, int flags) {
    return 0;
}

int __stdcall _BinkGetSummary(void *bink, void *summary) {
    return 0;
}

int __stdcall _BinkSetFrameRate(void *bink, int fps) {
    return 0;
}

int __stdcall _BinkSetIO(void *io) {
    return 0;
}

int __stdcall _BinkSetIOSize(int size) {
    return 0;
}

int __stdcall _BinkSetPan(void *bink, int pan) {
    return 0;
}

int __stdcall _BinkSetSimulate(int sim) {
    return 0;
}

int __stdcall _BinkSetSoundTrack(int track) {
    return 0;
}

int __stdcall _BinkService(void *bink) {
    return 0;
}

/* === Sound system openers (return NULL = no sound) === */

void * __stdcall _BinkOpenDirectSound(DWORD param) {
    return NULL;
}

void * __stdcall _BinkOpenMiles(DWORD param) {
    return NULL;
}

void * __stdcall _BinkOpenWaveOut(DWORD param) {
    return NULL;
}

/* === DLL entry point === */

BOOL WINAPI DllMain(HINSTANCE hDll, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hDll);
        initFake();
    }
    return TRUE;
}
