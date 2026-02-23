/**
 * Reusable keyboard/wait sequences for navigating the original game.
 * Each step is either a key press or a timed wait.
 */

export interface InputStep {
  action: 'key' | 'wait';
  keys?: string[];
  ms?: number;
  comment?: string;
}

export const SEQUENCES: Record<string, InputStep[]> = {
  dismissIntro: [
    { action: 'key', keys: ['ret'], comment: 'dismiss splash' },
    { action: 'wait', ms: 500 },
    { action: 'key', keys: ['ret'], comment: 'dismiss second splash' },
  ],

  navigateToSkirmish: [
    { action: 'wait', ms: 2000 },
    { action: 'key', keys: ['ret'], comment: 'press play' },
    { action: 'wait', ms: 2000 },
    { action: 'key', keys: ['2'], comment: 'select skirmish mode' },
    { action: 'wait', ms: 1000 },
    { action: 'key', keys: ['ret'], comment: 'confirm' },
  ],

  selectAtreides: [
    { action: 'key', keys: ['1'], comment: 'select Atreides' },
    { action: 'wait', ms: 1000 },
    { action: 'key', keys: ['ret'], comment: 'confirm house' },
  ],

  selectHarkonnen: [
    { action: 'key', keys: ['2'], comment: 'select Harkonnen' },
    { action: 'wait', ms: 1000 },
    { action: 'key', keys: ['ret'], comment: 'confirm house' },
  ],

  selectOrdos: [
    { action: 'key', keys: ['3'], comment: 'select Ordos' },
    { action: 'wait', ms: 1000 },
    { action: 'key', keys: ['ret'], comment: 'confirm house' },
  ],
};
