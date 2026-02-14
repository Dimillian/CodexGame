import { describe, expect, it } from "vitest";
import { Simulation } from "../src/simulation";
import type { ContentSet, CreatureEntity } from "../src/types";

const content: ContentSet = {
  prefabs: [],
  recipes: [],
  biomeRules: [],
  spawnRules: []
};

function flattenToPlains(simulation: Simulation): void {
  const state = simulation.getState();
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const tile = state.tiles[y]?.[x];
      if (!tile) {
        continue;
      }
      tile.terrain = "plains";
    }
  }
}

function makeCreature(overrides: Partial<CreatureEntity>): CreatureEntity {
  return {
    id: "npc-test",
    type: "creature",
    subtype: "wolf",
    x: 0,
    y: 0,
    quantity: 1,
    hp: 10,
    maxHp: 10,
    attack: 4,
    defense: 1,
    aggroRange: 6,
    attackRange: 1,
    cooldownTicks: 0,
    maxCooldownTicks: 2,
    hostile: true,
    behaviorState: "idle",
    ...overrides
  };
}

describe("combat_ai", () => {
  it("applies attack action with range and cooldown checks", () => {
    const simulation = new Simulation(11, 8, 8, content, [{ id: "agent-1", name: "Agent 1" }]);
    flattenToPlains(simulation);
    const state = simulation.getState();
    const agent = state.agents[0]!;
    agent.x = 3;
    agent.y = 3;
    agent.attack = 4;
    agent.defense = 2;
    agent.attackRange = 1;
    agent.cooldownTicks = 0;
    agent.maxCooldownTicks = 2;

    state.entities = [
      makeCreature({
        id: "npc-1",
        x: 4,
        y: 3,
        hp: 9,
        maxHp: 9,
        defense: 1
      })
    ];

    const first = simulation.applyAction("agent-1", { type: "attack", targetId: "npc-1" });
    expect(first.result).toBe("applied");
    const creature = state.entities.find((entity): entity is CreatureEntity => entity.type === "creature");
    expect(creature?.hp).toBe(6);
    expect(agent.cooldownTicks).toBe(2);

    const second = simulation.applyAction("agent-1", { type: "attack", targetId: "npc-1" });
    expect(second.result).toBe("rejected");
    expect(second.reason).toBe("attack_cooldown");
  });

  it("chases and attacks nearest alive agent on deterministic ticks", () => {
    const simulation = new Simulation(22, 8, 8, content, [
      { id: "agent-1", name: "Agent 1" },
      { id: "agent-2", name: "Agent 2" }
    ]);
    flattenToPlains(simulation);
    const state = simulation.getState();
    const a1 = state.agents.find((agent) => agent.id === "agent-1")!;
    const a2 = state.agents.find((agent) => agent.id === "agent-2")!;
    a1.x = 2;
    a1.y = 2;
    a1.hp = 20;
    a1.maxHp = 20;
    a1.defense = 1;
    a1.alive = true;

    a2.x = 7;
    a2.y = 7;
    a2.hp = 20;
    a2.maxHp = 20;
    a2.defense = 1;
    a2.alive = true;

    state.tick = 24;
    state.entities = [
      makeCreature({
        id: "npc-2",
        x: 2,
        y: 4,
        attack: 5,
        defense: 1,
        aggroRange: 6,
        attackRange: 1,
        cooldownTicks: 0,
        maxCooldownTicks: 2
      })
    ];

    let chased = false;
    for (let index = 0; index < 120; index += 1) {
      simulation.tick();
      const creature = state.entities.find((entity): entity is CreatureEntity => entity.type === "creature");
      if (!creature) {
        break;
      }
      if (creature.behaviorState === "chase" && creature.y < 4) {
        chased = true;
        break;
      }
    }
    expect(chased).toBe(true);

    const hpBeforeAttack = a1.hp;
    let attacked = false;
    for (let index = 0; index < 180; index += 1) {
      simulation.tick();
      if (a1.hp < hpBeforeAttack) {
        attacked = true;
        break;
      }
    }
    expect(attacked).toBe(true);

    const hpAfterAttack = a1.hp;
    for (let index = 0; index < 5; index += 1) {
      simulation.tick();
    }
    expect(a1.hp).toBe(hpAfterAttack);
  });
});
