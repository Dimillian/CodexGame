import type { ContentSet, Placement, SimulationState, Terrain, Tile, WorldEntity } from "./types";
import { createRng } from "./rng";

function rollTerrain(next: () => number): Terrain {
  const value = next();
  if (value < 0.44) {
    return "plains";
  }
  if (value < 0.73) {
    return "forest";
  }
  if (value < 0.9) {
    return "mountain";
  }
  return "water";
}

function defaultActorPosition(width: number, height: number) {
  return {
    x: Math.floor(width / 2),
    y: Math.floor(height / 2)
  };
}

function spawnEntities(
  tiles: Tile[][],
  width: number,
  height: number,
  next: () => number,
  content: ContentSet
): WorldEntity[] {
  const entities: WorldEntity[] = [];
  let sequence = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tile = tiles[y]?.[x];
      if (!tile || tile.terrain === "water") {
        continue;
      }

      for (const biomeRule of content.biomeRules) {
        if (biomeRule.biome !== tile.terrain) {
          continue;
        }
        if (next() <= biomeRule.baseChance) {
          entities.push({
            id: `res-${sequence}`,
            type: "resource",
            subtype: biomeRule.resource,
            x,
            y,
            quantity: Math.floor(next() * 3) + 1
          });
          sequence += 1;
          break;
        }
      }

      for (const spawnRule of content.spawnRules) {
        if (spawnRule.biome !== tile.terrain) {
          continue;
        }
        if (next() <= spawnRule.baseChance) {
          entities.push({
            id: `npc-${sequence}`,
            type: "creature",
            subtype: spawnRule.entity,
            x,
            y,
            quantity: 1
          });
          sequence += 1;
          break;
        }
      }
    }
  }
  return entities;
}

export function createInitialState(
  seed: number,
  width: number,
  height: number,
  content: ContentSet
): SimulationState {
  const next = createRng(seed);
  const tiles: Tile[][] = [];

  for (let y = 0; y < height; y += 1) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x += 1) {
      row.push({ terrain: rollTerrain(next) });
    }
    tiles.push(row);
  }

  const actorPosition = defaultActorPosition(width, height);
  const entities = spawnEntities(tiles, width, height, next, content);
  const placements: Placement[] = [];

  return {
    width,
    height,
    seed,
    tick: 0,
    tiles,
    entities,
    placements,
    actor: {
      id: "agent-1",
      x: actorPosition.x,
      y: actorPosition.y,
      facing: "S",
      stamina: 100,
      inventory: {}
    }
  };
}

export function isBlocked(state: SimulationState, x: number, y: number, content: ContentSet): boolean {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return true;
  }
  const terrain = state.tiles[y]?.[x]?.terrain;
  if (terrain === "water") {
    return true;
  }
  const placement = state.placements.find((item) => item.x === x && item.y === y);
  if (!placement) {
    return false;
  }
  const prefab = content.prefabs.find((item) => item.id === placement.prefabId);
  return prefab ? !prefab.walkable : true;
}
