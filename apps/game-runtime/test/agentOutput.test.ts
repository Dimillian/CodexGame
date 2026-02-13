import { describe, expect, it } from "vitest";
import { agentTurnOutputSchema } from "@codexgame/protocol";

describe("action_schema_validation", () => {
  it("rejects unknown action payloads", () => {
    expect(() =>
      agentTurnOutputSchema.parse({
        narration: "bad",
        actions: [{ type: "teleport", x: 1, y: 2 }]
      })
    ).toThrow();
  });
});
