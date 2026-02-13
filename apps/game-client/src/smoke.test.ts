import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@codexgame/protocol";

describe("client_smoke", () => {
  it("uses protocol version v1", () => {
    expect(PROTOCOL_VERSION).toBe("v1");
  });
});
