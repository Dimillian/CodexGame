import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage } from "../src/messages";

describe("message protocol", () => {
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
