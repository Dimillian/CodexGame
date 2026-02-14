import type { BuildOutput } from "@codexgame/protocol";
import { buildPromptContext } from "@codexgame/simulation";
import type { ContentSet, WorldSnapshot } from "@codexgame/simulation";

export function buildGameplayPrompt(
  snapshot: WorldSnapshot,
  agentId: string,
  godMessages: string[],
  content: ContentSet
): string {
  const self = snapshot.agents.find((agent) => agent.id === agentId);
  const agentLabel = self ? `${self.name} (${self.id})` : agentId;
  const godInstruction =
    godMessages.length > 0
      ? [
          "God message(s):",
          godMessages.map((msg, index) => `${index + 1}. ${msg}`).join("\n"),
          "You must acknowledge and answer god messages directly in narration before listing your plan."
        ].join("\n")
      : "No new god messages.";

  return [
    `You are ${agentLabel}, one controllable in-world agent in a deterministic isometric sandbox.`,
    `Control only this agent id: ${agentId}.`,
    "Output valid JSON only matching the provided schema. Never include markdown.",
    "You can gather resources, craft tools/weapons/structures from recipes, then place structures from inventory.",
    "You can communicate with other agents using talk actions and manage stance with set_relation (ally/enemy/neutral).",
    "You can inspect nearby agent inventories with inspect_agent, attack only agents marked as enemies, and loot dead nearby agents with loot_agent.",
    "Hostile creatures exist. Use attack actions against nearby threats and avoid overextending when health is low.",
    "Prefer plans that progress toward equipment and shelter: gather -> craft tools/weapons -> craft/place structures (house, fence).",
    "Prefer safe, local, low-risk actions. Max 4 actions.",
    godInstruction,
    buildGameplayCatalogPrompt(content),
    "Current world context:",
    buildPromptContext(snapshot, agentId)
  ].join("\n\n");
}

export function buildGameplayCatalogPrompt(content: ContentSet): string {
  const recipes = content.recipes.map((recipe) => ({
    id: recipe.id,
    input: recipe.input,
    output: recipe.output
  }));
  const prefabs = content.prefabs
    .filter((prefab) => prefab.kind === "structure")
    .map((prefab) => ({
      id: prefab.id,
      name: prefab.name,
      kind: prefab.kind
    }));

  return [
    "Available crafting recipes (use craft.recipeId):",
    JSON.stringify(recipes, null, 2),
    "Available placeable prefabs (use place.prefabId and ensure item is in inventory):",
    JSON.stringify(prefabs, null, 2)
  ].join("\n\n");
}

export function buildValidationRetryPrompt(previousText: string): string {
  return [
    "Your previous output was invalid JSON for the required schema.",
    "Return JSON only. No prose outside JSON.",
    "Previous output:",
    previousText
  ].join("\n\n");
}

export function buildContentPrompt(goal: string, content: ContentSet): string {
  const summarized = {
    prefabs: content.prefabs,
    recipes: content.recipes,
    biomeRules: content.biomeRules,
    spawnRules: content.spawnRules
  };

  return [
    "You are a content-only builder for CodexGame.",
    "Do not modify code. Generate content operations only.",
    `Goal: ${goal}`,
    "Current content:",
    JSON.stringify(summarized, null, 2)
  ].join("\n\n");
}

export function summarizeBuildOutput(output: BuildOutput): string {
  return `${output.summary} (${output.operations.length} operation(s))`;
}
