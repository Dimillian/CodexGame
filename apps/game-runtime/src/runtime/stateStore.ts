import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionSnapshot } from "./types";

const SESSION_FILE = "session.json";

export class StateStore {
  private readonly runtimeDir: string;

  public constructor(runtimeDir: string) {
    this.runtimeDir = runtimeDir;
  }

  public async save(snapshot: SessionSnapshot): Promise<void> {
    await fs.mkdir(this.runtimeDir, { recursive: true });
    const filePath = path.join(this.runtimeDir, SESSION_FILE);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  }

  public async load(): Promise<Partial<SessionSnapshot> | null> {
    const filePath = path.join(this.runtimeDir, SESSION_FILE);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  public async clear(): Promise<void> {
    const filePath = path.join(this.runtimeDir, SESSION_FILE);
    try {
      await fs.rm(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
