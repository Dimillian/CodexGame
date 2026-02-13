import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export type JsonRpcNotification = {
  method: string;
  params: Record<string, unknown>;
  id?: number | string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type StartOptions = {
  codexBin: string;
  cwd: string;
};

const REQUEST_TIMEOUT_MS = 60_000;

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;

  private nextId = 1;

  private readonly pending = new Map<number, PendingRequest>();

  private isStarted = false;

  public async start(options: StartOptions): Promise<void> {
    if (this.isStarted) {
      return;
    }

    this.child = spawn(options.codexBin, ["app-server"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.child.once("error", (error) => {
      this.emit("error", error);
    });

    this.child.once("exit", (code, signal) => {
      this.rejectAllPending(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
      this.isStarted = false;
      this.child = null;
      this.emit("disconnect");
    });

    const stdoutReader = readline.createInterface({ input: this.child.stdout });
    stdoutReader.on("line", (line) => this.handleStdoutLine(line));

    const stderrReader = readline.createInterface({ input: this.child.stderr });
    stderrReader.on("line", (line) => {
      if (line.trim()) {
        this.emit("stderr", line);
      }
    });

    await this.initializeHandshake();
    this.isStarted = true;
    this.emit("connected");
  }

  public async restart(options: StartOptions): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  public async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;
    this.isStarted = false;

    this.rejectAllPending(new Error("codex app-server stopped"));

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  public async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }
    const id = this.nextId;
    this.nextId += 1;

    const payload = JSON.stringify({ id, method, params });

    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve,
        reject,
        timer
      });

      this.child?.stdin.write(`${payload}\n`, (err) => {
        if (!err) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });

    return response as T;
  }

  public async sendNotification(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }
    await new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify({ method, params });
      this.child?.stdin.write(`${payload}\n`, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async initializeHandshake(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codexgame_runtime",
        title: "CodexGame Runtime",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    await this.sendNotification("initialized");
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      this.emit("error", new Error(`failed to parse app-server line: ${trimmed}`, { cause: error }));
      return;
    }

    const maybeId = parsed.id;
    if (typeof maybeId === "number" && this.pending.has(maybeId)) {
      const pending = this.pending.get(maybeId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(maybeId);

      if (parsed.error) {
        const message = (parsed.error as { message?: string }).message ?? "unknown app-server error";
        pending.reject(new Error(String(message)));
        return;
      }

      pending.resolve(parsed.result ?? {});
      return;
    }

    const method = parsed.method;
    if (typeof method === "string") {
      const notification: JsonRpcNotification = {
        method,
        params: (parsed.params as Record<string, unknown>) ?? {}
      };
      if (typeof maybeId === "number" || typeof maybeId === "string") {
        notification.id = maybeId;
      }
      this.emit("notification", notification);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
