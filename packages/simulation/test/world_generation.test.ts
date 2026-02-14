import { describe, expect, it } from "vitest";
import { createInitialState } from "../src/world";
import type { ContentSet } from "../src/types";

const content: ContentSet = {
  prefabs: [],
  recipes: [],
  biomeRules: [
    { id: "forest-wood", biome: "forest", resource: "wood", baseChance: 0.5 },
    { id: "mountain-stone", biome: "mountain", resource: "stone", baseChance: 0.45 },
    { id: "plains-fiber", biome: "plains", resource: "fiber", baseChance: 0.4 },
    { id: "forest-mushroom", biome: "forest", resource: "mushroom", baseChance: 0.08 }
  ],
  spawnRules: [
    { id: "wolf", entity: "wolf", biome: "forest", baseChance: 0.06 },
    { id: "slime", entity: "slime", biome: "plains", baseChance: 0.06 }
  ]
};

describe("world_generation", () => {
  it("is deterministic for same seed and content", () => {
    const a = createInitialState(91234, 48, 48, content);
    const b = createInitialState(91234, 48, 48, content);
    expect(a).toEqual(b);
  });

  it("keeps local biome continuity above random-speckle baseline", () => {
    const state = createInitialState(1042, 64, 64, content);
    let sameNeighborPairs = 0;
    let totalPairs = 0;
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const terrain = state.tiles[y]?.[x]?.terrain;
        const right = state.tiles[y]?.[x + 1]?.terrain;
        const down = state.tiles[y + 1]?.[x]?.terrain;

        if (terrain && right) {
          totalPairs += 1;
          if (terrain === right) {
            sameNeighborPairs += 1;
          }
        }
        if (terrain && down) {
          totalPairs += 1;
          if (terrain === down) {
            sameNeighborPairs += 1;
          }
        }
      }
    }

    const continuity = totalPairs > 0 ? sameNeighborPairs / totalPairs : 0;
    expect(continuity).toBeGreaterThan(0.45);
  });

  it("spawns actor on non-water terrain", () => {
    const state = createInitialState(77001, 50, 50, content);
    const terrain = state.tiles[state.actor.y]?.[state.actor.x]?.terrain;
    expect(terrain).not.toBe("water");
  });

  it("spawns creatures at meaningful density across seeds", () => {
    const seeds = [101, 202, 303, 404, 505];
    const counts = seeds.map((seed) => {
      const state = createInitialState(seed, 64, 64, content);
      return state.entities.filter((entity) => entity.type === "creature").length;
    });
    const average = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    expect(average).toBeGreaterThan(10);
    expect(Math.min(...counts)).toBeGreaterThan(2);
  });

  it("does not spawn creatures too close to the actor at world creation", () => {
    const state = createInitialState(88001, 64, 64, content);
    const distances = state.entities
      .filter((entity) => entity.type === "creature")
      .map((entity) => Math.abs(entity.x - state.actor.x) + Math.abs(entity.y - state.actor.y));

    const nearest = distances.length > 0 ? Math.min(...distances) : Infinity;
    expect(nearest).toBeGreaterThan(8);
  });
});
