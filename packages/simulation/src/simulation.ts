import type { AgentAction, Direction } from "@codexgame/protocol";
import type { ActionResult, AgentConfig, AgentState, ContentSet, CreatureEntity, SimulationState, WorldSnapshot } from "./types";
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

function ensureAgentDefaults(agent: AgentState): AgentState {
  const maxHp = Number.isFinite(agent.maxHp) ? Math.max(1, Math.floor(agent.maxHp)) : 32;
  const hp = Number.isFinite(agent.hp) ? Math.max(0, Math.min(maxHp, Math.floor(agent.hp))) : maxHp;
  const maxCooldownTicks = Number.isFinite(agent.maxCooldownTicks) ? Math.max(1, Math.floor(agent.maxCooldownTicks)) : 2;

  return {
    ...agent,
    maxHp,
    hp,
    attack: Number.isFinite(agent.attack) ? Math.max(1, Math.floor(agent.attack)) : 4,
    defense: Number.isFinite(agent.defense) ? Math.max(0, Math.floor(agent.defense)) : 2,
    attackRange: Number.isFinite(agent.attackRange) ? Math.max(1, Math.floor(agent.attackRange)) : 1,
    maxCooldownTicks,
    cooldownTicks: Number.isFinite(agent.cooldownTicks)
      ? Math.max(0, Math.min(maxCooldownTicks, Math.floor(agent.cooldownTicks)))
      : 0,
    alive: typeof agent.alive === "boolean" ? agent.alive : hp > 0,
    inventory: { ...agent.inventory },
    knownAgentInventories: Object.fromEntries(
      Object.entries(agent.knownAgentInventories ?? {}).map(([id, snapshot]) => [
        id,
        {
          inventory: { ...(snapshot?.inventory ?? {}) },
          tick: Number.isFinite(snapshot?.tick) ? Math.max(0, Math.floor(snapshot.tick)) : 0
        }
      ])
    ),
    relations: { ...(agent.relations ?? {}) },
    inbox: Array.isArray(agent.inbox) ? [...agent.inbox] : []
  };
}

function hydrateLegacyCombatState(state: SimulationState): void {
  const maybeLegacy = state as SimulationState & { actor?: Omit<AgentState, "name"> & { name?: string } };
  if ((!state.agents || state.agents.length === 0) && maybeLegacy.actor) {
    state.agents = [
      ensureAgentDefaults({
        ...maybeLegacy.actor,
        name: maybeLegacy.actor.name ?? "Agent 1"
      })
    ];
  } else {
    state.agents = state.agents.map((agent) => ensureAgentDefaults(agent));
  }
  const agentIds = state.agents.map((agent) => agent.id);
  for (const agent of state.agents) {
    for (const otherId of agentIds) {
      if (otherId === agent.id) {
        continue;
      }
      if (!agent.relations[otherId]) {
        agent.relations[otherId] = "neutral";
      }
    }
  }

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
    agents: state.agents.map((agent) => ({
      ...agent,
      inventory: { ...agent.inventory },
      knownAgentInventories: Object.fromEntries(
        Object.entries(agent.knownAgentInventories ?? {}).map(([id, snapshot]) => [
          id,
          {
            inventory: { ...snapshot.inventory },
            tick: snapshot.tick
          }
        ])
      ),
      relations: { ...agent.relations },
      inbox: [...agent.inbox]
    }))
  };
}

function defaultAgents(): AgentConfig[] {
  return [{ id: "agent-1", name: "Agent 1" }];
}

export class Simulation {
  private state: SimulationState;

  private content: ContentSet;

  private placementSequence = 0;

  public constructor(seed: number, width: number, height: number, content: ContentSet, agentConfigs: AgentConfig[] = defaultAgents()) {
    this.content = content;
    this.state = createInitialState(seed, width, height, content, agentConfigs);
  }

  public static fromState(state: SimulationState, content: ContentSet): Simulation {
    const simulation = new Simulation(state.seed, state.width, state.height, content, state.agents);
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
    for (const agent of this.state.agents) {
      if (agent.cooldownTicks > 0) {
        agent.cooldownTicks -= 1;
      }
    }
    this.tickCreatureAi();
  }

  public applyAction(agentId: string, action: AgentAction): ActionResult {
    const agent = this.state.agents.find((item) => item.id === agentId);
    if (!agent) {
      return { agentId, action, result: "rejected", reason: "agent_not_found" };
    }

    if (!agent.alive) {
      return { agentId, action, result: "rejected", reason: "actor_dead" };
    }

    switch (action.type) {
      case "move": {
        agent.facing = action.direction;
        const stepVector = directionVector[action.direction];
        for (let step = 0; step < action.steps; step += 1) {
          const nextX = agent.x + stepVector.dx;
          const nextY = agent.y + stepVector.dy;
          if (isBlocked(this.state, nextX, nextY, this.content, { ignoreAgentId: agentId })) {
            return {
              agentId,
              action,
              result: "rejected",
              reason: "blocked"
            };
          }
          agent.x = nextX;
          agent.y = nextY;
        }
        agent.stamina = Math.max(0, agent.stamina - action.steps * 2);
        return { agentId, action, result: "applied" };
      }
      case "interact": {
        const entity = this.state.entities.find((item) => item.id === action.targetId);
        if (!entity) {
          return { agentId, action, result: "rejected", reason: "target_not_found" };
        }
        if (entity.type === "creature") {
          return { agentId, action, result: "rejected", reason: "use_attack_action" };
        }
        if (!adjacent(agent.x, agent.y, entity.x, entity.y)) {
          return { agentId, action, result: "rejected", reason: "target_not_reachable" };
        }
        return { agentId, action, result: "applied" };
      }
      case "gather": {
        const entity = this.state.entities.find((item) => item.id === action.targetId && item.type === "resource");
        if (!entity) {
          return { agentId, action, result: "rejected", reason: "resource_not_found" };
        }
        if (!adjacent(agent.x, agent.y, entity.x, entity.y)) {
          return { agentId, action, result: "rejected", reason: "resource_not_reachable" };
        }
        if (entity.quantity <= 0) {
          return { agentId, action, result: "rejected", reason: "resource_depleted" };
        }
        addInventory(agent.inventory, entity.subtype, 1);
        entity.quantity -= 1;
        if (entity.quantity <= 0) {
          this.state.entities = this.state.entities.filter((item) => item.id !== entity.id);
        }
        return { agentId, action, result: "applied" };
      }
      case "attack": {
        if (agent.cooldownTicks > 0) {
          return { agentId, action, result: "rejected", reason: "attack_cooldown" };
        }
        const targetCreature = this.state.entities.find(
          (item): item is CreatureEntity => item.id === action.targetId && item.type === "creature"
        );
        if (targetCreature) {
          const distance = manhattanDistance(agent.x, agent.y, targetCreature.x, targetCreature.y);
          if (distance > agent.attackRange) {
            return { agentId, action, result: "rejected", reason: "target_not_in_range" };
          }
          const damage = computeDamage(agent.attack, targetCreature.defense);
          targetCreature.hp = Math.max(0, targetCreature.hp - damage);
          targetCreature.behaviorState = "attack";
          agent.cooldownTicks = agent.maxCooldownTicks;
          agent.stamina = Math.max(0, agent.stamina - ATTACK_STAMINA_COST);
          if (targetCreature.hp <= 0) {
            this.state.entities = this.state.entities.filter((item) => item.id !== targetCreature.id);
          }
          return { agentId, action, result: "applied" };
        }

        const targetAgent = this.state.agents.find((item) => item.id === action.targetId);
        if (!targetAgent) {
          return { agentId, action, result: "rejected", reason: "target_not_attackable" };
        }
        if (targetAgent.id === agentId) {
          return { agentId, action, result: "rejected", reason: "cannot_attack_self" };
        }
        if (!targetAgent.alive) {
          return { agentId, action, result: "rejected", reason: "target_not_alive" };
        }
        if (agent.relations[targetAgent.id] !== "enemy") {
          return { agentId, action, result: "rejected", reason: "target_not_enemy" };
        }
        const distance = manhattanDistance(agent.x, agent.y, targetAgent.x, targetAgent.y);
        if (distance > agent.attackRange) {
          return { agentId, action, result: "rejected", reason: "target_not_in_range" };
        }
        const damage = computeDamage(agent.attack, targetAgent.defense);
        targetAgent.hp = Math.max(0, targetAgent.hp - damage);
        targetAgent.alive = targetAgent.hp > 0;
        agent.cooldownTicks = agent.maxCooldownTicks;
        agent.stamina = Math.max(0, agent.stamina - ATTACK_STAMINA_COST);
        return { agentId, action, result: "applied" };
      }
      case "craft": {
        const recipe = this.content.recipes.find((item) => item.id === action.recipeId);
        if (!recipe) {
          return { agentId, action, result: "rejected", reason: "recipe_not_found" };
        }
        const hasAll = recipe.input.every((ingredient) => (agent.inventory[ingredient.item] ?? 0) >= ingredient.count);
        if (!hasAll) {
          return { agentId, action, result: "rejected", reason: "missing_ingredients" };
        }
        for (const ingredient of recipe.input) {
          addInventory(agent.inventory, ingredient.item, -ingredient.count);
        }
        addInventory(agent.inventory, recipe.output.item, recipe.output.count);
        return { agentId, action, result: "applied" };
      }
      case "place": {
        if (isBlocked(this.state, action.x, action.y, this.content, { ignoreAgentId: agentId })) {
          return { agentId, action, result: "rejected", reason: "placement_blocked" };
        }
        const prefab = this.content.prefabs.find((item) => item.id === action.prefabId);
        if (!prefab) {
          return { agentId, action, result: "rejected", reason: "prefab_not_found" };
        }
        if (prefab.kind !== "structure") {
          return { agentId, action, result: "rejected", reason: "prefab_not_placeable" };
        }
        const available = agent.inventory[action.prefabId] ?? 0;
        if (available < 1) {
          return { agentId, action, result: "rejected", reason: "missing_prefab_item" };
        }
        addInventory(agent.inventory, action.prefabId, -1);
        this.state.placements.push({
          id: `placement-${this.state.tick}-${this.placementSequence}`,
          prefabId: action.prefabId,
          x: action.x,
          y: action.y
        });
        this.placementSequence += 1;
        return { agentId, action, result: "applied" };
      }
      case "wait": {
        agent.stamina = Math.min(100, agent.stamina + action.ticks * 2);
        return { agentId, action, result: "applied" };
      }
      case "talk": {
        const recipient = this.state.agents.find((item) => item.id === action.toAgentId);
        if (!recipient) {
          return { agentId, action, result: "rejected", reason: "recipient_not_found" };
        }
        if (recipient.id === agentId) {
          return { agentId, action, result: "rejected", reason: "cannot_talk_to_self" };
        }
        recipient.inbox.push({
          fromAgentId: agentId,
          message: action.message,
          tick: this.state.tick
        });
        if (recipient.inbox.length > 20) {
          recipient.inbox = recipient.inbox.slice(-20);
        }
        return { agentId, action, result: "applied" };
      }
      case "set_relation": {
        const target = this.state.agents.find((item) => item.id === action.targetAgentId);
        if (!target) {
          return { agentId, action, result: "rejected", reason: "target_agent_not_found" };
        }
        if (target.id === agentId) {
          return { agentId, action, result: "rejected", reason: "cannot_set_self_relation" };
        }
        agent.relations[target.id] = action.relation;
        return { agentId, action, result: "applied" };
      }
      case "inspect_agent": {
        const target = this.state.agents.find((item) => item.id === action.targetAgentId);
        if (!target) {
          return { agentId, action, result: "rejected", reason: "target_agent_not_found" };
        }
        if (target.id === agentId) {
          return { agentId, action, result: "rejected", reason: "cannot_inspect_self" };
        }
        const distance = manhattanDistance(agent.x, agent.y, target.x, target.y);
        if (distance > 2) {
          return { agentId, action, result: "rejected", reason: "target_too_far" };
        }
        agent.knownAgentInventories[target.id] = {
          inventory: { ...target.inventory },
          tick: this.state.tick
        };
        return { agentId, action, result: "applied" };
      }
      case "loot_agent": {
        const target = this.state.agents.find((item) => item.id === action.targetAgentId);
        if (!target) {
          return { agentId, action, result: "rejected", reason: "target_agent_not_found" };
        }
        if (target.id === agentId) {
          return { agentId, action, result: "rejected", reason: "cannot_loot_self" };
        }
        if (target.alive) {
          return { agentId, action, result: "rejected", reason: "target_not_dead" };
        }
        if (!adjacent(agent.x, agent.y, target.x, target.y)) {
          return { agentId, action, result: "rejected", reason: "target_not_reachable" };
        }
        for (const [item, count] of Object.entries(target.inventory)) {
          if (count > 0) {
            addInventory(agent.inventory, item, count);
          }
        }
        target.inventory = {};
        return { agentId, action, result: "applied" };
      }
      default:
        return { agentId, action, result: "rejected", reason: "unsupported_action" };
    }
  }

  private aliveAgents(): AgentState[] {
    return this.state.agents.filter((agent) => agent.alive).sort((a, b) => a.id.localeCompare(b.id));
  }

  private findCreatureTarget(creature: CreatureEntity): AgentState | null {
    let best: AgentState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const agent of this.aliveAgents()) {
      const distance = manhattanDistance(agent.x, agent.y, creature.x, creature.y);
      if (distance < bestDistance) {
        best = agent;
        bestDistance = distance;
      }
    }
    return best;
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

      if (!creature.hostile || this.aliveAgents().length === 0) {
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

      const target = this.findCreatureTarget(creature);
      if (!target) {
        creature.behaviorState = "idle";
        continue;
      }

      const distance = manhattanDistance(target.x, target.y, creature.x, creature.y);
      if (distance <= creature.attackRange) {
        creature.behaviorState = "attack";
        if (canAttackThisTick && attackersThisTick < MAX_CREATURE_ATTACKERS_PER_TICK && creature.cooldownTicks === 0) {
          this.applyCreatureAttack(creature, target);
          attackersThisTick += 1;
        }
        continue;
      }

      if (distance <= creature.aggroRange) {
        creature.behaviorState = "chase";
        if (canMoveThisTick) {
          this.stepCreatureTowardAgent(creature, target);
        }
        continue;
      }

      creature.behaviorState = "idle";
      if (canMoveThisTick) {
        this.maybeWander(creature);
      }
    }
  }

  private applyCreatureAttack(creature: CreatureEntity, target: AgentState): void {
    if (!target.alive) {
      return;
    }
    const damage = computeDamage(creature.attack, target.defense);
    target.hp = Math.max(0, target.hp - damage);
    target.alive = target.hp > 0;
    creature.cooldownTicks = creature.maxCooldownTicks;
  }

  private stepCreatureTowardAgent(creature: CreatureEntity, target: AgentState): void {
    const dx = Math.sign(target.x - creature.x);
    const dy = Math.sign(target.y - creature.y);

    const axisBias = hashUnit(this.state.seed, this.state.tick, hashString(creature.id, 919), 193);
    const xFirst = Math.abs(target.x - creature.x) > Math.abs(target.y - creature.y) || axisBias < 0.5;

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
    const occupiedByAgent = this.state.agents.some((agent) => agent.alive && agent.x === nextX && agent.y === nextY);
    if (occupiedByAgent) {
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
