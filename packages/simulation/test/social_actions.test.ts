import { describe, expect, it } from "vitest";
import { Simulation } from "../src/simulation";
import type { ContentSet } from "../src/types";

const content: ContentSet = {
  prefabs: [],
  recipes: [],
  biomeRules: [],
  spawnRules: []
};

describe("social_actions", () => {
  it("starts neutral with other agents", () => {
    const simulation = new Simulation(101, 20, 20, content, [
      { id: "agent-1", name: "A" },
      { id: "agent-2", name: "B" }
    ]);

    const snapshot = simulation.getSnapshot();
    const a1 = snapshot.agents.find((agent) => agent.id === "agent-1");
    const a2 = snapshot.agents.find((agent) => agent.id === "agent-2");

    expect(a1?.relations.neutral).toContain("agent-2");
    expect(a2?.relations.neutral).toContain("agent-1");
    expect(a1?.relations.allies).toHaveLength(0);
    expect(a1?.relations.enemies).toHaveLength(0);
  });

  it("applies set_relation per agent", () => {
    const simulation = new Simulation(102, 20, 20, content, [
      { id: "agent-1", name: "A" },
      { id: "agent-2", name: "B" }
    ]);

    const result = simulation.applyAction("agent-1", {
      type: "set_relation",
      targetAgentId: "agent-2",
      relation: "ally"
    });
    expect(result.result).toBe("applied");

    const snapshot = simulation.getSnapshot();
    const a1 = snapshot.agents.find((agent) => agent.id === "agent-1");
    const a2 = snapshot.agents.find((agent) => agent.id === "agent-2");

    expect(a1?.relations.allies).toContain("agent-2");
    expect(a1?.relations.neutral).not.toContain("agent-2");
    expect(a2?.relations.neutral).toContain("agent-1");
  });

  it("delivers talk messages to recipient inbox", () => {
    const simulation = new Simulation(103, 20, 20, content, [
      { id: "agent-1", name: "A" },
      { id: "agent-2", name: "B" }
    ]);

    const result = simulation.applyAction("agent-1", {
      type: "talk",
      toAgentId: "agent-2",
      message: "Let's cooperate"
    });

    expect(result.result).toBe("applied");
    const snapshot = simulation.getSnapshot();
    const a2 = snapshot.agents.find((agent) => agent.id === "agent-2");
    expect(a2?.inbox[a2.inbox.length - 1]?.fromAgentId).toBe("agent-1");
    expect(a2?.inbox[a2.inbox.length - 1]?.message).toBe("Let's cooperate");
  });
});
