import {
  createWorld,
  addEntity,
  removeEntity,
  addComponent,
  removeComponent,
  hasComponent,
  defineComponent,
  Types,
  defineQuery,
  enterQuery,
  exitQuery,
} from 'bitecs';

// bitECS world type
export type World = ReturnType<typeof createWorld>;

// --- Component Definitions ---

export const Position = defineComponent({
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
});

export const Velocity = defineComponent({
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
});

export const Rotation = defineComponent({
  y: Types.f32, // Yaw rotation (radians) - RTS units only rotate on Y axis
});

export const Health = defineComponent({
  current: Types.f32,
  max: Types.f32,
});

export const Owner = defineComponent({
  playerId: Types.ui8, // 0-7 player slots
});

export const UnitType = defineComponent({
  id: Types.ui16, // Index into unit definitions array
});

export const BuildingType = defineComponent({
  id: Types.ui16, // Index into building definitions array
});

export const MoveTarget = defineComponent({
  x: Types.f32,
  z: Types.f32,
  active: Types.ui8,
});

export const AttackTarget = defineComponent({
  entityId: Types.ui32,
  active: Types.ui8,
});

export const Harvester = defineComponent({
  spiceCarried: Types.f32,
  maxCapacity: Types.f32,
  state: Types.ui8, // 0=idle, 1=movingToSpice, 2=harvesting, 3=returning, 4=unloading
  refineryEntity: Types.ui32,
});

export const Selectable = defineComponent({
  selected: Types.ui8,
});

export const Combat = defineComponent({
  weaponId: Types.ui16,
  attackRange: Types.f32,
  fireTimer: Types.f32, // Ticks until next shot
  rof: Types.f32, // Rate of fire (ticks between shots)
});

export const Armour = defineComponent({
  type: Types.ui8, // Armour class index for warhead damage tables
});

export const Production = defineComponent({
  queueSlot0: Types.ui16,
  progress: Types.f32,
  active: Types.ui8,
});

export const PowerSource = defineComponent({
  amount: Types.i16,
});

export const Veterancy = defineComponent({
  xp: Types.ui32,
  rank: Types.ui8, // 0-3
});

export const Speed = defineComponent({
  max: Types.f32,
  turnRate: Types.f32,
});

export const ViewRange = defineComponent({
  range: Types.f32,
});

export const Renderable = defineComponent({
  modelId: Types.ui16,
  sceneIndex: Types.i32, // Index into Three.js objects array, -1 if not yet created
});

// --- Queries ---

export const movableQuery = defineQuery([Position, Velocity, Speed, MoveTarget]);
export const combatQuery = defineQuery([Position, Combat, Owner]);
export const harvestQuery = defineQuery([Position, Harvester, Owner]);
export const renderQuery = defineQuery([Position, Rotation, Renderable]);
export const selectableQuery = defineQuery([Position, Selectable]);
export const healthQuery = defineQuery([Position, Health]);
export const buildingQuery = defineQuery([Position, BuildingType, Owner]);
export const unitQuery = defineQuery([Position, UnitType, Owner]);

export const renderEnter = enterQuery(renderQuery);
export const renderExit = exitQuery(renderQuery);

// --- World ---

let world: World;

export function createGameWorld(): World {
  world = createWorld();
  return world;
}

export function getWorld(): World {
  return world;
}

// --- Entity helpers ---

export function spawnEntity(w: World): number {
  return addEntity(w);
}

export function destroyEntity(w: World, eid: number): void {
  removeEntity(w, eid);
}

export {
  addComponent,
  removeComponent,
  hasComponent,
  addEntity,
  removeEntity,
};
