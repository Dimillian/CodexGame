import type { NearbyEntity, SimulationState, WorldEntity, WorldSnapshot } from "./types";

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function toNearbyEntity(agentX: number, agentY: number, entity: WorldEntity): NearbyEntity {
  const base: NearbyEntity = {
    id: entity.id,
    type: `${entity.type}:${entity.subtype}`,
    x: entity.x,
    y: entity.y,
    distance: distance(agentX, agentY, entity.x, entity.y)
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
    agents: state.agents.map((agent) => {
      const nearbyEntities = state.entities
        .map((entity) => toNearbyEntity(agent.x, agent.y, entity))
        .filter((entity) => entity.distance <= 5)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 20);

      return {
        id: agent.id,
        name: agent.name,
        x: agent.x,
        y: agent.y,
        facing: agent.facing,
        stamina: agent.stamina,
        hp: agent.hp,
        maxHp: agent.maxHp,
        attack: agent.attack,
        defense: agent.defense,
        attackRange: agent.attackRange,
        cooldownTicks: agent.cooldownTicks,
        alive: agent.alive,
        inventory: { ...agent.inventory },
        knownPeerInventories: Object.fromEntries(
          Object.entries(agent.knownAgentInventories).map(([id, snapshot]) => [
            id,
            {
              inventory: { ...snapshot.inventory },
              tick: snapshot.tick
            }
          ])
        ),
        nearbyEntities,
        relations: {
          allies: Object.entries(agent.relations)
            .filter(([, relation]) => relation === "ally")
            .map(([id]) => id)
            .sort(),
          enemies: Object.entries(agent.relations)
            .filter(([, relation]) => relation === "enemy")
            .map(([id]) => id)
            .sort(),
          neutral: Object.entries(agent.relations)
            .filter(([, relation]) => relation === "neutral")
            .map(([id]) => id)
            .sort()
        },
        inbox: agent.inbox.map((entry) => ({ ...entry }))
      };
    })
  };
}

export function buildPromptContext(snapshot: WorldSnapshot, agentId: string): string {
  const self = snapshot.agents.find((agent) => agent.id === agentId);
  const peers = snapshot.agents
    .filter((agent) => agent.id !== agentId)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      x: agent.x,
      y: agent.y,
      hp: agent.hp,
      maxHp: agent.maxHp,
      alive: agent.alive,
      knownInventory: self?.knownPeerInventories[agent.id]?.inventory ?? null,
      knownInventoryTick: self?.knownPeerInventories[agent.id]?.tick ?? null,
      relation: self?.relations.allies.includes(agent.id)
        ? "ally"
        : self?.relations.enemies.includes(agent.id)
          ? "enemy"
          : "neutral"
    }));

  return JSON.stringify(
    {
      tick: snapshot.tick,
      self: self ?? null,
      peers,
      recentInbox: (self?.inbox ?? []).slice(-8),
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
