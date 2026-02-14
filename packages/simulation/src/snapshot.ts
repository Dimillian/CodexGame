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
        score: { ...agent.score },
        scoreTrack: { ...agent.scoreTrack },
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
  const allyIds = new Set(self?.relations.allies ?? []);
  const enemyIds = new Set(self?.relations.enemies ?? []);
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
  const nearbyAllies = peers.filter((peer) => peer.alive && allyIds.has(peer.id) && distance(self?.x ?? 0, self?.y ?? 0, peer.x, peer.y) <= 3).length;
  const nearbyEnemies = peers.filter((peer) => peer.alive && enemyIds.has(peer.id) && distance(self?.x ?? 0, self?.y ?? 0, peer.x, peer.y) <= 3).length;
  const milestones: string[] = [];
  if ((self?.scoreTrack.crafts ?? 0) < 1) {
    milestones.push("Craft at least one useful item soon.");
  }
  if ((self?.scoreTrack.structuresPlaced ?? 0) < 1) {
    milestones.push("Place at least one structure when inventory allows.");
  }
  if ((self?.relations.allies.length ?? 0) > 0 && (self?.scoreTrack.cooperativeTalks ?? 0) < 2) {
    milestones.push("Send a concrete coordination update to an ally.");
  }
  if ((self?.scoreTrack.idleStreak ?? 0) >= 2) {
    milestones.push("Break idle loop: prefer gather/craft/place/inspect over repeated wait/interact.");
  }
  if ((self?.relations.enemies.length ?? 0) > 0 && nearbyEnemies > 0) {
    milestones.push("If combat is risky, inspect enemy first and reposition before attacking.");
  }
  if (milestones.length === 0) {
    milestones.push("Continue safe progression while keeping allies informed.");
  }

  return JSON.stringify(
    {
      tick: snapshot.tick,
      self: self ?? null,
      scoreGuidance: {
        weights: {
          survival: 0.6,
          progression: 0.3,
          social: 0.1
        },
        goals: [
          "Prioritize survival and low-risk positioning.",
          "Progress by gathering/crafting/placing to improve progression score.",
          "Cooperate with allies using meaningful talk updates.",
          "Use social actions strategically; aggression should be conditional, not default.",
          "Avoid repeating wait/interact when better actions are available."
        ]
      },
      tacticalHints: {
        nearbyAllies,
        nearbyEnemies,
        recommendedActionBias: "gather over interact for resources"
      },
      milestones,
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
