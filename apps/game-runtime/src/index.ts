import { runtimeConfig } from "./runtime/config";
import { GameRuntimeServer } from "./runtime/GameRuntimeServer";

async function main(): Promise<void> {
  const server = new GameRuntimeServer(runtimeConfig.wsPort);
  await server.start();
  console.log(`CodexGame runtime listening on ws://127.0.0.1:${runtimeConfig.wsPort}`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();
