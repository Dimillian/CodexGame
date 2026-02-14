import type { AgentAction, Direction } from "@codexgame/protocol";
import type { ActionResult, ContentSet, CreatureEntity, SimulationState, WorldSnapshot } from "./types";
import { createInitialState, isBlocked } from "./world";
import { buildSnapshot } from "./snapshot";

const directionVector: Record<Direction, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  NE: { dx: 1, dy: -1 },
  E: { dx: 1, dy: 0 },
  SE: { dx: 1, dy: 1 },
  S: { dx: 0, dy: 1 },
  SW: { dx: -1, dy: 1 },
  W: { dx: -1, dy: 0 },
  NW: { dx: -1, dy: -1 }
};

const ATTACK_STAMINA_COST = 3;
const IDLE_WANDER_CHANCE = 0.08;
const CREATURE_MOVE_TICK_INTERVAL = 6;
const CREATURE_ATTACK_TICK_INTERVAL = 12;
const CREATURE_AGGRO_GRACE_TICKS = 24;
const MAX_CREATURE_ATTACKERS_PER_TICK = 2;

function addInventory(inventory: Record<string, number>, item: string, count: number): void {
  inventory[item] = (inventory[item] ?? 0) + count;
  if (inventory[item] <= 0) {
    delete inventory[item];
  }
}

function adjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
}

function manhattanDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function hashString(value: string, seed: number): number {
  let hash = seed ^ 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function hashUnit(seed: number, a: number, b: number, salt: number): number {
  let value = seed ^ Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0xc2b2ae35, 0x27d4eb2d) ^ salt;
  value ^= value >>> 15;
  value = Math.imul(value, 0x2c1b3c6d);
  value ^= value >>> 12;
  value = Math.imul(value, 0x297a2d39);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967295;
}

function computeDamage(attack: number, defense: number): number {
  return Math.max(1, attack - defense);
}

function defaultCreatureCombat(subtype: string): Pick<
  CreatureEntity,
  "hp" | "maxHp" | "attack" | "defense" | "aggroRange" | "attackRange" | "cooldownTicks" | "maxCooldownTicks" | "hostile" | "behaviorState"
> {
  if (subtype === "wolf") {
    return {
      hp: 14,
      maxHp: 14,
      attack: 3,
      defense: 2,
      aggroRange: 4,
      attackRange: 1,
      cooldownTicks: 0,
      maxCooldownTicks: 4,
      hostile: true,
      behaviorState: "idle"
    };
  }
  if (subtype === "slime") {
    return {
      hp: 9,
      maxHp: 9,
      attack: 2,
      defense: 1,
      aggroRange: 3,
      attackRange: 1,
      cooldownTicks: 0,
      maxCooldownTicks: 5,
      hostile: true,
      behaviorState: "idle"
    };
  }
  return {
    hp: 12,
    maxHp: 12,
    attack: 3,
    defense: 1,
    aggroRange: 5,
    attackRange: 1,
    cooldownTicks: 0,
    maxCooldownTicks: 2,
    hostile: true,
    behaviorState: "idle"
  };
}

function hydrateLegacyCombatState(state: SimulationState): void {
  const actor = state.actor as typeof state.actor & {
    hp?: number;
    maxHp?: number;
    attack?: number;
    defense?: number;
    attackRange?: number;
    cooldownTicks?: number;
    maxCooldownTicks?: number;
    alive?: boolean;
  };
  actor.maxHp = Number.isFinite(actor.maxHp) ? Math.max(1, Math.floor(actor.maxHp)) : 32;
  actor.hp = Number.isFinite(actor.hp) ? Math.max(0, Math.min(actor.maxHp, Math.floor(actor.hp))) : actor.maxHp;
  actor.attack = Number.isFinite(actor.attack) ? Math.max(1, Math.floor(actor.attack)) : 4;
  actor.defense = Number.isFinite(actor.defense) ? Math.max(0, Math.floor(actor.defense)) : 2;
  actor.attackRange = Number.isFinite(actor.attackRange) ? Math.max(1, Math.floor(actor.attackRange)) : 1;
  actor.maxCooldownTicks = Number.isFinite(actor.maxCooldownTicks) ? Math.max(1, Math.floor(actor.maxCooldownTicks)) : 2;
  actor.cooldownTicks = Number.isFinite(actor.cooldownTicks)
    ? Math.max(0, Math.min(actor.maxCooldownTicks, Math.floor(actor.cooldownTicks)))
    : 0;
  actor.alive = typeof actor.alive === "boolean" ? actor.alive : actor.hp > 0;

  for (const entity of state.entities) {
    if (entity.type !== "creature") {
      continue;
    }
    const creature = entity as CreatureEntity & {
      hp?: number;
      maxHp?: number;
      attack?: number;
      defense?: number;
      aggroRange?: number;
      attackRange?: number;
      cooldownTicks?: number;
      maxCooldownTicks?: number;
      hostile?: boolean;
      behaviorState?: "idle" | "chase" | "attack";
    };
    const defaults = defaultCreatureCombat(creature.subtype);
    creature.maxHp = Number.isFinite(creature.maxHp) ? Math.max(1, Math.floor(creature.maxHp)) : defaults.maxHp;
    creature.hp = Number.isFinite(creature.hp)
      ? Math.max(0, Math.min(creature.maxHp, Math.floor(creature.hp)))
      : defaults.hp;
    creature.attack = Number.isFinite(creature.attack) ? Math.max(1, Math.floor(creature.attack)) : defaults.attack;
    creature.defense = Number.isFinite(creature.defense) ? Math.max(0, Math.floor(creature.defense)) : defaults.defense;
    creature.aggroRange = Number.isFinite(creature.aggroRange)
      ? Math.max(1, Math.floor(creature.aggroRange))
      : defaults.aggroRange;
    creature.attackRange = Number.isFinite(creature.attackRange)
      ? Math.max(1, Math.floor(creature.attackRange))
      : defaults.attackRange;
    creature.maxCooldownTicks = Number.isFinite(creature.maxCooldownTicks)
      ? Math.max(1, Math.floor(creature.maxCooldownTicks))
      : defaults.maxCooldownTicks;
    creature.cooldownTicks = Number.isFinite(creature.cooldownTicks)
      ? Math.max(0, Math.min(creature.maxCooldownTicks, Math.floor(creature.cooldownTicks)))
      : defaults.cooldownTicks;
    creature.hostile = typeof creature.hostile === "boolean" ? creature.hostile : defaults.hostile;
    creature.behaviorState =
      creature.behaviorState === "idle" || creature.behaviorState === "chase" || creature.behaviorState === "attack"
        ? creature.behaviorState
        : defaults.behaviorState;
  }
}

function cloneState(state: SimulationState): SimulationState {
  return {
    width: state.width,
    height: state.height,
    seed: state.seed,
    tick: state.tick,
    tiles: state.tiles.map((row) => row.map((tile) => ({ terrain: tile.terrain }))),
    entities: state.entities.map((entity) => ({ ...entity })),
    placements: state.placements.map((placement) => ({ ...placement })),
    actor: {
      ...state.actor,
      inventory: { ...state.actor.inventory }
    }
  };
}

export class Simulation {
  private state: SimulationState;

  private content: ContentSet;

  private placementSequence = 0;

  public constructor(seed: number, width: number, height: number, content: ContentSet) {
    this.content = content;
    this.state = createInitialState(seed, width, height, content);
  }

  public static fromState(state: SimulationState, content: ContentSet): Simulation {
    const simulation = new Simulation(state.seed, state.width, state.height, content);
    simulation.state = cloneState(state);
    hydrateLegacyCombatState(simulation.state);
    simulation.placementSequence = state.placements.length;
    return simulation;
  }

  public setContent(content: ContentSet): void {
    this.content = content;
  }

  public getState(): SimulationState {
    return this.state;
  }

  public getSnapshot(): WorldSnapshot {
    return buildSnapshot(this.state);
  }

  public tick(): void {
    this.state.tick += 1;
    if (this.state.actor.cooldownTicks > 0) {
      this.state.actor.cooldownTicks -= 1;
    }
    this.tickCreatureAi();
  }

  public applyAction(action: AgentAction): ActionResult {
    if (!this.state.actor.alive) {
      return { action, result: "rejected", reason: "actor_dead" };
    }

    switch (action.type) {
      case "move": {
        this.state.actor.facing = action.direction;
        const stepVector = directionVector[action.direction];
        for (let step = 0; step < action.steps; step += 1) {
          const nextX = this.state.actor.x + stepVector.dx;
          const nextY = this.state.actor.y + stepVector.dy;
          if (isBlocked(this.state, nextX, nextY, this.content)) {
            return {
              action,
              result: "rejected",
              reason: "blocked"
            };
          }
          this.state.actor.x = nextX;
          this.state.actor.y = nextY;
        }
        this.state.actor.stamina = Math.max(0, this.state.actor.stamina - action.steps * 2);
        return { action, result: "applied" };
      }
      case "interact": {
        const entity = this.state.entities.find((item) => item.id === action.targetId);
        if (!entity) {
          return { action, result: "rejected", reason: "target_not_found" };
        }
        if (entity.type === "creature") {
          return { action, result: "rejected", reason: "use_attack_action" };
        }
        if (!adjacent(this.state.actor.x, this.state.actor.y, entity.x, entity.y)) {
          return { action, result: "rejected", reason: "target_not_reachable" };
        }
        return { action, result: "applied" };
      }
      case "gather": {
        const entity = this.state.entities.find((item) => item.id === action.targetId && item.type === "resource");
        if (!entity) {
          return { action, result: "rejected", reason: "resource_not_found" };
        }
        if (!adjacent(this.state.actor.x, this.state.actor.y, entity.x, entity.y)) {
          return { action, result: "rejected", reason: "resource_not_reachable" };
        }
        if (entity.quantity <= 0) {
          return { action, result: "rejected", reason: "resource_depleted" };
        }
        addInventory(this.state.actor.inventory, entity.subtype, 1);
        entity.quantity -= 1;
        if (entity.quantity <= 0) {
          this.state.entities = this.state.entities.filter((item) => item.id !== entity.id);
        }
        return { action, result: "applied" };
      }
      case "attack": {
        const target = this.state.entities.find(
          (item): item is CreatureEntity => item.id === action.targetId && item.type === "creature"
        );
        if (!target) {
          return { action, result: "rejected", reason: "target_not_attackable" };
        }
        if (this.state.actor.cooldownTicks > 0) {
          return { action, result: "rejected", reason: "attack_cooldown" };
        }
        const distance = manhattanDistance(this.state.actor.x, this.state.actor.y, target.x, target.y);
        if (distance > this.state.actor.attackRange) {
          return { action, result: "rejected", reason: "target_not_in_range" };
        }
        const damage = computeDamage(this.state.actor.attack, target.defense);
        target.hp = Math.max(0, target.hp - damage);
        target.behaviorState = "attack";
        this.state.actor.cooldownTicks = this.state.actor.maxCooldownTicks;
        this.state.actor.stamina = Math.max(0, this.state.actor.stamina - ATTACK_STAMINA_COST);
        if (target.hp <= 0) {
          this.state.entities = this.state.entities.filter((item) => item.id !== target.id);
        }
        return { action, result: "applied" };
      }
      case "craft": {
        const recipe = this.content.recipes.find((item) => item.id === action.recipeId);
        if (!recipe) {
          return { action, result: "rejected", reason: "recipe_not_found" };
        }
        const hasAll = recipe.input.every(
          (ingredient) => (this.state.actor.inventory[ingredient.item] ?? 0) >= ingredient.count
        );
        if (!hasAll) {
          return { action, result: "rejected", reason: "missing_ingredients" };
        }
        for (const ingredient of recipe.input) {
          addInventory(this.state.actor.inventory, ingredient.item, -ingredient.count);
        }
        addInventory(this.state.actor.inventory, recipe.output.item, recipe.output.count);
        return { action, result: "applied" };
      }
      case "place": {
        if (isBlocked(this.state, action.x, action.y, this.content)) {
          return { action, result: "rejected", reason: "placement_blocked" };
        }
        const prefab = this.content.prefabs.find((item) => item.id === action.prefabId);
        if (!prefab) {
          return { action, result: "rejected", reason: "prefab_not_found" };
        }
        if (prefab.kind !== "structure") {
          return { action, result: "rejected", reason: "prefab_not_placeable" };
        }
        const available = this.state.actor.inventory[action.prefabId] ?? 0;
        if (available < 1) {
          return { action, result: "rejected", reason: "missing_prefab_item" };
        }
        addInventory(this.state.actor.inventory, action.prefabId, -1);
        this.state.placements.push({
          id: `placement-${this.state.tick}-${this.placementSequence}`,
          prefabId: action.prefabId,
          x: action.x,
          y: action.y
        });
        this.placementSequence += 1;
        return { action, result: "applied" };
      }
      case "wait": {
        this.state.actor.stamina = Math.min(100, this.state.actor.stamina + action.ticks * 2);
        return { action, result: "applied" };
      }
      default:
        return { action, result: "rejected", reason: "unsupported_action" };
    }
  }

  private tickCreatureAi(): void {
    const creatures = this.state.entities
      .filter((entity): entity is CreatureEntity => entity.type === "creature")
      .sort((a, b) => a.id.localeCompare(b.id));
    let attackersThisTick = 0;

    for (const creature of creatures) {
      if (creature.cooldownTicks > 0) {
        creature.cooldownTicks -= 1;
      }
      const movePhase = Math.abs(hashString(creature.id, 701)) % CREATURE_MOVE_TICK_INTERVAL;
      const attackPhase = Math.abs(hashString(creature.id, 907)) % CREATURE_ATTACK_TICK_INTERVAL;
      const canMoveThisTick = this.state.tick % CREATURE_MOVE_TICK_INTERVAL === movePhase;
      const canAttackThisTick = this.state.tick % CREATURE_ATTACK_TICK_INTERVAL === attackPhase;

      if (!creature.hostile || !this.state.actor.alive) {
        creature.behaviorState = "idle";
        if (canMoveThisTick) {
          this.maybeWander(creature);
        }
        continue;
      }

      if (this.state.tick < CREATURE_AGGRO_GRACE_TICKS) {
        creature.behaviorState = "idle";
        if (canMoveThisTick) {
          this.maybeWander(creature);
        }
        continue;
      }

      const distance = manhattanDistance(this.state.actor.x, this.state.actor.y, creature.x, creature.y);
      if (distance <= creature.attackRange) {
        creature.behaviorState = "attack";
        if (canAttackThisTick && attackersThisTick < MAX_CREATURE_ATTACKERS_PER_TICK && creature.cooldownTicks === 0) {
          this.applyCreatureAttack(creature);
          attackersThisTick += 1;
        }
        continue;
      }

      if (distance <= creature.aggroRange) {
        creature.behaviorState = "chase";
        if (canMoveThisTick) {
          this.stepCreatureTowardActor(creature);
        }
        continue;
      }

      creature.behaviorState = "idle";
      if (canMoveThisTick) {
        this.maybeWander(creature);
      }
    }
  }

  private applyCreatureAttack(creature: CreatureEntity): void {
    if (!this.state.actor.alive) {
      return;
    }
    const damage = computeDamage(creature.attack, this.state.actor.defense);
    this.state.actor.hp = Math.max(0, this.state.actor.hp - damage);
    this.state.actor.alive = this.state.actor.hp > 0;
    creature.cooldownTicks = creature.maxCooldownTicks;
  }

  private stepCreatureTowardActor(creature: CreatureEntity): void {
    const dx = Math.sign(this.state.actor.x - creature.x);
    const dy = Math.sign(this.state.actor.y - creature.y);

    const axisBias = hashUnit(this.state.seed, this.state.tick, hashString(creature.id, 919), 193);
    const xFirst = Math.abs(this.state.actor.x - creature.x) > Math.abs(this.state.actor.y - creature.y) || axisBias < 0.5;

    const candidates: Array<{ x: number; y: number }> = [];
    if (dx !== 0 && dy !== 0) {
      candidates.push({ x: creature.x + dx, y: creature.y + dy });
    }
    if (xFirst) {
      if (dx !== 0) {
        candidates.push({ x: creature.x + dx, y: creature.y });
      }
      if (dy !== 0) {
        candidates.push({ x: creature.x, y: creature.y + dy });
      }
    } else {
      if (dy !== 0) {
        candidates.push({ x: creature.x, y: creature.y + dy });
      }
      if (dx !== 0) {
        candidates.push({ x: creature.x + dx, y: creature.y });
      }
    }

    for (const candidate of candidates) {
      if (this.moveCreatureTo(creature, candidate.x, candidate.y)) {
        return;
      }
    }
  }

  private maybeWander(creature: CreatureEntity): void {
    const shouldMove = hashUnit(this.state.seed, this.state.tick, hashString(creature.id, 149), 67) < IDLE_WANDER_CHANCE;
    if (!shouldMove) {
      return;
    }

    const directions: Direction[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const startIndex = Math.floor(hashUnit(this.state.seed, this.state.tick, hashString(creature.id, 521), 87) * directions.length);
    for (let offset = 0; offset < directions.length; offset += 1) {
      const direction = directions[(startIndex + offset) % directions.length];
      if (!direction) {
        continue;
      }
      const vector = directionVector[direction];
      if (this.moveCreatureTo(creature, creature.x + vector.dx, creature.y + vector.dy)) {
        return;
      }
    }
  }

  private moveCreatureTo(creature: CreatureEntity, nextX: number, nextY: number): boolean {
    if (this.state.actor.x === nextX && this.state.actor.y === nextY) {
      return false;
    }
    if (isBlocked(this.state, nextX, nextY, this.content)) {
      return false;
    }
    const occupiedByCreature = this.state.entities.some(
      (entity) => entity.type === "creature" && entity.id !== creature.id && entity.x === nextX && entity.y === nextY
    );
    if (occupiedByCreature) {
      return false;
    }
    creature.x = nextX;
    creature.y = nextY;
    return true;
  }
}
