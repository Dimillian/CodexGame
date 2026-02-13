import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentStore } from "../src/runtime/contentStore";

async function seedContent(tmp: string): Promise<void> {
  await writeFile(
    path.join(tmp, "prefabs.json"),
    JSON.stringify([{ id: "campfire", name: "Campfire", kind: "structure", walkable: false }], null, 2)
  );
  await writeFile(
    path.join(tmp, "recipes.json"),
    JSON.stringify([
      {
        id: "campfire_recipe",
        input: [{ item: "wood", count: 3 }],
        output: { item: "campfire", count: 1 }
      }
    ], null, 2)
  );
  await writeFile(
    path.join(tmp, "world_rules.json"),
    JSON.stringify({ biomeRules: [], spawnRules: [] }, null, 2)
  );
}

describe("ContentStore", () => {
  it("rejects invalid operations without partial writes", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "codexgame-content-"));
    await seedContent(tmp);

    const store = new ContentStore(tmp);
    await store.load();

    await expect(
      store.applyOperations([
        {
          type: "remove_by_id",
          target: "prefab",
          id: ""
        }
      ] as never)
    ).rejects.toThrow();

    const prefabsAfter = JSON.parse(await readFile(path.join(tmp, "prefabs.json"), "utf8")) as Array<{ id: string }>;
    expect(prefabsAfter).toHaveLength(1);
    expect(prefabsAfter[0]?.id).toBe("campfire");
  });
});
