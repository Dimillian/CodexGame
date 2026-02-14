import { describe, expect, it } from "vitest";
import { agentTurnOutputSchema } from "../src/actions";

describe("agentTurnOutputSchema", () => {
  it("accepts valid actions", () => {
    const parsed = agentTurnOutputSchema.parse({
      narration: "Moving and waiting.",
      actions: [
        { type: "move", direction: "NE", steps: 2 },
        { type: "attack", targetId: "npc-1" },
        { type: "wait", ticks: 2 }
      ]
    });
    expect(parsed.actions).toHaveLength(3);
  });

  it("rejects invalid direction", () => {
    expect(() =>
      agentTurnOutputSchema.parse({
        narration: "bad",
        actions: [{ type: "move", direction: "NORTH", steps: 1 }]
      })
    ).toThrow();
  });
});
