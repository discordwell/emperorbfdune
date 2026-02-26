/**
 * dinput-ipc.h — Shared memory IPC protocol between dinput-hook.dll and inputctl.exe.
 *
 * This header defines the shared memory layout and constants used by both
 * the DInput proxy DLL (injected into GAME.EXE) and the inputctl.exe CLI tool.
 * Both files MUST include this header to ensure struct layout consistency.
 */

#ifndef DINPUT_IPC_H
#define DINPUT_IPC_H

#include <windows.h>

#define SHM_NAME "Emperor_DInput_Hook"

/* Command types */
#define CMD_NONE     0
#define CMD_CLICK    1
#define CMD_MOVE     2
#define CMD_KEYPRESS 3

/* Execution phases for mouse click */
#define PHASE_IDLE       0
#define PHASE_RESET      1  /* Large negative delta to corner */
#define PHASE_MOVETO     2  /* Delta to target position */
#define PHASE_SETTLE     3  /* Zero delta settle frame */
#define PHASE_BTN_DOWN   4  /* Button pressed */
#define PHASE_BTN_HOLD   5  /* Hold frame */
#define PHASE_BTN_UP     6  /* Button released */

/* Execution phases for mouse move (no click) */
#define PHASE_MOVE_RESET  10
#define PHASE_MOVE_TO     11
#define PHASE_MOVE_SETTLE 12

/* Execution phases for key press */
#define PHASE_KEY_DOWN   20
#define PHASE_KEY_HOLD1  21
#define PHASE_KEY_HOLD2  22
#define PHASE_KEY_UP     23

typedef struct {
    volatile LONG ready;       /* DLL sets to 1 when hooks are installed */
    volatile LONG cmdType;     /* CMD_NONE, CMD_CLICK, CMD_MOVE, CMD_KEYPRESS */
    volatile LONG targetX;     /* Target X (0-799) for mouse commands */
    volatile LONG targetY;     /* Target Y (0-599) for mouse commands */
    volatile LONG keyCode;     /* DIK_ code for keyboard commands */
    volatile LONG phase;       /* Current execution phase */
    volatile LONG done;        /* Set to 1 when command completes */
    volatile LONG frameCount;  /* Frames elapsed in current phase */
    volatile LONG cursorX;     /* Estimated cursor X after reset */
    volatile LONG cursorY;     /* Estimated cursor Y after reset */
} InputSharedState;

#endif /* DINPUT_IPC_H */
