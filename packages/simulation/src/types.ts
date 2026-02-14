import type { AgentAction, BiomeRule, Prefab, Recipe, SpawnRule } from "@codexgame/protocol";

export type Terrain = "plains" | "forest" | "mountain" | "water";

export type Tile = {
  terrain: Terrain;
};

export type CreatureBehaviorState = "idle" | "chase" | "attack";

export type WorldEntityBase = {
  id: string;
  type: "resource" | "creature";
  subtype: string;
  x: number;
  y: number;
  quantity: number;
};

export type ResourceEntity = WorldEntityBase & {
  type: "resource";
};

export type CreatureEntity = WorldEntityBase & {
  type: "creature";
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  aggroRange: number;
  attackRange: number;
  cooldownTicks: number;
  maxCooldownTicks: number;
  hostile: boolean;
  behaviorState: CreatureBehaviorState;
};

export type WorldEntity = ResourceEntity | CreatureEntity;

export type Placement = {
  id: string;
  prefabId: string;
  x: number;
  y: number;
};

export type ActorState = {
  id: string;
  x: number;
  y: number;
  facing: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  stamina: number;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  attackRange: number;
  cooldownTicks: number;
  maxCooldownTicks: number;
  alive: boolean;
  inventory: Record<string, number>;
};

export type ContentSet = {
  prefabs: Prefab[];
  recipes: Recipe[];
  biomeRules: BiomeRule[];
  spawnRules: SpawnRule[];
};

export type SimulationState = {
  width: number;
  height: number;
  seed: number;
  tick: number;
  tiles: Tile[][];
  entities: WorldEntity[];
  placements: Placement[];
  actor: ActorState;
};

export type ActionResult = {
  action: AgentAction;
  result: "accepted" | "applied" | "rejected";
  reason?: string;
};

export type NearbyEntity = {
  id: string;
  type: string;
  x: number;
  y: number;
  distance: number;
  hp?: number;
  maxHp?: number;
  hostile?: boolean;
};

export type WorldSnapshot = {
  tick: number;
  world: {
    width: number;
    height: number;
    seed: number;
    tiles: string[][];
    entities: WorldEntity[];
    placements: Placement[];
  };
  actor: {
    id: string;
    x: number;
    y: number;
    facing: ActorState["facing"];
    stamina: number;
    hp: number;
    maxHp: number;
    attack: number;
    defense: number;
    attackRange: number;
    cooldownTicks: number;
    alive: boolean;
  };
  inventory: Record<string, number>;
  nearbyEntities: NearbyEntity[];
};
