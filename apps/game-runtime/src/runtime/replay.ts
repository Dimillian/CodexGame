import { promises as fs } from "node:fs";
import path from "node:path";
import type { RuntimeEvent } from "./types";

function timestampId(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

export class ReplayLogger {
  private filePath: string | null = null;

  public async start(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    this.filePath = path.join(directory, `${timestampId()}.jsonl`);
  }

  public async append(event: RuntimeEvent): Promise<void> {
    if (!this.filePath) {
      return;
    }
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  public getPath(): string | null {
    return this.filePath;
  }
}
