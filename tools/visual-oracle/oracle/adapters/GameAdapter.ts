/**
 * Backend interface for the oracle loop.
 * Implemented by RemakeAdapter (Playwright + page.evaluate) and WineAdapter (Wine + vision LLM).
 */

import type { GameState } from '../state/GameState.js';
import type { Action } from '../actions/Action.js';

export interface GameAdapter {
  /** Connect to the running game instance */
  connect(): Promise<void>;

  /** Disconnect from the game */
  disconnect(): Promise<void>;

  /** Observe full game state */
  observe(): Promise<GameState>;

  /** Pause the game simulation */
  pause(): Promise<void>;

  /** Resume the game simulation */
  resume(): Promise<void>;

  /** Execute a batch of actions */
  execute(actions: Action[]): Promise<void>;

  /** Capture a screenshot (PNG buffer) */
  screenshot(): Promise<Buffer>;

  /** Backend name for logging */
  readonly name: string;
}
