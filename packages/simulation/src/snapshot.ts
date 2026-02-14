import type { NearbyEntity, SimulationState, WorldEntity, WorldSnapshot } from "./types";

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function toNearbyEntity(actorX: number, actorY: number, entity: WorldEntity): NearbyEntity {
  const base: NearbyEntity = {
    id: entity.id,
    type: `${entity.type}:${entity.subtype}`,
    x: entity.x,
    y: entity.y,
    distance: distance(actorX, actorY, entity.x, entity.y)
  };
  if (entity.type === "creature") {
    return {
      ...base,
      hp: entity.hp,
      maxHp: entity.maxHp,
      hostile: entity.hostile
    };
  }
  return base;
}

export function buildSnapshot(state: SimulationState): WorldSnapshot {
  const nearbyEntities = state.entities
    .map((entity) => toNearbyEntity(state.actor.x, state.actor.y, entity))
    .filter((entity) => entity.distance <= 5)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 20);

  return {
    tick: state.tick,
    world: {
      width: state.width,
      height: state.height,
      seed: state.seed,
      tiles: state.tiles.map((row) => row.map((tile) => tile.terrain)),
      entities: [...state.entities],
      placements: [...state.placements]
    },
    actor: {
      id: state.actor.id,
      x: state.actor.x,
      y: state.actor.y,
      facing: state.actor.facing,
      stamina: state.actor.stamina,
      hp: state.actor.hp,
      maxHp: state.actor.maxHp,
      attack: state.actor.attack,
      defense: state.actor.defense,
      attackRange: state.actor.attackRange,
      cooldownTicks: state.actor.cooldownTicks,
      alive: state.actor.alive
    },
    inventory: { ...state.actor.inventory },
    nearbyEntities
  };
}

export function buildPromptContext(snapshot: WorldSnapshot): string {
  return JSON.stringify(
    {
      tick: snapshot.tick,
      actor: snapshot.actor,
      inventory: snapshot.inventory,
      nearbyEntities: snapshot.nearbyEntities,
      constraints: {
        mapSize: [snapshot.world.width, snapshot.world.height],
        maxActions: 4,
        schemaOnly: true
      }
    },
    null,
    2
  );
}
