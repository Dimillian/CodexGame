import type { AgentAction, Direction } from "@codexgame/protocol";
import type { ActionResult, ContentSet, SimulationState, WorldSnapshot } from "./types";
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

function addInventory(inventory: Record<string, number>, item: string, count: number): void {
  inventory[item] = (inventory[item] ?? 0) + count;
  if (inventory[item] <= 0) {
    delete inventory[item];
  }
}

function adjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
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
  }

  public applyAction(action: AgentAction): ActionResult {
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
}
