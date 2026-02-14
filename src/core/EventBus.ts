type EventCallback<T = unknown> = (data: T) => void;

interface EventMap {
  'unit:selected': { entityIds: number[] };
  'unit:deselected': {};
  'unit:move': { entityIds: number[]; x: number; z: number };
  'unit:attack': { attackerIds: number[]; targetId: number };
  'unit:spawned': { entityId: number; unitType: string; owner: number };
  'unit:died': { entityId: number; killerEntity: number };
  'unit:promoted': { entityId: number; rank: number };
  'building:placed': { entityId: number; buildingType: string; owner: number };
  'building:destroyed': { entityId: number };
  'building:started': { buildingType: string; owner: number };
  'production:complete': { unitType: string; owner: number; buildingId: number };
  'production:started': { unitType: string; owner: number };
  'harvest:delivered': { amount: number; owner: number };
  'harvest:started': { entityId: number };
  'economy:update': { owner: number; solaris: number };
  'power:update': { owner: number; generated: number; used: number };
  'camera:moved': { x: number; z: number };
  'game:tick': { tick: number };
  'game:started': {};
  'game:paused': {};
  'placement:cancelled': { typeName: string };
  'combat:fire': { attackerX: number; attackerZ: number; targetX: number; targetZ: number; weaponType?: string; attackerEntity?: number; targetEntity?: number };
  'worm:emerge': { x: number; z: number };
  'worm:submerge': { x: number; z: number };
  'rally:set': { playerId: number; x: number; z: number };
  'worm:eat': { entityId: number; x: number; z: number; ownerId: number };
  'unit:damaged': { entityId: number; attackerOwner: number; x: number; z: number; isBuilding: boolean };
  'crate:collected': { x: number; z: number; type: string; owner: number };
  'bloom:warning': { x: number; z: number };
  'bloom:tremor': { x: number; z: number; intensity: number };
  'bloom:eruption': { x: number; z: number };
  'combat:blast': { x: number; z: number; radius: number };
  'superweapon:ready': { owner: number; type: string };
  'superweapon:fired': { owner: number; type: string; x: number; z: number };
  'building:survivors': { x: number; z: number; count: number; owner: number };
}

type EventName = keyof EventMap;

class EventBusImpl {
  private listeners = new Map<string, Set<EventCallback<any>>>();

  on<K extends EventName>(event: K, callback: EventCallback<EventMap[K]>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off<K extends EventName>(event: K, callback: EventCallback<EventMap[K]>): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit<K extends EventName>(event: K, data: EventMap[K]): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const EventBus = new EventBusImpl();
export type { EventMap, EventName };
