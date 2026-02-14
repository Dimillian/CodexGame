import { describe, expect, it } from "vitest";
import { Simulation } from "../src/simulation";
import type { ContentSet } from "../src/types";

const content: ContentSet = {
  prefabs: [{ id: "campfire", name: "Campfire", kind: "structure", walkable: false }],
  recipes: [
    {
      id: "campfire_recipe",
      input: [{ item: "wood", count: 2 }],
      output: { item: "campfire", count: 1 }
    }
  ],
  biomeRules: [],
  spawnRules: []
};

function flattenToPlains(simulation: Simulation): void {
  const state = simulation.getState();
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const tile = state.tiles[y]?.[x];
      if (!tile) {
        continue;
      }
      tile.terrain = "plains";
    }
  }
}

describe("scoring", () => {
  it("rewards survival and progression through craft/place", () => {
    const simulation = new Simulation(901, 12, 12, content, [{ id: "agent-1", name: "Agent 1" }]);
    flattenToPlains(simulation);
    const state = simulation.getState();
    const agent = state.agents[0]!;
    agent.inventory.wood = 2;
    agent.x = 5;
    agent.y = 5;

    const before = { ...agent.score };
    const crafted = simulation.applyAction("agent-1", { type: "craft", recipeId: "campfire_recipe" });
    expect(crafted.result).toBe("applied");
    const placed = simulation.applyAction("agent-1", { type: "place", prefabId: "campfire", x: 6, y: 5 });
    expect(placed.result).toBe("applied");

    expect(agent.scoreTrack.crafts).toBe(1);
    expect(agent.scoreTrack.structuresPlaced).toBe(1);
    expect(agent.score.progression).toBeGreaterThan(before.progression);
    expect(agent.score.survival).toBeGreaterThanOrEqual(agent.score.social);
  });

  it("rewards social score when defeating an enemy agent", () => {
    const simulation = new Simulation(902, 12, 12, content, [
      { id: "agent-1", name: "Agent 1" },
      { id: "agent-2", name: "Agent 2" }
    ]);
    flattenToPlains(simulation);
    const state = simulation.getState();
    const a1 = state.agents.find((agent) => agent.id === "agent-1")!;
    const a2 = state.agents.find((agent) => agent.id === "agent-2")!;
    a1.x = 4;
    a1.y = 4;
    a1.attack = 20;
    a1.attackRange = 1;
    a1.cooldownTicks = 0;
    a1.maxCooldownTicks = 1;
    a2.x = 5;
    a2.y = 4;
    a2.hp = 8;
    a2.maxHp = 8;
    a2.alive = true;

    const setEnemy = simulation.applyAction("agent-1", { type: "set_relation", targetAgentId: "agent-2", relation: "enemy" });
    expect(setEnemy.result).toBe("applied");
    const beforeSocial = a1.score.social;
    const attack = simulation.applyAction("agent-1", { type: "attack", targetId: "agent-2" });
    expect(attack.result).toBe("applied");

    expect(a2.alive).toBe(false);
    expect(a1.scoreTrack.enemyAgentKills).toBe(1);
    expect(a1.score.social).toBeGreaterThan(beforeSocial);
    expect(a1.score.survival).toBeGreaterThanOrEqual(a1.score.social);
  });
});
