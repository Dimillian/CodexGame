import type { ContentSet, Placement, SimulationState, Terrain, Tile, WorldEntity } from "./types";

const TERRAIN_SMOOTHING_PASSES = 1;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function hashUnit(seed: number, x: number, y: number, salt: number): number {
  let value = seed ^ Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 0xc2b2ae35, 0x27d4eb2d) ^ salt;
  value ^= value >>> 15;
  value = Math.imul(value, 0x2c1b3c6d);
  value ^= value >>> 12;
  value = Math.imul(value, 0x297a2d39);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967295;
}

function hashString(value: string, seed: number): number {
  let hash = seed ^ 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function valueNoise(seed: number, x: number, y: number, frequency: number, salt: number): number {
  const fx = x * frequency;
  const fy = y * frequency;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smoothstep(fx - x0);
  const ty = smoothstep(fy - y0);

  const v00 = hashUnit(seed, x0, y0, salt);
  const v10 = hashUnit(seed, x0 + 1, y0, salt);
  const v01 = hashUnit(seed, x0, y0 + 1, salt);
  const v11 = hashUnit(seed, x0 + 1, y0 + 1, salt);

  const nx0 = lerp(v00, v10, tx);
  const nx1 = lerp(v01, v11, tx);
  return lerp(nx0, nx1, ty);
}

function fractalNoise(
  seed: number,
  x: number,
  y: number,
  baseFrequency: number,
  octaves: number,
  persistence: number,
  lacunarity: number,
  salt: number
): number {
  let frequency = baseFrequency;
  let amplitude = 1;
  let sum = 0;
  let weightSum = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    sum += valueNoise(seed, x, y, frequency, salt + octave * 9176) * amplitude;
    weightSum += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return weightSum > 0 ? sum / weightSum : 0.5;
}

function rollTerrain(seed: number, x: number, y: number): Terrain {
  const elevation = fractalNoise(seed, x, y, 0.075, 4, 0.55, 2.0, 101);
  const moisture = fractalNoise(seed, x, y, 0.07, 3, 0.6, 2.1, 211);
  const ridge = Math.abs(0.5 - fractalNoise(seed, x, y, 0.11, 3, 0.5, 2.4, 307)) * 2;

  if (elevation < 0.31) {
    return "water";
  }
  if (elevation > 0.76 || (elevation > 0.63 && ridge > 0.63)) {
    return "mountain";
  }
  if (moisture > 0.54) {
    return "forest";
  }
  return "plains";
}

function smoothTerrain(tiles: Tile[][], width: number, height: number): Tile[][] {
  const terrainGrid = tiles.map((row) => row.map((tile) => tile.terrain));

  for (let pass = 0; pass < TERRAIN_SMOOTHING_PASSES; pass += 1) {
    const next = terrainGrid.map((row) => [...row]);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const counts = new Map<Terrain, number>();
        for (let ny = y - 1; ny <= y + 1; ny += 1) {
          for (let nx = x - 1; nx <= x + 1; nx += 1) {
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              continue;
            }
            const terrain = terrainGrid[ny]?.[nx];
            if (!terrain) {
              continue;
            }
            counts.set(terrain, (counts.get(terrain) ?? 0) + 1);
          }
        }
        let winner = terrainGrid[y]?.[x] ?? "plains";
        let winnerCount = -1;
        for (const [terrain, count] of counts) {
          if (count > winnerCount) {
            winner = terrain;
            winnerCount = count;
          }
        }
        if (winnerCount >= 5) {
          next[y]![x] = winner;
        }
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = next[y]?.[x] ?? terrainGrid[y]?.[x] ?? "plains";
        terrainGrid[y]![x] = value;
      }
    }
  }

  return terrainGrid.map((row) => row.map((terrain) => ({ terrain })));
}

function defaultActorPosition(tiles: Tile[][], width: number, height: number) {
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  if (tiles[centerY]?.[centerX]?.terrain !== "water") {
    return { x: centerX, y: centerY };
  }

  const maxRadius = Math.max(width, height);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    const minX = Math.max(0, centerX - radius);
    const maxX = Math.min(width - 1, centerX + radius);
    const minY = Math.max(0, centerY - radius);
    const maxY = Math.min(height - 1, centerY + radius);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (tiles[y]?.[x]?.terrain !== "water") {
          return { x, y };
        }
      }
    }
  }

  return { x: centerX, y: centerY };
}

function clusteredScore(seed: number, x: number, y: number, salt: number): number {
  const macro = fractalNoise(seed, x, y, 0.05, 3, 0.58, 2.0, salt);
  const local = fractalNoise(seed, x, y, 0.18, 2, 0.65, 2.3, salt + 113);
  return macro * 0.7 + local * 0.3;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clusteredSpawnChance(baseChance: number, score: number, minMultiplier: number, maxMultiplier: number): number {
  const multiplier = lerp(minMultiplier, maxMultiplier, clamp01(score));
  return clamp01(baseChance * multiplier);
}

function spawnEntities(
  tiles: Tile[][],
  width: number,
  height: number,
  seed: number,
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
        const resourceSalt = hashString(biomeRule.id, 173);
        const score = clusteredScore(seed, x, y, resourceSalt);
        const spawnChance = clusteredSpawnChance(biomeRule.baseChance, score, 0.45, 1.55);
        const roll = hashUnit(seed, x, y, resourceSalt + 997);
        if (roll <= spawnChance) {
          const quantity = 1 + Math.floor(hashUnit(seed, x, y, resourceSalt + 41) * 3);
          entities.push({
            id: `res-${sequence}`,
            type: "resource",
            subtype: biomeRule.resource,
            x,
            y,
            quantity
          });
          sequence += 1;
          break;
        }
      }

      for (const spawnRule of content.spawnRules) {
        if (spawnRule.biome !== tile.terrain) {
          continue;
        }
        const spawnSalt = hashString(spawnRule.id, 257);
        const score = clusteredScore(seed, x, y, spawnSalt);
        const spawnChance = clusteredSpawnChance(spawnRule.baseChance, score, 0.6, 2.2);
        const roll = hashUnit(seed, x, y, spawnSalt + 1319);
        if (roll <= spawnChance) {
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
  let tiles: Tile[][] = [];

  for (let y = 0; y < height; y += 1) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x += 1) {
      row.push({ terrain: rollTerrain(seed, x, y) });
    }
    tiles.push(row);
  }
  tiles = smoothTerrain(tiles, width, height);

  const actorPosition = defaultActorPosition(tiles, width, height);
  const entities = spawnEntities(tiles, width, height, seed, content);
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
