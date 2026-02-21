export const TOK_ORACLE_SCHEMA_VERSION = 1 as const;

export interface TokCheckpointSignalV1 {
  tick: number;
  frameHash: string;
  intHash: string;
  objHash: string;
  posHash: string;
  relHash: string;
  eventHash: string;
  dispatchHash: string;
}

export interface TokMissionOracleEntryV1 {
  scriptId: string;
  maxTick: number;
  frameCount: number;
  checkpoints: TokCheckpointSignalV1[];
  final: TokCheckpointSignalV1;
}

export interface TokMissionOracleDatasetV1 {
  schemaVersion: typeof TOK_ORACLE_SCHEMA_VERSION;
  generator: string;
  generatedAt: string;
  seed: number;
  defaultMaxTick: number;
  headerMaxTick: number;
  checkpointStride: number;
  fastScripts: string[];
  missions: Record<string, TokMissionOracleEntryV1>;
}

export interface TokBranchScenarioEntryV1 {
  id: string;
  description: string;
  signals: Record<string, boolean | number | string | Array<boolean | number | string>>;
}

export interface TokBranchOracleDatasetV1 {
  schemaVersion: typeof TOK_ORACLE_SCHEMA_VERSION;
  generator: string;
  generatedAt: string;
  scenarios: Record<string, TokBranchScenarioEntryV1>;
}

export interface TokSimulationHashCheckpointV1 {
  tick: number;
  hash: number;
}

export interface TokSimulationHashEntryV1 {
  scriptId: string;
  maxTick: number;
  checkpoints: TokSimulationHashCheckpointV1[];
}

export interface TokSimulationHashDatasetV1 {
  schemaVersion: typeof TOK_ORACLE_SCHEMA_VERSION;
  generator: string;
  generatedAt: string;
  seed: number;
  defaultMaxTick: number;
  headerMaxTick: number;
  checkpointStride: number;
  fastScripts: string[];
  missions: Record<string, TokSimulationHashEntryV1>;
}

export interface OracleComparisonDiff {
  path: string;
  expected: unknown;
  actual: unknown;
}
