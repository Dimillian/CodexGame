import { describe, expect, it } from "vitest";
import { Simulation } from "../src/simulation";
import type { ContentSet } from "../src/types";

const content: ContentSet = {
  prefabs: [{ id: "campfire", name: "Campfire", kind: "structure", walkable: false }],
  recipes: [
    {
      id: "campfire_recipe",
      input: [
        { item: "wood", count: 3 },
        { item: "stone", count: 2 }
      ],
      output: { item: "campfire", count: 1 }
    }
  ],
  biomeRules: [
    { id: "forest-wood", biome: "forest", resource: "wood", baseChance: 0.5 },
    { id: "mountain-stone", biome: "mountain", resource: "stone", baseChance: 0.4 }
  ],
  spawnRules: [{ id: "slime", entity: "slime", biome: "plains", baseChance: 0.03 }]
};

describe("simulation_determinism", () => {
  it("produces identical state for same seed and action stream", () => {
    const agents = [
      { id: "agent-1", name: "Agent 1" },
      { id: "agent-2", name: "Agent 2" }
    ];
    const a = new Simulation(42, 40, 40, content, agents);
    const b = new Simulation(42, 40, 40, content, agents);

    const actions = [
      { type: "move", direction: "E", steps: 2 } as const,
      { type: "wait", ticks: 2 } as const,
      { type: "move", direction: "S", steps: 1 } as const
    ];

    for (const action of actions) {
      a.applyAction("agent-1", action);
      b.applyAction("agent-1", action);
      a.tick();
      b.tick();
    }

    expect(a.getSnapshot()).toEqual(b.getSnapshot());
  });
});
