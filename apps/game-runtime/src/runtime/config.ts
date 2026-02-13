import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(): string {
  const candidates = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];

  for (const candidate of candidates) {
    let current = path.resolve(candidate);
    while (true) {
      const workspaceManifest = path.join(current, "pnpm-workspace.yaml");
      const contentSeed = path.join(current, "data", "content", "prefabs.json");
      if (fs.existsSync(workspaceManifest) && fs.existsSync(contentSeed)) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return path.resolve(process.cwd());
}

const repoRoot = findRepoRoot();

export const runtimeConfig = {
  wsPort: Number(process.env.CODEXGAME_RUNTIME_PORT ?? 8787),
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexCwd: process.env.CODEX_CWD ?? repoRoot,
  contentDir: process.env.CODEXGAME_CONTENT_DIR ?? path.join(repoRoot, "data", "content"),
  runtimeDir: process.env.CODEXGAME_RUNTIME_DIR ?? path.join(repoRoot, "data", "runtime"),
  replayDir: process.env.CODEXGAME_REPLAY_DIR ?? path.join(repoRoot, "data", "replay"),
  tickMs: Number(process.env.CODEXGAME_TICK_MS ?? 200),
  schedulerMs: Number(process.env.CODEXGAME_SCHEDULER_MS ?? 350),
  maxQueuedActionsBeforeTurn: Number(process.env.CODEXGAME_MAX_QUEUED_ACTIONS ?? 3),
  turnTimeoutMs: 45_000,
  maxReconnectAttempts: 5
};
