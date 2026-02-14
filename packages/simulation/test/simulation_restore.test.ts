import { describe, expect, it } from "vitest";
import { Simulation } from "../src/simulation";
import type { ContentSet } from "../src/types";

const content: ContentSet = {
  prefabs: [
    { id: "campfire", name: "Campfire", kind: "structure", walkable: false }
  ],
  recipes: [],
  biomeRules: [],
  spawnRules: []
};

describe("simulation_restore", () => {
  it("restores from persisted state without sharing references", () => {
    const simulation = new Simulation(7, 12, 12, content);
    const state = simulation.getState();
    state.tick = 123;
    state.actor.x = 4;
    state.actor.y = 6;
    state.actor.stamina = 77;
    state.actor.inventory = { campfire: 2 };
    state.tiles[6]![5]!.terrain = "plains";
    state.placements.push({ id: "placement-123-0", prefabId: "campfire", x: 3, y: 3 });

    const restored = Simulation.fromState(state, content);

    expect(restored.getSnapshot()).toEqual(simulation.getSnapshot());

    state.actor.x = 0;
    expect(restored.getState().actor.x).toBe(4);

    const result = restored.applyAction({ type: "place", prefabId: "campfire", x: 5, y: 6 });
    expect(result.result).toBe("applied");
    const placementIds = restored.getState().placements.map((placement) => placement.id);
    expect(placementIds).toContain("placement-123-0");
    expect(placementIds).toContain("placement-123-1");
  });
});
