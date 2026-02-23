/**
 * AST node types for the .tok bytecode interpreter.
 *
 * The .tok VM is a reactive event loop: every game tick, ALL top-level
 * if/endif blocks are re-evaluated. State is maintained via typed
 * variable slots. There is no program counter.
 */

// ---------------------------------------------------------------------------
// Variable types
// ---------------------------------------------------------------------------

export const enum VarType {
  Int = 0,  // integers and booleans (TRUE=1, FALSE=0)
  Obj = 1,  // entity IDs (ECS entity references)
  Pos = 2,  // world positions {x, z}
}

// ---------------------------------------------------------------------------
// AST nodes
// ---------------------------------------------------------------------------

/** A complete parsed .tok program: an array of top-level conditional blocks. */
export type TokProgram = TokBlock[];

/** A conditional block with optional else branch. */
export interface TokBlock {
  kind: 'block';
  condition: TokExpr;
  body: TokStatement[];
  elseBody: TokStatement[];
}

/** Any statement: assignment, function call, or nested block. */
export type TokStatement = TokAssignment | TokFuncCall | TokBlock;

/** Variable assignment: `var = expr` */
export interface TokAssignment {
  kind: 'assign';
  varSlot: number;
  varType: VarType;
  value: TokExpr;
}

/** Function call as statement (return value discarded). */
export interface TokFuncCall {
  kind: 'call';
  funcId: number;
  args: TokExpr[];
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type TokExpr =
  | TokLiteral
  | TokVarRef
  | TokFuncCallExpr
  | TokBinaryOp
  | TokStringRef
  | TokBoolLiteral;

/** Numeric literal. */
export interface TokLiteral {
  kind: 'literal';
  value: number;
}

/** Boolean literal (TRUE=1, FALSE=0). */
export interface TokBoolLiteral {
  kind: 'bool';
  value: boolean;
}

/** Variable reference. */
export interface TokVarRef {
  kind: 'var';
  slot: number;
  varType: VarType;
}

/** Function call as expression (returns a value). */
export interface TokFuncCallExpr {
  kind: 'callExpr';
  funcId: number;
  args: TokExpr[];
}

/** Binary operator: comparison, arithmetic, logical. */
export interface TokBinaryOp {
  kind: 'binary';
  op: '==' | '!=' | '>=' | '<=' | '>' | '<' | '&&' | '||' | '+' | '-';
  left: TokExpr;
  right: TokExpr;
}

/** String table reference: STR[N] → type name. */
export interface TokStringRef {
  kind: 'string';
  index: number;
}

// ---------------------------------------------------------------------------
// Variable declaration info (parsed from header)
// ---------------------------------------------------------------------------

export interface VarDecl {
  slot: number;
  type: VarType;
}

// ---------------------------------------------------------------------------
// Position value used by pos variables
// ---------------------------------------------------------------------------

export interface TokPos {
  x: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Function ID constants (from GAME.EXE function table at 0x1FE0B0)
// ---------------------------------------------------------------------------

export const FUNC = {
  ModelTick: 0, Random: 1, Multiplayer: 2,
  GetUnusedBasePoint: 3, GetSideBasePoint: 4, GetScriptPoint: 5,
  GetEntrancePoint: 6, GetExitPoint: 7, GetNeutralEntrancePoint: 8,
  GetEntrancePointByIndex: 9, GetEntranceNearToPos: 10, GetEntrancNearToPos: 10,
  GetEntranceFarFromPos: 11, GetSidePosition: 12, GetObjectPosition: 13,
  GetPlayerSide: 14, GetSecondPlayerSide: 15, GetEnemySide: 16,
  GetObjectSide: 17, CreateSide: 18, GetSideCash: 19, GetSideSpice: 20,
  NewObject: 21, ObjectValid: 22, ObjectDestroyed: 23,
  ObjectNearToSide: 24, ObjectNearToSideBase: 25, ObjectNearToObject: 26,
  ObjectVisibleToSide: 27, ObjectTypeVisibleToSide: 28,
  ObjectGetHealth: 29, ObjectMaxHealth: 30, SideVisibleToSide: 31,
  SideNearToSide: 32, SideNearToSideBase: 33, SideNearToPoint: 34,
  SideUnitCount: 35, SideBuildingCount: 36, SideObjectCount: 37,
  SideAIDone: 38, EventObjectDelivered: 39, EventObjectConstructed: 40,
  EventObjectTypeConstructed: 41, EventSideAttacksSide: 42,
  EventObjectAttacksSide: 43, EventObjectDestroyed: 44,
  Message: 45, GiftingMessage: 46, TimerMessage: 47,
  TimerMessageRemove: 48, CarryAllDelivery: 49, Delivery: 50,
  StarportDelivery: 51, BuildObject: 52, ObjectChangeSide: 53,
  ObjectSetHealth: 54, ObjectInfect: 55, ObjectDetonate: 56,
  ObjectChange: 57, ObjectToolTip: 58, SideFriendTo: 59,
  SideEnemyTo: 60, SideNeutralTo: 61, AddSideCash: 62,
  SideAIControl: 63, SideAIAggressive: 64, SideAIAggressiveTowards: 65,
  SideAIBehaviourAggressive: 66, SideAIBehaviourRetreat: 67,
  SideAIBehaviourNormal: 68, SideAIEncounterIgnore: 69,
  SideAIEncounterAttack: 70, SideAIMove: 71, SideAIStop: 72,
  SideAIAttackObject: 73, SideAIGuardObject: 74, SideAIExitMap: 75,
  SideAIEnterBuilding: 76, SideAIBehaviourDefensive: 77,
  SideAIHeadlessChicken: 78, SideAIShuffle: 79,
  SideAttractsWorms: 80, SideRepelsWorms: 81, ForceWormStrike: 82,
  MissionOutcome: 83, EndGameWin: 84, EndGameLose: 85,
  NewCrateUnit: 86, NewCrateBomb: 87, NewCrateStealth: 88,
  NewCrateCash: 89, NewCrateShroud: 90, SideChangeSide: 91,
  SetReinforcements: 92, SideNuke: 93, SideNukeAll: 94,
  RadarEnabled: 95, RadarAlert: 96, RemoveShroud: 97,
  ReplaceShroud: 98, RemoveMapShroud: 99,
  CameraLookAtPoint: 100, CameraPanToPoint: 101,
  CameraScrollToPoint: 102, CameraZoomTo: 103, CameraViewFrom: 104,
  CameraStartRotate: 105, CameraStopRotate: 106,
  CameraTrackObject: 107, CameraStopTrack: 108,
  CameraIsPanning: 109, CameraIsScrolling: 110, CameraIsSpinning: 111,
  CameraStore: 112, CameraRestore: 113,
  PIPCameraLookAtPoint: 114, PIPCameraPanToPoint: 115,
  PIPCameraScrollToPoint: 116, PIPCameraZoomTo: 117,
  PIPCameraViewFrom: 118, PIPCameraStartRotate: 119,
  PIPCameraStopRotate: 120, PIPCameraTrackObject: 121,
  PIPCameraStopTrack: 122, PIPCameraIsPanning: 123,
  PIPCameraIsScrolling: 124, PIPCameraIsSpinning: 125,
  PIPCameraStore: 126, PIPCameraRestore: 127,
  PIPRelease: 128, FreezeGame: 129, UnFreezeGame: 130,
  DisableUI: 131, EnableUI: 132, ObjectDeploy: 133,
  ObjectUndeploy: 134, ObjectSell: 135, ObjectRemove: 136,
  NewObjectInAPC: 137, ObjectIsCarried: 138,
  NewObjectOffsetOrientation: 139, GetNeutralSide: 140,
  GetNeutralExitPoint: 141, PlaySound: 142, Neg: 143,
  SetValue: 144, GetIsolatedEntrance: 145, GetHideOut: 146,
  GetConvoyWayPointFunction: 147, GetValley: 148,
  GetIsolatedInfantryRock: 149, SetSideColor: 150,
  GetSideColor: 151, SetSideCash: 152, AirStrike: 153,
  AirStrikeDone: 154, SetThreatLevel: 155, SetVeterancy: 156,
  FireSpecialWeapon: 157, SetTilePos: 158, CentreCursor: 159,
  BreakPoint: 160, NormalConditionLose: 161,
} as const;

/** Function name lookup table. */
export const FUNC_NAMES: Record<number, string> = {
  0: 'ModelTick', 1: 'Random', 2: 'Multiplayer',
  3: 'GetUnusedBasePoint', 4: 'GetSideBasePoint', 5: 'GetScriptPoint',
  6: 'GetEntrancePoint', 7: 'GetExitPoint', 8: 'GetNeutralEntrancePoint',
  9: 'GetEntrancePointByIndex', 10: 'GetEntranceNearToPos',
  11: 'GetEntranceFarFromPos', 12: 'GetSidePosition', 13: 'GetObjectPosition',
  14: 'GetPlayerSide', 15: 'GetSecondPlayerSide', 16: 'GetEnemySide',
  17: 'GetObjectSide', 18: 'CreateSide', 19: 'GetSideCash', 20: 'GetSideSpice',
  21: 'NewObject', 22: 'ObjectValid', 23: 'ObjectDestroyed',
  24: 'ObjectNearToSide', 25: 'ObjectNearToSideBase', 26: 'ObjectNearToObject',
  27: 'ObjectVisibleToSide', 28: 'ObjectTypeVisibleToSide',
  29: 'ObjectGetHealth', 30: 'ObjectMaxHealth', 31: 'SideVisibleToSide',
  32: 'SideNearToSide', 33: 'SideNearToSideBase', 34: 'SideNearToPoint',
  35: 'SideUnitCount', 36: 'SideBuildingCount', 37: 'SideObjectCount',
  38: 'SideAIDone', 39: 'EventObjectDelivered', 40: 'EventObjectConstructed',
  41: 'EventObjectTypeConstructed', 42: 'EventSideAttacksSide',
  43: 'EventObjectAttacksSide', 44: 'EventObjectDestroyed',
  45: 'Message', 46: 'GiftingMessage', 47: 'TimerMessage',
  48: 'TimerMessageRemove', 49: 'CarryAllDelivery', 50: 'Delivery',
  51: 'StarportDelivery', 52: 'BuildObject', 53: 'ObjectChangeSide',
  54: 'ObjectSetHealth', 55: 'ObjectInfect', 56: 'ObjectDetonate',
  57: 'ObjectChange', 58: 'ObjectToolTip', 59: 'SideFriendTo',
  60: 'SideEnemyTo', 61: 'SideNeutralTo', 62: 'AddSideCash',
  63: 'SideAIControl', 64: 'SideAIAggressive', 65: 'SideAIAggressiveTowards',
  66: 'SideAIBehaviourAggressive', 67: 'SideAIBehaviourRetreat',
  68: 'SideAIBehaviourNormal', 69: 'SideAIEncounterIgnore',
  70: 'SideAIEncounterAttack', 71: 'SideAIMove', 72: 'SideAIStop',
  73: 'SideAIAttackObject', 74: 'SideAIGuardObject', 75: 'SideAIExitMap',
  76: 'SideAIEnterBuilding', 77: 'SideAIBehaviourDefensive',
  78: 'SideAIHeadlessChicken', 79: 'SideAIShuffle',
  80: 'SideAttractsWorms', 81: 'SideRepelsWorms', 82: 'ForceWormStrike',
  83: 'MissionOutcome', 84: 'EndGameWin', 85: 'EndGameLose',
  86: 'NewCrateUnit', 87: 'NewCrateBomb', 88: 'NewCrateStealth',
  89: 'NewCrateCash', 90: 'NewCrateShroud', 91: 'SideChangeSide',
  92: 'SetReinforcements', 93: 'SideNuke', 94: 'SideNukeAll',
  95: 'RadarEnabled', 96: 'RadarAlert', 97: 'RemoveShroud',
  98: 'ReplaceShroud', 99: 'RemoveMapShroud',
  100: 'CameraLookAtPoint', 101: 'CameraPanToPoint',
  102: 'CameraScrollToPoint', 103: 'CameraZoomTo', 104: 'CameraViewFrom',
  105: 'CameraStartRotate', 106: 'CameraStopRotate',
  107: 'CameraTrackObject', 108: 'CameraStopTrack',
  109: 'CameraIsPanning', 110: 'CameraIsScrolling', 111: 'CameraIsSpinning',
  112: 'CameraStore', 113: 'CameraRestore',
  114: 'PIPCameraLookAtPoint', 115: 'PIPCameraPanToPoint',
  116: 'PIPCameraScrollToPoint', 117: 'PIPCameraZoomTo',
  118: 'PIPCameraViewFrom', 119: 'PIPCameraStartRotate',
  120: 'PIPCameraStopRotate', 121: 'PIPCameraTrackObject',
  122: 'PIPCameraStopTrack', 123: 'PIPCameraIsPanning',
  124: 'PIPCameraIsScrolling', 125: 'PIPCameraIsSpinning',
  126: 'PIPCameraStore', 127: 'PIPCameraRestore',
  128: 'PIPRelease', 129: 'FreezeGame', 130: 'UnFreezeGame',
  131: 'DisableUI', 132: 'EnableUI', 133: 'ObjectDeploy',
  134: 'ObjectUndeploy', 135: 'ObjectSell', 136: 'ObjectRemove',
  137: 'NewObjectInAPC', 138: 'ObjectIsCarried',
  139: 'NewObjectOffsetOrientation', 140: 'GetNeutralSide',
  141: 'GetNeutralExitPoint', 142: 'PlaySound', 143: 'Neg',
  144: 'SetValue', 145: 'GetIsolatedEntrance', 146: 'GetHideOut',
  147: 'GetConvoyWayPointFunction', 148: 'GetValley',
  149: 'GetIsolatedInfantryRock', 150: 'SetSideColor',
  151: 'GetSideColor', 152: 'SetSideCash', 153: 'AirStrike',
  154: 'AirStrikeDone', 155: 'SetThreatLevel', 156: 'SetVeterancy',
  157: 'FireSpecialWeapon', 158: 'SetTilePos', 159: 'CentreCursor',
  160: 'BreakPoint', 161: 'NormalConditionLose',
};

/** Keyword/operator tokens start at ID 162 in the function table. */
export const KEYWORD_THRESHOLD = 162;

/** Keyword token IDs. */
export const KW = {
  int: 162, obj: 163, pos: 164,
  if: 165, else: 166, endif: 167,
  eq: 168, neq: 169, gte: 170, lte: 171, gt: 172, lt: 173,
  and: 174, or: 175,
  FALSE: 176, TRUE: 177,
  plus: 178, minus: 179, assign: 180,
} as const;

// ---------------------------------------------------------------------------
// Save/load state
// ---------------------------------------------------------------------------

export interface TokSaveState {
  intVars: number[];
  objVars: number[];   // mapped via eidToIndex
  posVars: Array<{ x: number; z: number }>;
  nextSideId: number;
  relationships: Array<{ a: number; b: number; rel: string }>;
  eventFlags: Record<string, boolean>;
  dispatchState?: TokDispatchSaveState;
}

export interface TokDispatchSaveState {
  airStrikes: Array<{ strikeId: number; units: number[]; targetX: number; targetZ: number }>;
  tooltipMap: Array<{ entity: number; tooltipId: number }>;
  sideColors: Array<{ side: number; color: number }>;
  typeThreatLevels: Array<{ typeName: string; level: number }>;
  lastCameraTick: number;
  mainCameraTrackEid: number;
  pipCameraTrackEid: number;
  mainCameraSpin: { active: boolean; speed: number; direction: number };
  pipCameraSpin: { active: boolean; speed: number; direction: number };
  mainCameraStored: { x: number; z: number; zoom: number; rotation: number } | null;
  pipCameraStored: { x: number; z: number; zoom: number; rotation: number } | null;
  sideBasePositions: Array<{ side: number; x: number; z: number }>;
}
