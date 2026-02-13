import { z } from "zod";

export const prefabSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  walkable: z.boolean()
});

export const recipeInputSchema = z.object({
  item: z.string().min(1),
  count: z.number().int().min(1)
});

export const recipeSchema = z.object({
  id: z.string().min(1),
  input: z.array(recipeInputSchema).min(1),
  output: z.object({
    item: z.string().min(1),
    count: z.number().int().min(1)
  })
});

export const biomeRuleSchema = z.object({
  id: z.string().min(1),
  biome: z.string().min(1),
  resource: z.string().min(1),
  baseChance: z.number().min(0).max(1)
});

export const spawnRuleSchema = z.object({
  id: z.string().min(1),
  entity: z.string().min(1),
  biome: z.string().min(1),
  baseChance: z.number().min(0).max(1)
});

export const upsertPrefabOperationSchema = z.object({
  type: z.literal("upsert_prefab"),
  value: prefabSchema
});

export const upsertRecipeOperationSchema = z.object({
  type: z.literal("upsert_recipe"),
  value: recipeSchema
});

export const upsertBiomeRuleOperationSchema = z.object({
  type: z.literal("upsert_biome_rule"),
  value: biomeRuleSchema
});

export const upsertSpawnRuleOperationSchema = z.object({
  type: z.literal("upsert_spawn_rule"),
  value: spawnRuleSchema
});

export const removeByIdOperationSchema = z.object({
  type: z.literal("remove_by_id"),
  target: z.enum(["prefab", "recipe", "biome_rule", "spawn_rule"]),
  id: z.string().min(1)
});

export const contentOperationSchema = z.discriminatedUnion("type", [
  upsertPrefabOperationSchema,
  upsertRecipeOperationSchema,
  upsertBiomeRuleOperationSchema,
  upsertSpawnRuleOperationSchema,
  removeByIdOperationSchema
]);

export const buildOutputSchema = z.object({
  summary: z.string().min(1),
  operations: z.array(contentOperationSchema).min(1).max(50)
});

export type Prefab = z.infer<typeof prefabSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type BiomeRule = z.infer<typeof biomeRuleSchema>;
export type SpawnRule = z.infer<typeof spawnRuleSchema>;
export type ContentOperation = z.infer<typeof contentOperationSchema>;
export type BuildOutput = z.infer<typeof buildOutputSchema>;

export const buildOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "operations"],
  properties: {
    summary: { type: "string", minLength: 1 },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "target", "id", "value"],
        properties: {
          type: {
            enum: [
              "upsert_prefab",
              "upsert_recipe",
              "upsert_biome_rule",
              "upsert_spawn_rule",
              "remove_by_id"
            ]
          },
          target: { enum: ["prefab", "recipe", "biome_rule", "spawn_rule", null] },
          id: { type: ["string", "null"] },
          value: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "name",
              "kind",
              "walkable",
              "biome",
              "resource",
              "entity",
              "baseChance",
              "recipeInput",
              "recipeOutput"
            ],
            properties: {
              id: { type: ["string", "null"] },
              name: { type: ["string", "null"] },
              kind: { type: ["string", "null"] },
              walkable: { type: ["boolean", "null"] },
              biome: { type: ["string", "null"] },
              resource: { type: ["string", "null"] },
              entity: { type: ["string", "null"] },
              baseChance: { type: ["number", "null"] },
              recipeInput: {
                type: ["array", "null"],
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["item", "count"],
                  properties: {
                    item: { type: ["string", "null"] },
                    count: { type: ["integer", "null"] }
                  }
                }
              },
              recipeOutput: {
                type: ["object", "null"],
                additionalProperties: false,
                required: ["item", "count"],
                properties: {
                  item: { type: ["string", "null"] },
                  count: { type: ["integer", "null"] }
                }
              }
            }
          },
        }
      }
    }
  }
} as const;
