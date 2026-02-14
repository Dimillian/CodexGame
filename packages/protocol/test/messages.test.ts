import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage } from "../src/messages";

describe("message protocol", () => {
  it("parses session.start with agents", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "session.start",
        payload: {
          seed: 12345,
          agents: [
            { id: "agent-1", name: "Agent 1", model: "gpt-5", effort: "low" },
            { id: "agent-2", name: "Agent 2" }
          ]
        }
      })
    );

    expect(parsed.type).toBe("session.start");
    if (parsed.type === "session.start") {
      expect(parsed.payload.agents).toHaveLength(2);
    }
  });

  it("parses session.reset with optional seed", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "session.reset",
        payload: { seed: 12345 }
      })
    );

    expect(parsed.type).toBe("session.reset");
    if (parsed.type === "session.reset") {
      expect(parsed.payload.seed).toBe(12345);
    }
  });
});
