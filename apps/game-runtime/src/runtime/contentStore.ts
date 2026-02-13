import { promises as fs } from "node:fs";
import path from "node:path";
import {
  biomeRuleSchema,
  buildOutputSchema,
  contentOperationSchema,
  prefabSchema,
  recipeSchema,
  spawnRuleSchema,
  type ContentOperation
} from "@codexgame/protocol";
import type { ContentSet } from "@codexgame/simulation";
import type { BuildApplyResult } from "./types";

const PREFABS_FILE = "prefabs.json";
const RECIPES_FILE = "recipes.json";
const WORLD_RULES_FILE = "world_rules.json";

type WorldRulesFile = {
  biomeRules: unknown[];
  spawnRules: unknown[];
};

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNullableArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeBuildOperation(operation: Record<string, unknown>): Record<string, unknown> {
  const type = asNonEmptyString(operation.type);
  const value = asNullableRecord(operation.value);

  if (type === "upsert_prefab") {
    return {
      type,
      value: {
        id: asNonEmptyString(value.id),
        name: asNonEmptyString(value.name),
        kind: asNonEmptyString(value.kind),
        walkable: Boolean(value.walkable)
      }
    };
  }

  if (type === "upsert_recipe") {
    const recipeInput = asNullableArray(value.recipeInput)
      .map((entry) => asNullableRecord(entry))
      .map((entry) => ({
        item: asNonEmptyString(entry.item),
        count: Number(entry.count ?? 0)
      }));
    const recipeOutput = asNullableRecord(value.recipeOutput);

    return {
      type,
      value: {
        id: asNonEmptyString(value.id),
        input: recipeInput,
        output: {
          item: asNonEmptyString(recipeOutput.item),
          count: Number(recipeOutput.count ?? 0)
        }
      }
    };
  }

  if (type === "upsert_biome_rule") {
    return {
      type,
      value: {
        id: asNonEmptyString(value.id),
        biome: asNonEmptyString(value.biome),
        resource: asNonEmptyString(value.resource),
        baseChance: Number(value.baseChance ?? 0)
      }
    };
  }

  if (type === "upsert_spawn_rule") {
    return {
      type,
      value: {
        id: asNonEmptyString(value.id),
        entity: asNonEmptyString(value.entity),
        biome: asNonEmptyString(value.biome),
        baseChance: Number(value.baseChance ?? 0)
      }
    };
  }

  if (type === "remove_by_id") {
    return {
      type,
      target: asNonEmptyString(operation.target),
      id: asNonEmptyString(operation.id)
    };
  }

  return operation;
}

function normalizeBuildOutput(raw: unknown): unknown {
  const record = asNullableRecord(raw);
  const operations = asNullableArray(record.operations).map((entry) =>
    normalizeBuildOperation(asNullableRecord(entry))
  );

  return {
    summary: asNonEmptyString(record.summary),
    operations
  };
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) {
    return [...items, value];
  }
  const next = [...items];
  next[index] = value;
  return next;
}

function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, filePath);
}

export class ContentStore {
  private readonly contentDir: string;

  private content: ContentSet | null = null;

  public constructor(contentDir: string) {
    this.contentDir = contentDir;
  }

  public async load(): Promise<ContentSet> {
    await fs.mkdir(this.contentDir, { recursive: true });

    const prefabsPath = path.join(this.contentDir, PREFABS_FILE);
    const recipesPath = path.join(this.contentDir, RECIPES_FILE);
    const worldRulesPath = path.join(this.contentDir, WORLD_RULES_FILE);

    const [prefabsRaw, recipesRaw, worldRulesRaw] = await Promise.all([
      fs.readFile(prefabsPath, "utf8"),
      fs.readFile(recipesPath, "utf8"),
      fs.readFile(worldRulesPath, "utf8")
    ]);

    const prefabs = (JSON.parse(prefabsRaw) as unknown[]).map((item) => prefabSchema.parse(item));
    const recipes = (JSON.parse(recipesRaw) as unknown[]).map((item) => recipeSchema.parse(item));

    const worldRules = JSON.parse(worldRulesRaw) as WorldRulesFile;
    const biomeRules = (worldRules.biomeRules ?? []).map((item) => biomeRuleSchema.parse(item));
    const spawnRules = (worldRules.spawnRules ?? []).map((item) => spawnRuleSchema.parse(item));

    this.content = {
      prefabs,
      recipes,
      biomeRules,
      spawnRules
    };

    return this.content;
  }

  public getContent(): ContentSet {
    if (!this.content) {
      throw new Error("content not loaded");
    }
    return this.content;
  }

  public async applyOperations(operations: ContentOperation[]): Promise<BuildApplyResult> {
    if (!this.content) {
      throw new Error("content not loaded");
    }

    operations.forEach((operation) => contentOperationSchema.parse(operation));
    const next: ContentSet = {
      prefabs: [...this.content.prefabs],
      recipes: [...this.content.recipes],
      biomeRules: [...this.content.biomeRules],
      spawnRules: [...this.content.spawnRules]
    };

    for (const operation of operations) {
      switch (operation.type) {
        case "upsert_prefab":
          next.prefabs = upsertById(next.prefabs, operation.value);
          break;
        case "upsert_recipe":
          next.recipes = upsertById(next.recipes, operation.value);
          break;
        case "upsert_biome_rule":
          next.biomeRules = upsertById(next.biomeRules, operation.value);
          break;
        case "upsert_spawn_rule":
          next.spawnRules = upsertById(next.spawnRules, operation.value);
          break;
        case "remove_by_id":
          if (operation.target === "prefab") {
            next.prefabs = removeById(next.prefabs, operation.id);
          } else if (operation.target === "recipe") {
            next.recipes = removeById(next.recipes, operation.id);
          } else if (operation.target === "biome_rule") {
            next.biomeRules = removeById(next.biomeRules, operation.id);
          } else {
            next.spawnRules = removeById(next.spawnRules, operation.id);
          }
          break;
      }
    }

    const prefabsPath = path.join(this.contentDir, PREFABS_FILE);
    const recipesPath = path.join(this.contentDir, RECIPES_FILE);
    const worldRulesPath = path.join(this.contentDir, WORLD_RULES_FILE);

    await Promise.all([
      writeJsonAtomic(prefabsPath, next.prefabs),
      writeJsonAtomic(recipesPath, next.recipes),
      writeJsonAtomic(worldRulesPath, {
        biomeRules: next.biomeRules,
        spawnRules: next.spawnRules
      })
    ]);

    this.content = next;

    return {
      changedFiles: [prefabsPath, recipesPath, worldRulesPath],
      content: next,
      operations
    };
  }

  public parseBuildOutput(text: string) {
    const parsed = JSON.parse(text) as unknown;
    try {
      return buildOutputSchema.parse(parsed);
    } catch {
      return buildOutputSchema.parse(normalizeBuildOutput(parsed));
    }
  }
}
