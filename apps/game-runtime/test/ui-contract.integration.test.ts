import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, encodeServerMessage, parseClientMessage } from "@codexgame/protocol";

describe("ui_runtime_contract", () => {
  it("parses valid client message envelope", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "god.send",
        payload: { text: "hello" }
      })
    );
    expect(parsed.type).toBe("god.send");
  });

  it("encodes server message envelope", () => {
    const encoded = encodeServerMessage({
      version: PROTOCOL_VERSION,
      type: "session.state",
      payload: {
        phase: "running",
        threadIds: { gameplay: "thr-a" },
        connected: true,
        runtime: {
          model: null,
          effort: "low",
          tickMs: 200,
          schedulerMs: 350,
          maxQueuedActionsBeforeTurn: 3,
          availableModels: []
        }
      }
    });

    const parsed = JSON.parse(encoded) as { type: string; payload: { connected: boolean } };
    expect(parsed.type).toBe("session.state");
    expect(parsed.payload.connected).toBe(true);
  });
});
