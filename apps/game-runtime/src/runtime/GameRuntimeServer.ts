import { promises as fs } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  agentTurnOutputJsonSchema,
  agentTurnOutputSchema,
  buildOutputJsonSchema,
  encodeServerMessage,
  parseClientMessage,
  type AgentAction,
  type BuildOutput,
  type ClientMessage,
  type ServerMessage,
  type SessionPhase,
  type SessionStartPayload,
  type TurnEffort,
  type RuntimeModelOption
} from "@codexgame/protocol";
import { Simulation } from "@codexgame/simulation";
import { CodexAppServerClient, type JsonRpcNotification } from "../codex/CodexAppServerClient";
import { runtimeConfig } from "./config";
import { ContentStore } from "./contentStore";
import { getThreadIdFromNotification, getTurnIdFromNotification } from "./codexEvents";
import { MetricsTracker } from "./metrics";
import { buildContentPrompt, buildGameplayPrompt, buildValidationRetryPrompt, summarizeBuildOutput } from "./prompting";
import { parseModelListResponse } from "./modelList";
import { ReplayLogger } from "./replay";
import { StateStore } from "./stateStore";
import type { BuildRequestResult, CompletedTurn, SessionSnapshot, ThreadIds, TurnUsage } from "./types";

type PendingTurnCollector = {
  threadId: string;
  turnId: string;
  startedAt: number;
  textBuffer: string;
  resolve: (turn: CompletedTurn) => void;
  reject: (error: Error) => void;
};

const DEFAULT_WORLD_SIZE = 40;

function parseTurnEffort(value: string | undefined): TurnEffort {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "low";
}

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

function parseUsage(params: Record<string, unknown>): TurnUsage | undefined {
  const usage = params.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return undefined;
  }
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  const cachedInputTokens = Number(usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || !Number.isFinite(cachedInputTokens)) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens
  };
}

function ensureThreadId(result: unknown): string {
  const payload = result as { thread?: { id?: unknown } };
  const id = payload.thread?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("thread id missing from app-server response");
  }
  return id;
}

function ensureTurnId(result: unknown): string {
  const payload = result as { turn?: { id?: unknown } };
  const id = payload.turn?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("turn id missing from app-server response");
  }
  return id;
}

export class GameRuntimeServer {
  private readonly wsServer: WebSocketServer;

  private readonly clients = new Set<WebSocket>();

  private readonly codexClient = new CodexAppServerClient();

  private readonly contentStore = new ContentStore(runtimeConfig.contentDir);

  private readonly replay = new ReplayLogger();

  private readonly stateStore = new StateStore(runtimeConfig.runtimeDir);

  private readonly metrics = new MetricsTracker();

  private simulation: Simulation | null = null;

  private phase: SessionPhase = "idle";

  private threadIds: ThreadIds = {};

  private connected = false;

  private paused = false;

  private reconnectAttempts = 0;

  private seed = 0;

  private tickTimer: NodeJS.Timeout | null = null;

  private schedulerTimer: NodeJS.Timeout | null = null;

  private persistTimer: NodeJS.Timeout | null = null;

  private actionQueue: AgentAction[] = [];

  private godQueue: string[] = [];

  private activeTurnId: string | null = null;

  private pendingTurns = new Map<string, PendingTurnCollector>();

  private readonly reasoningBuffers = new Map<string, string>();

  private autoplayLocked = false;

  private autoplayBackoffUntil = 0;

  private invalidStreak = 0;

  private godPriorityPending = false;

  private interruptedTurnIds = new Set<string>();

  private turnModel: string | null = process.env.CODEXGAME_MODEL ?? null;

  private turnEffort: TurnEffort = parseTurnEffort(process.env.CODEXGAME_EFFORT);

  private availableModels: RuntimeModelOption[] = [];

  private preparedSeed: number | null = null;

  public constructor(private readonly port: number) {
    this.wsServer = new WebSocketServer({ port: this.port });
    this.registerWsHandlers();
    this.registerCodexHandlers();
  }

  public async start(): Promise<void> {
    await this.contentStore.load();
    await fs.mkdir(runtimeConfig.runtimeDir, { recursive: true });
    await this.replay.start(runtimeConfig.replayDir);
    await this.logReplay("runtime.started", { port: this.port });
    await this.restoreSession();
    this.startTimers();
    void this.primeCodexModelCatalog();
  }

  public async stop(): Promise<void> {
    this.stopTimers();
    this.wsServer.close();
    await this.codexClient.stop();
  }

  private registerWsHandlers(): void {
    this.wsServer.on("connection", (socket) => {
      this.clients.add(socket);
      socket.on("close", () => {
        this.clients.delete(socket);
      });
      socket.on("message", (raw) => {
        void this.handleClientMessage(socket, raw.toString());
      });
      this.sendSessionState();
      this.sendWorldSnapshot();
    });
  }

  private registerCodexHandlers(): void {
    this.codexClient.on("connected", () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.sendSessionState();
    });

    this.codexClient.on("stderr", (line: string) => {
      void this.logReplay("codex.stderr", { line });
    });

    this.codexClient.on("notification", (notification: JsonRpcNotification) => {
      void this.handleCodexNotification(notification);
    });

    this.codexClient.on("disconnect", () => {
      this.connected = false;
      this.sendSessionState();
      this.handleDisconnect();
    });

    this.codexClient.on("error", (error: Error) => {
      this.emitError("codex_error", error.message, true);
    });
  }

  private startTimers(): void {
    this.tickTimer = setInterval(() => {
      this.tick();
    }, runtimeConfig.tickMs);

    this.schedulerTimer = setInterval(() => {
      void this.runScheduler();
    }, runtimeConfig.schedulerMs);

    this.persistTimer = setInterval(() => {
      void this.persistSession();
    }, 2000);
  }

  private stopTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private async primeCodexModelCatalog(): Promise<void> {
    try {
      await this.ensureCodexConnected();
      await this.refreshModelCatalog();
      if (this.simulation && !this.threadIds.gameplay && !this.threadIds.builder) {
        await this.startThreadsForExistingSession();
      }
    } catch (error) {
      this.emitError("model_catalog_unavailable", (error as Error).message, true);
    }
  }

  private async ensureCodexConnected(): Promise<void> {
    await this.codexClient.start({ codexBin: runtimeConfig.codexBin, cwd: runtimeConfig.codexCwd });
  }

  private async refreshModelCatalog(): Promise<void> {
    const response = await this.codexClient.request("model/list", {});
    const parsed = parseModelListResponse(response);
    this.availableModels = parsed;
    this.sendSessionState();
    await this.logReplay("runtime.models_refreshed", { count: parsed.length });
  }

  private async startThreadsForExistingSession(): Promise<void> {
    const gameplay = await this.codexClient.request("thread/start", {
      cwd: runtimeConfig.codexCwd,
      approvalPolicy: "never"
    });
    const builder = await this.codexClient.request("thread/start", {
      cwd: runtimeConfig.codexCwd,
      approvalPolicy: "never"
    });

    this.threadIds = {
      gameplay: ensureThreadId(gameplay),
      builder: ensureThreadId(builder)
    };
    this.sendSessionState();
    this.sendWorldSnapshot();
    await this.logReplay("session.threads_initialized", { source: "restore", threadIds: this.threadIds as Record<string, unknown> });
  }

  private async handleClientMessage(_socket: WebSocket, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = parseClientMessage(raw);
    } catch (error) {
      this.emitError("bad_client_message", (error as Error).message, false);
      return;
    }

    await this.logReplay("client.message", { type: message.type, payload: message.payload as Record<string, unknown> });

    switch (message.type) {
      case "session.start":
        await this.startSession(message.payload);
        return;
      case "session.reset":
        await this.resetSession(message.payload.seed);
        return;
      case "god.send":
        this.godQueue.push(message.payload.text);
        this.godPriorityPending = true;
        this.actionQueue = [];
        if (this.activeTurnId && this.threadIds.gameplay) {
          const turnId = this.activeTurnId;
          this.interruptedTurnIds.add(turnId);
          void this.codexClient
            .request("turn/interrupt", {
              threadId: this.threadIds.gameplay,
              turnId
            })
            .catch(() => {
              this.interruptedTurnIds.delete(turnId);
            });
        }
        this.emitMessage({
          version: PROTOCOL_VERSION,
          type: "agent.feed",
          payload: {
            role: "god",
            text: message.payload.text
          }
        });
        return;
      case "build.request": {
        const result = await this.runBuildRequest(message.payload.goal);
        this.emitMessage({
          version: PROTOCOL_VERSION,
          type: "build.result",
          payload: result
        });
        return;
      }
      case "agent.pause":
        this.paused = true;
        await this.interruptActiveTurn();
        this.sendSessionState();
        return;
      case "agent.resume":
        this.paused = false;
        this.sendSessionState();
        return;
      default:
        return;
    }
  }

  private async startSession(payload: SessionStartPayload): Promise<void> {
    if (this.phase === "starting") {
      return;
    }

    this.phase = "starting";
    this.seed = payload.seed ?? this.preparedSeed ?? randomSeed();
    this.preparedSeed = null;
    this.actionQueue = [];
    this.godQueue = [];
    this.invalidStreak = 0;
    this.activeTurnId = null;
    this.threadIds = {};
    this.paused = false;
    this.turnModel = payload.model?.trim() ? payload.model.trim() : (process.env.CODEXGAME_MODEL ?? null);
    this.turnEffort = parseTurnEffort(payload.effort ?? process.env.CODEXGAME_EFFORT);
    this.sendSessionState();

    try {
      const content = this.contentStore.getContent();
      this.simulation = new Simulation(this.seed, DEFAULT_WORLD_SIZE, DEFAULT_WORLD_SIZE, content);

      await this.ensureCodexConnected();
      await this.refreshModelCatalog();

      const gameplay = await this.codexClient.request("thread/start", {
        cwd: runtimeConfig.codexCwd,
        approvalPolicy: "never"
      });
      const builder = await this.codexClient.request("thread/start", {
        cwd: runtimeConfig.codexCwd,
        approvalPolicy: "never"
      });

      this.threadIds = {
        gameplay: ensureThreadId(gameplay),
        builder: ensureThreadId(builder)
      };

      this.phase = "running";
      this.sendSessionState();
      this.sendWorldSnapshot();
      await this.logReplay("session.started", { seed: this.seed, threadIds: this.threadIds as Record<string, unknown> });
    } catch (error) {
      this.phase = "error";
      this.emitError("session_start_failed", (error as Error).message, true);
    }
  }

  private async resetSession(seed?: number): Promise<void> {
    await this.interruptActiveTurn();
    this.cancelPendingTurns("session_reset");
    this.simulation = null;
    this.phase = "idle";
    this.paused = false;
    this.seed = 0;
    this.preparedSeed = typeof seed === "number" ? seed : randomSeed();
    this.threadIds = {};
    this.actionQueue = [];
    this.godQueue = [];
    this.activeTurnId = null;
    this.invalidStreak = 0;
    this.godPriorityPending = false;
    this.autoplayBackoffUntil = 0;
    this.reasoningBuffers.clear();
    this.interruptedTurnIds.clear();
    this.metrics.setQueueDepth(0);
    await this.stateStore.clear();
    this.sendSessionState();
    await this.logReplay("session.reset", { preparedSeed: this.preparedSeed });
  }

  private tick(): void {
    if (!this.simulation || this.phase !== "running") {
      return;
    }

    if (this.paused) {
      this.metrics.setQueueDepth(this.actionQueue.length);
      return;
    }

    this.simulation.tick();

    const nextAction = this.actionQueue.shift();
    if (nextAction) {
      const result = this.simulation.applyAction(nextAction);
      if (result.result === "applied") {
        this.metrics.onActionApplied();
      } else {
        this.metrics.onActionRejected();
      }
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.action",
        payload: {
          action: result.action,
          result: result.result,
          ...(result.reason ? { reason: result.reason } : {})
        }
      });
      void this.logReplay("action.applied", {
        action: result.action,
        result: result.result,
        reason: result.reason ?? null
      });
    }

    this.metrics.setQueueDepth(this.actionQueue.length);
    this.sendWorldSnapshot();
  }

  private async runScheduler(): Promise<void> {
    if (!this.simulation || this.phase !== "running" || this.paused) {
      return;
    }
    if (!this.connected || !this.threadIds.gameplay) {
      return;
    }
    if (Date.now() < this.autoplayBackoffUntil) {
      return;
    }
    if (this.activeTurnId || this.autoplayLocked) {
      return;
    }
    if (!this.godPriorityPending && this.actionQueue.length > runtimeConfig.maxQueuedActionsBeforeTurn) {
      return;
    }

    this.autoplayLocked = true;
    try {
      await this.requestGameplayTurn(false, "");
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      if (!message.includes("interrupted")) {
        this.emitError("autoplay_turn_failed", (error as Error).message, true);
      }
    } finally {
      this.autoplayLocked = false;
    }
  }

  private async requestGameplayTurn(isRetry: boolean, previousText: string): Promise<void> {
    if (!this.simulation || !this.threadIds.gameplay) {
      return;
    }

    const snapshot = this.simulation.getSnapshot();
    const godMessages = [...this.godQueue];
    this.godQueue = [];
    const content = this.contentStore.getContent();

    const prompt = isRetry
      ? buildValidationRetryPrompt(previousText)
      : buildGameplayPrompt(snapshot, godMessages, content);

    let turn: CompletedTurn;
    try {
      turn = await this.startTurnAndWait({
        threadId: this.threadIds.gameplay,
        prompt,
        outputSchema: agentTurnOutputJsonSchema
      });
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      if (message.includes("interrupted")) {
        if (godMessages.length > 0) {
          this.godQueue = [...godMessages, ...this.godQueue];
        }
      }
      throw error;
    }

    this.metrics.onTurnCompleted();

    let parsed;
    try {
      parsed = agentTurnOutputSchema.parse(JSON.parse(turn.text));
    } catch {
      this.metrics.onInvalidOutput();
      this.invalidStreak += 1;
      if (!isRetry) {
        await this.requestGameplayTurn(true, turn.text);
        return;
      }

      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.feed",
        payload: {
          role: "system",
          text: "Invalid agent output; inserting fallback wait action."
        }
      });
      this.actionQueue.push({ type: "wait", ticks: 1 });
      this.autoplayBackoffUntil = Date.now() + Math.min(30_000, this.invalidStreak * 1500);
      return;
    }

    this.invalidStreak = 0;
    this.godPriorityPending = false;
    this.emitMessage({
      version: PROTOCOL_VERSION,
      type: "agent.feed",
      payload: {
        role: "agent",
        text: parsed.narration
      }
    });

    for (const action of parsed.actions) {
      this.actionQueue.push(action);
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.action",
        payload: {
          action,
          result: "accepted"
        }
      });
    }
    this.metrics.setQueueDepth(this.actionQueue.length);
    await this.logReplay("turn.actions_enqueued", {
      turnId: turn.turnId,
      actions: parsed.actions as unknown as Record<string, unknown>[]
    });
  }

  private async runBuildRequest(goal: string): Promise<BuildRequestResult> {
    if (!this.threadIds.builder) {
      return {
        status: "failed",
        summary: "Builder thread not initialized.",
        changedFiles: []
      };
    }

    try {
      const content = this.contentStore.getContent();
      const prompt = buildContentPrompt(goal, content);
      const turn = await this.startTurnAndWait({
        threadId: this.threadIds.builder,
        prompt,
        outputSchema: buildOutputJsonSchema
      });

      const parsed = this.contentStore.parseBuildOutput(turn.text) as BuildOutput;
      const applyResult = await this.contentStore.applyOperations(parsed.operations);

      if (this.simulation) {
        this.simulation.setContent(applyResult.content);
      }

      const summary = summarizeBuildOutput(parsed);
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.feed",
        payload: {
          role: "system",
          text: `Build applied: ${summary}`
        }
      });

      await this.logReplay("build.applied", {
        goal,
        summary,
        changedFiles: applyResult.changedFiles
      });

      return {
        status: "success",
        summary,
        changedFiles: applyResult.changedFiles
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.logReplay("build.failed", { goal, message });
      return {
        status: "failed",
        summary: message,
        changedFiles: []
      };
    }
  }

  private async startTurnAndWait(args: {
    threadId: string;
    prompt: string;
    outputSchema: Record<string, unknown>;
  }): Promise<CompletedTurn> {
    const result = await this.codexClient.request("turn/start", {
      threadId: args.threadId,
      input: [{ type: "text", text: args.prompt }],
      cwd: runtimeConfig.codexCwd,
      approvalPolicy: "never",
      model: this.turnModel,
      effort: this.turnEffort,
      outputSchema: args.outputSchema
    });

    const turnId = ensureTurnId(result);
    this.activeTurnId = turnId;

    this.emitMessage({
      version: PROTOCOL_VERSION,
      type: "agent.turn",
      payload: {
        turnId,
        status: "started",
        latencyMs: 0
      }
    });

    try {
      const completed = await new Promise<CompletedTurn>((resolve, reject) => {
        const startedAt = Date.now();
        const collector: PendingTurnCollector = {
          threadId: args.threadId,
          turnId,
          startedAt,
          textBuffer: "",
          resolve,
          reject
        };
        this.pendingTurns.set(turnId, collector);

        const timeout = setTimeout(async () => {
          this.pendingTurns.delete(turnId);
          try {
            await this.codexClient.request("turn/interrupt", {
              threadId: args.threadId,
              turnId
            });
          } catch {
            // best effort
          }
          reject(new Error(`turn timeout (${turnId})`));
        }, runtimeConfig.turnTimeoutMs);

        const originalResolve = collector.resolve;
        collector.resolve = (value) => {
          clearTimeout(timeout);
          originalResolve(value);
        };
        const originalReject = collector.reject;
        collector.reject = (error) => {
          clearTimeout(timeout);
          originalReject(error);
        };
      });

      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.turn",
        payload: {
          turnId,
          status: "completed",
          latencyMs: completed.latencyMs,
          ...(completed.usage ? { usage: completed.usage } : {})
        }
      });

      return completed;
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      const status = message.includes("interrupted") ? "interrupted" : "failed";
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.turn",
        payload: {
          turnId,
          status,
          latencyMs: 0
        }
      });
      throw error;
    } finally {
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
      }
    }
  }

  private async handleCodexNotification(notification: JsonRpcNotification): Promise<void> {
    await this.logReplay("codex.notification", {
      method: notification.method,
      params: notification.params
    });

    const threadId = getThreadIdFromNotification(notification);
    const turnId = getTurnIdFromNotification(notification);
    const params = notification.params;

    if (
      notification.method === "item/reasoning/summaryTextDelta" ||
      notification.method === "item/reasoning/textDelta"
    ) {
      if (!threadId || threadId !== this.threadIds.gameplay) {
        return;
      }
      const itemId = String(params.itemId ?? params.item_id ?? "");
      const delta = String(params.delta ?? "");
      if (!itemId || !delta) {
        return;
      }
      const next = (this.reasoningBuffers.get(itemId) ?? "") + delta;
      this.reasoningBuffers.set(itemId, next);
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.feed",
        payload: {
          role: "reasoning",
          text: delta
        }
      });
      return;
    }

    if (notification.method === "item/reasoning/summaryPartAdded") {
      if (!threadId || threadId !== this.threadIds.gameplay) {
        return;
      }
      const itemId = String(params.itemId ?? params.item_id ?? "");
      if (!itemId) {
        return;
      }
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.feed",
        payload: {
          role: "reasoning",
          text: " "
        }
      });
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const text = String(params.delta ?? "");
      if (!text || !turnId) {
        return;
      }
      const collector = this.pendingTurns.get(turnId);
      if (!collector) {
        return;
      }
      collector.textBuffer += text;
      return;
    }

    if (notification.method === "item/started") {
      const item = params.item as Record<string, unknown> | undefined;
      if (!item) {
        return;
      }
      const itemType = String(item.type ?? "");
      if (itemType === "reasoning" && threadId && threadId === this.threadIds.gameplay) {
        this.emitMessage({
          version: PROTOCOL_VERSION,
          type: "agent.feed",
          payload: {
            role: "reasoning",
            text: "..."
          }
        });
      }
      return;
    }

    if (notification.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (!item) {
        return;
      }
      const itemType = String(item.type ?? "");
      if (itemType === "reasoning") {
        const itemId = String(item.id ?? "");
        if (itemId) {
          this.reasoningBuffers.delete(itemId);
        }
        return;
      }
      if (itemType !== "agentMessage" && itemType !== "agent_message") {
        return;
      }
      const id = turnId || getTurnIdFromNotification({ method: notification.method, params: item });
      if (!id) {
        return;
      }
      const collector = this.pendingTurns.get(id);
      if (!collector) {
        return;
      }
      const text = String(item.text ?? "");
      if (text) {
        collector.textBuffer = text;
      }
      return;
    }

    if (notification.method === "turn/completed") {
      if (!turnId) {
        return;
      }
      const collector = this.pendingTurns.get(turnId);
      if (!collector) {
        return;
      }
      if (this.interruptedTurnIds.has(turnId)) {
        this.interruptedTurnIds.delete(turnId);
        this.pendingTurns.delete(turnId);
        collector.reject(new Error(`turn interrupted (${turnId})`));
        return;
      }
      this.pendingTurns.delete(turnId);
      const usage = parseUsage(params);
      collector.resolve({
        turnId,
        text: collector.textBuffer,
        latencyMs: Date.now() - collector.startedAt,
        ...(usage ? { usage } : {})
      });
      return;
    }

    if (notification.method === "error") {
      const message = String((params.error as { message?: string } | undefined)?.message ?? "codex turn error");
      if (turnId) {
        if (this.interruptedTurnIds.has(turnId)) {
          this.interruptedTurnIds.delete(turnId);
          const collector = this.pendingTurns.get(turnId);
          if (collector) {
            this.pendingTurns.delete(turnId);
            collector.reject(new Error(`turn interrupted (${turnId})`));
          }
          return;
        }
        const collector = this.pendingTurns.get(turnId);
        if (collector) {
          this.pendingTurns.delete(turnId);
          collector.reject(new Error(message));
        }
      }
      if (threadId === this.threadIds.gameplay || threadId === this.threadIds.builder) {
        this.emitError("codex_turn_error", message, true);
      }
    }
  }

  private async handleDisconnect(): Promise<void> {
    if (this.phase !== "running") {
      return;
    }

    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > runtimeConfig.maxReconnectAttempts) {
      this.phase = "error";
      this.emitError("circuit_breaker", "Too many codex reconnect failures.", false);
      return;
    }

    const delay = Math.min(10_000, this.reconnectAttempts * 1_000);
    this.emitMessage({
      version: PROTOCOL_VERSION,
      type: "agent.feed",
      payload: {
        role: "system",
        text: `Codex disconnected; reconnecting in ${delay}ms...`
      }
    });

    setTimeout(() => {
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    try {
      await this.codexClient.restart({ codexBin: runtimeConfig.codexBin, cwd: runtimeConfig.codexCwd });
      if (this.threadIds.gameplay) {
        await this.codexClient.request("thread/resume", { threadId: this.threadIds.gameplay });
      }
      if (this.threadIds.builder) {
        await this.codexClient.request("thread/resume", { threadId: this.threadIds.builder });
      }
      await this.refreshModelCatalog();
      this.connected = true;
      this.sendSessionState();
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.feed",
        payload: {
          role: "system",
          text: "Codex reconnect complete."
        }
      });
    } catch (error) {
      this.connected = false;
      this.sendSessionState();
      this.emitError("reconnect_failed", (error as Error).message, true);
      await this.handleDisconnect();
    }
  }

  private emitError(code: string, message: string, recoverable: boolean): void {
    this.emitMessage({
      version: PROTOCOL_VERSION,
      type: "error",
      payload: {
        code,
        message,
        recoverable
      }
    });
    void this.logReplay("runtime.error", { code, message, recoverable });
  }

  private sendSessionState(): void {
    this.emitMessage({
      version: PROTOCOL_VERSION,
      type: "session.state",
      payload: {
        phase: this.phase,
        paused: this.paused,
        preparedSeed: this.preparedSeed,
        threadIds: this.threadIds,
        connected: this.connected,
        runtime: {
          model: this.turnModel,
          effort: this.turnEffort,
          tickMs: runtimeConfig.tickMs,
          schedulerMs: runtimeConfig.schedulerMs,
          maxQueuedActionsBeforeTurn: runtimeConfig.maxQueuedActionsBeforeTurn,
          availableModels: this.availableModels
        }
      }
    });
  }

  private sendWorldSnapshot(): void {
    if (!this.simulation) {
      return;
    }
    const snapshot = this.simulation.getSnapshot();
    const content = this.contentStore.getContent();
    this.emitMessage({
      version: PROTOCOL_VERSION,
      type: "world.snapshot",
      payload: {
        ...snapshot,
        catalog: {
          prefabs: content.prefabs.map((prefab) => ({
            id: prefab.id,
            name: prefab.name,
            kind: prefab.kind
          })),
          recipes: content.recipes.map((recipe) => ({
            id: recipe.id,
            input: recipe.input,
            output: recipe.output
          }))
        }
      }
    });
  }

  private emitMessage(message: ServerMessage): void {
    const encoded = encodeServerMessage(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(encoded);
      }
    }
  }

  private async persistSession(): Promise<void> {
    if (!this.simulation || this.phase !== "running") {
      return;
    }
    const snapshot = this.simulation.getSnapshot();
    const simulationState = structuredClone(this.simulation.getState());
    const sessionSnapshot: SessionSnapshot = {
      seed: this.seed,
      tick: snapshot.tick,
      actor: snapshot.actor,
      threadIds: this.threadIds,
      metrics: this.metrics.snapshot(),
      simulation: simulationState
    };
    await this.stateStore.save(sessionSnapshot);
  }

  private async restoreSession(): Promise<void> {
    const saved = await this.stateStore.load();
    if (!saved) {
      return;
    }

    const content = this.contentStore.getContent();
    if (saved.simulation) {
      this.simulation = Simulation.fromState(saved.simulation, content);
      this.seed = saved.simulation.seed;
    } else if (typeof saved.seed === "number") {
      this.simulation = new Simulation(saved.seed, DEFAULT_WORLD_SIZE, DEFAULT_WORLD_SIZE, content);
      this.seed = saved.seed;
      const state = this.simulation.getState();
      if (typeof saved.tick === "number" && Number.isFinite(saved.tick)) {
        state.tick = Math.max(0, Math.floor(saved.tick));
      }
      const actor = saved.actor;
      if (actor && typeof actor === "object") {
        if (typeof actor.x === "number") {
          state.actor.x = Math.max(0, Math.min(state.width - 1, Math.floor(actor.x)));
        }
        if (typeof actor.y === "number") {
          state.actor.y = Math.max(0, Math.min(state.height - 1, Math.floor(actor.y)));
        }
        if (
          actor.facing === "N" ||
          actor.facing === "NE" ||
          actor.facing === "E" ||
          actor.facing === "SE" ||
          actor.facing === "S" ||
          actor.facing === "SW" ||
          actor.facing === "W" ||
          actor.facing === "NW"
        ) {
          state.actor.facing = actor.facing;
        }
        if (typeof actor.stamina === "number" && Number.isFinite(actor.stamina)) {
          state.actor.stamina = Math.max(0, Math.min(100, Math.floor(actor.stamina)));
        }
      }
    } else {
      return;
    }

    this.phase = "running";
    this.preparedSeed = null;
    this.threadIds = {};
    this.actionQueue = [];
    this.godQueue = [];
    this.activeTurnId = null;
    this.invalidStreak = 0;
    this.godPriorityPending = false;
    await this.logReplay("session.restored", {
      seed: this.seed,
      tick: this.simulation.getState().tick
    });
  }

  private async interruptActiveTurn(): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) {
      return;
    }
    const collector = this.pendingTurns.get(turnId);
    if (!collector) {
      return;
    }
    this.interruptedTurnIds.add(turnId);
    try {
      await this.codexClient.request("turn/interrupt", {
        threadId: collector.threadId,
        turnId
      });
    } catch {
      this.interruptedTurnIds.delete(turnId);
    }
  }

  private cancelPendingTurns(reason: string): void {
    for (const collector of this.pendingTurns.values()) {
      collector.reject(new Error(reason));
    }
    this.pendingTurns.clear();
  }

  private async logReplay(event: string, payload: Record<string, unknown>): Promise<void> {
    await this.replay.append({
      ts: Date.now(),
      event,
      payload
    });
  }
}
