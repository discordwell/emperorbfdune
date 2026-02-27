/**
 * Action types the oracle can issue to the game.
 * Both adapters translate these into backend-specific commands.
 */

export type Action =
  | MoveAction
  | AttackAction
  | AttackMoveAction
  | ProduceAction
  | BuildAction
  | RepairAction
  | SetRallyAction
  | StopAction
  | GuardAction
  | SellAction;

export interface MoveAction {
  type: 'move';
  entityIds: number[];
  x: number;
  z: number;
}

export interface AttackAction {
  type: 'attack';
  entityIds: number[];
  targetEid: number;
}

export interface AttackMoveAction {
  type: 'attack_move';
  entityIds: number[];
  x: number;
  z: number;
}

export interface ProduceAction {
  type: 'produce';
  typeName: string;
  isBuilding: boolean;
}

export interface BuildAction {
  type: 'build';
  typeName: string;
  x: number;
  z: number;
}

export interface RepairAction {
  type: 'repair';
  buildingEid: number;
}

export interface SetRallyAction {
  type: 'set_rally';
  x: number;
  z: number;
}

export interface StopAction {
  type: 'stop';
  entityIds: number[];
}

export interface GuardAction {
  type: 'guard';
  entityIds: number[];
}

export interface SellAction {
  type: 'sell';
  buildingEid: number;
}
