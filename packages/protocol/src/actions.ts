import { z } from "zod";

export const directionSchema = z.enum(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);

export const moveActionSchema = z.object({
  type: z.literal("move"),
  direction: directionSchema,
  steps: z.union([z.literal(1), z.literal(2), z.literal(3)])
});

export const interactActionSchema = z.object({
  type: z.literal("interact"),
  targetId: z.string().min(1)
});

export const gatherActionSchema = z.object({
  type: z.literal("gather"),
  targetId: z.string().min(1)
});

export const craftActionSchema = z.object({
  type: z.literal("craft"),
  recipeId: z.string().min(1)
});

export const placeActionSchema = z.object({
  type: z.literal("place"),
  prefabId: z.string().min(1),
  x: z.number().int(),
  y: z.number().int()
});

export const waitActionSchema = z.object({
  type: z.literal("wait"),
  ticks: z.number().int().min(1).max(20)
});

export const agentActionSchema = z.discriminatedUnion("type", [
  moveActionSchema,
  interactActionSchema,
  gatherActionSchema,
  craftActionSchema,
  placeActionSchema,
  waitActionSchema
]);

export const agentTurnOutputSchema = z.object({
  narration: z.string().min(1),
  actions: z.array(agentActionSchema).min(1).max(4)
});

export type Direction = z.infer<typeof directionSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentTurnOutput = z.infer<typeof agentTurnOutputSchema>;

export const agentTurnOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["narration", "actions"],
  properties: {
    narration: { type: "string", minLength: 1 },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "direction",
          "steps",
          "targetId",
          "recipeId",
          "prefabId",
          "x",
          "y",
          "ticks"
        ],
        properties: {
          type: { enum: ["move", "interact", "gather", "craft", "place", "wait"] },
          direction: { enum: ["N", "NE", "E", "SE", "S", "SW", "W", "NW", null] },
          steps: { enum: [1, 2, 3, null] },
          targetId: { type: ["string", "null"] },
          recipeId: { type: ["string", "null"] },
          prefabId: { type: ["string", "null"] },
          x: { type: ["integer", "null"] },
          y: { type: ["integer", "null"] },
          ticks: { type: ["integer", "null"] }
        }
      }
    }
  }
} as const;
