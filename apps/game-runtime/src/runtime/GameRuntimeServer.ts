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
  type RuntimeModelOption,
  type ServerMessage,
  type SessionAgentConfig,
  type SessionPhase,
  type SessionStartPayload,
  type TurnEffort
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
  agentId: string;
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

function uniqueAgents(agents: SessionAgentConfig[]): SessionAgentConfig[] {
  const out: SessionAgentConfig[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) {
      continue;
    }
    seen.add(agent.id);
    out.push(agent);
  }
  return out;
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

  private threadIds: ThreadIds = { gameplayByAgentId: {} };

  private readonly threadToAgentId = new Map<string, string>();

  private connected = false;

  private paused = false;

  private reconnectAttempts = 0;

  private seed = 0;

  private tickTimer: NodeJS.Timeout | null = null;

  private schedulerTimer: NodeJS.Timeout | null = null;

  private persistTimer: NodeJS.Timeout | null = null;

  private readonly actionQueueByAgent = new Map<string, AgentAction[]>();

  private readonly godQueueByAgent = new Map<string, string[]>();

  private readonly invalidStreakByAgent = new Map<string, number>();

  private readonly autoplayBackoffUntilByAgent = new Map<string, number>();

  private readonly godPriorityPendingByAgent = new Map<string, boolean>();

  private activeTurn: { agentId: string; turnId: string } | null = null;

  private pendingTurns = new Map<string, PendingTurnCollector>();

  private readonly reasoningBuffers = new Map<string, string>();

  private autoplayLocked = false;

  private interruptedTurnIds = new Set<string>();

  private turnModel: string | null = process.env.CODEXGAME_MODEL ?? null;

  private turnEffort: TurnEffort = parseTurnEffort(process.env.CODEXGAME_EFFORT);

  private availableModels: RuntimeModelOption[] = [];

  private preparedSeed: number | null = null;

  private schedulerIndex = 0;

  private readonly agentConfigs = new Map<string, SessionAgentConfig>();

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
      void this.handleDisconnect();
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

  private ensureAgentState(agentId: string): void {
    if (!this.actionQueueByAgent.has(agentId)) {
      this.actionQueueByAgent.set(agentId, []);
    }
    if (!this.godQueueByAgent.has(agentId)) {
      this.godQueueByAgent.set(agentId, []);
    }
    if (!this.invalidStreakByAgent.has(agentId)) {
      this.invalidStreakByAgent.set(agentId, 0);
    }
    if (!this.autoplayBackoffUntilByAgent.has(agentId)) {
      this.autoplayBackoffUntilByAgent.set(agentId, 0);
    }
    if (!this.godPriorityPendingByAgent.has(agentId)) {
      this.godPriorityPendingByAgent.set(agentId, false);
    }
  }

  private resetAgentLoopState(agentIds: string[]): void {
    this.actionQueueByAgent.clear();
    this.godQueueByAgent.clear();
    this.invalidStreakByAgent.clear();
    this.autoplayBackoffUntilByAgent.clear();
    this.godPriorityPendingByAgent.clear();
    for (const agentId of agentIds) {
      this.ensureAgentState(agentId);
    }
  }

  private gameplayAgentIds(): string[] {
    if (!this.simulation) {
      return [];
    }
    return this.simulation
      .getState()
      .agents.map((agent) => agent.id)
      .filter((id) => this.threadIds.gameplayByAgentId[id])
      .sort();
  }

  private totalQueuedActions(): number {
    let total = 0;
    for (const queue of this.actionQueueByAgent.values()) {
      total += queue.length;
    }
    return total;
  }

  private async primeCodexModelCatalog(): Promise<void> {
    try {
      await this.ensureCodexConnected();
      await this.refreshModelCatalog();
      if (this.simulation && Object.keys(this.threadIds.gameplayByAgentId).length === 0 && !this.threadIds.builder) {
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
    if (!this.simulation) {
      return;
    }
    const gameplayByAgentId: Record<string, string> = {};
    for (const agent of this.simulation.getState().agents) {
      this.ensureAgentState(agent.id);
      if (!this.agentConfigs.has(agent.id)) {
        this.agentConfigs.set(agent.id, { id: agent.id, name: agent.name });
      }
      const gameplay = await this.codexClient.request("thread/start", {
        cwd: runtimeConfig.codexCwd,
        approvalPolicy: "never"
      });
      const threadId = ensureThreadId(gameplay);
      gameplayByAgentId[agent.id] = threadId;
      this.threadToAgentId.set(threadId, agent.id);
    }

    const builder = await this.codexClient.request("thread/start", {
      cwd: runtimeConfig.codexCwd,
      approvalPolicy: "never"
    });

    this.threadIds = {
      gameplayByAgentId,
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
      case "god.send": {
        const targets = message.payload.targetAgentId
          ? [message.payload.targetAgentId]
          : this.simulation?.getState().agents.map((agent) => agent.id) ?? [];

        for (const targetAgentId of targets) {
          this.ensureAgentState(targetAgentId);
          this.godQueueByAgent.get(targetAgentId)?.push(message.payload.text);
          this.godPriorityPendingByAgent.set(targetAgentId, true);
          this.actionQueueByAgent.set(targetAgentId, []);
        }

        if (this.activeTurn) {
          const shouldInterrupt =
            !message.payload.targetAgentId || message.payload.targetAgentId === this.activeTurn.agentId;
          if (shouldInterrupt) {
            const turnId = this.activeTurn.turnId;
            this.interruptedTurnIds.add(turnId);
            const threadId = this.threadIds.gameplayByAgentId[this.activeTurn.agentId];
            if (threadId) {
              void this.codexClient
                .request("turn/interrupt", {
                  threadId,
                  turnId
                })
                .catch(() => {
                  this.interruptedTurnIds.delete(turnId);
                });
            }
          }
        }

        this.emitMessage({
          version: PROTOCOL_VERSION,
          type: "agent.feed",
          payload: {
            role: "god",
            text: message.payload.text,
            ...(message.payload.targetAgentId ? { agentId: message.payload.targetAgentId } : {})
          }
        });
        return;
      }
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

    const agents = uniqueAgents(payload.agents);
    if (agents.length === 0 || agents.length > 4) {
      this.emitError("invalid_agents", "Session must include between 1 and 4 unique agents.", false);
      return;
    }

    this.phase = "starting";
    this.seed = payload.seed ?? this.preparedSeed ?? randomSeed();
    this.preparedSeed = null;
    this.threadToAgentId.clear();
    this.schedulerIndex = 0;
    this.activeTurn = null;
    this.interruptedTurnIds.clear();
    this.pendingTurns.clear();
    this.agentConfigs.clear();
    for (const agent of agents) {
      this.agentConfigs.set(agent.id, agent);
    }
    this.threadIds = { gameplayByAgentId: {} };
    this.resetAgentLoopState(agents.map((agent) => agent.id));

    this.paused = false;
    this.turnModel = payload.model?.trim() ? payload.model.trim() : process.env.CODEXGAME_MODEL ?? null;
    this.turnEffort = parseTurnEffort(payload.effort ?? process.env.CODEXGAME_EFFORT);
    this.sendSessionState();

    try {
      const content = this.contentStore.getContent();
      this.simulation = new Simulation(
        this.seed,
        DEFAULT_WORLD_SIZE,
        DEFAULT_WORLD_SIZE,
        content,
        agents.map((agent) => ({ id: agent.id, name: agent.name }))
      );

      await this.ensureCodexConnected();
      await this.refreshModelCatalog();

      const gameplayByAgentId: Record<string, string> = {};
      for (const agent of agents) {
        const gameplay = await this.codexClient.request("thread/start", {
          cwd: runtimeConfig.codexCwd,
          approvalPolicy: "never"
        });
        const threadId = ensureThreadId(gameplay);
        gameplayByAgentId[agent.id] = threadId;
        this.threadToAgentId.set(threadId, agent.id);
      }

      const builder = await this.codexClient.request("thread/start", {
        cwd: runtimeConfig.codexCwd,
        approvalPolicy: "never"
      });

      this.threadIds = {
        gameplayByAgentId,
        builder: ensureThreadId(builder)
      };

      this.phase = "running";
      this.sendSessionState();
      this.sendWorldSnapshot();
      await this.logReplay("session.started", {
        seed: this.seed,
        agentIds: agents.map((agent) => agent.id),
        threadIds: this.threadIds as Record<string, unknown>
      });
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
    this.threadIds = { gameplayByAgentId: {} };
    this.threadToAgentId.clear();
    this.agentConfigs.clear();
    this.activeTurn = null;
    this.schedulerIndex = 0;
    this.resetAgentLoopState([]);
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
      this.metrics.setQueueDepth(this.totalQueuedActions());
      return;
    }

    this.simulation.tick();

    const agents = this.simulation.getState().agents.map((agent) => agent.id).sort();
    for (const agentId of agents) {
      const queue = this.actionQueueByAgent.get(agentId);
      const nextAction = queue?.shift();
      if (!nextAction) {
        continue;
      }
      const result = this.simulation.applyAction(agentId, nextAction);
      if (result.result === "applied") {
        this.metrics.onActionApplied();
      } else {
        this.metrics.onActionRejected();
      }
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.action",
        payload: {
          agentId,
          action: result.action,
          result: result.result,
          ...(result.reason ? { reason: result.reason } : {})
        }
      });
      void this.logReplay("action.applied", {
        agentId,
        action: result.action,
        result: result.result,
        reason: result.reason ?? null
      });
    }

    this.metrics.setQueueDepth(this.totalQueuedActions());
    this.sendWorldSnapshot();
  }

  private nextSchedulableAgentId(): string | null {
    if (!this.simulation) {
      return null;
    }

    const agents = this.simulation
      .getState()
      .agents.filter((agent) => agent.alive && this.threadIds.gameplayByAgentId[agent.id])
      .sort((a, b) => a.id.localeCompare(b.id));

    if (agents.length === 0) {
      return null;
    }

    for (let pass = 0; pass < agents.length; pass += 1) {
      const index = (this.schedulerIndex + pass) % agents.length;
      const candidate = agents[index];
      if (!candidate) {
        continue;
      }
      const agentId = candidate.id;
      const backoffUntil = this.autoplayBackoffUntilByAgent.get(agentId) ?? 0;
      if (Date.now() < backoffUntil) {
        continue;
      }
      const queueDepth = this.actionQueueByAgent.get(agentId)?.length ?? 0;
      const hasGodPriority = this.godPriorityPendingByAgent.get(agentId) ?? false;
      if (!hasGodPriority && queueDepth > runtimeConfig.maxQueuedActionsBeforeTurn) {
        continue;
      }
      this.schedulerIndex = (index + 1) % agents.length;
      return agentId;
    }

    return null;
  }

  private async runScheduler(): Promise<void> {
    if (!this.simulation || this.phase !== "running" || this.paused) {
      return;
    }
    if (!this.connected) {
      return;
    }
    if (this.activeTurn || this.autoplayLocked) {
      return;
    }

    const agentId = this.nextSchedulableAgentId();
    if (!agentId) {
      return;
    }

    this.autoplayLocked = true;
    try {
      await this.requestGameplayTurn(agentId, false, "");
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      if (!message.includes("interrupted")) {
        this.emitError("autoplay_turn_failed", (error as Error).message, true);
      }
    } finally {
      this.autoplayLocked = false;
    }
  }

  private async requestGameplayTurn(agentId: string, isRetry: boolean, previousText: string): Promise<void> {
    if (!this.simulation) {
      return;
    }

    const threadId = this.threadIds.gameplayByAgentId[agentId];
    if (!threadId) {
      return;
    }

    const snapshot = this.simulation.getSnapshot();
    const godMessages = [...(this.godQueueByAgent.get(agentId) ?? [])];
    this.godQueueByAgent.set(agentId, []);
    const content = this.contentStore.getContent();

    const prompt = isRetry
      ? buildValidationRetryPrompt(previousText)
      : buildGameplayPrompt(snapshot, agentId, godMessages, content);

    let turn: CompletedTurn;
    try {
      turn = await this.startTurnAndWait({
        agentId,
        threadId,
        prompt,
        outputSchema: agentTurnOutputJsonSchema
      });
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      if (message.includes("interrupted") && godMessages.length > 0) {
        this.godQueueByAgent.set(agentId, [...godMessages, ...(this.godQueueByAgent.get(agentId) ?? [])]);
      }
      throw error;
    }

    this.metrics.onTurnCompleted();

    let parsed;
    try {
      parsed = agentTurnOutputSchema.parse(JSON.parse(turn.text));
    } catch {
      this.metrics.onInvalidOutput();
      this.invalidStreakByAgent.set(agentId, (this.invalidStreakByAgent.get(agentId) ?? 0) + 1);
      if (!isRetry) {
        await this.requestGameplayTurn(agentId, true, turn.text);
        return;
      }

      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.feed",
        payload: {
          role: "system",
          agentId,
          text: "Invalid agent output; inserting fallback wait action."
        }
      });
      this.actionQueueByAgent.get(agentId)?.push({ type: "wait", ticks: 1 });
      const streak = this.invalidStreakByAgent.get(agentId) ?? 1;
      this.autoplayBackoffUntilByAgent.set(agentId, Date.now() + Math.min(30_000, streak * 1500));
      return;
    }

    this.invalidStreakByAgent.set(agentId, 0);
    this.godPriorityPendingByAgent.set(agentId, false);
    this.emitMessage({
      version: PROTOCOL_VERSION,
      type: "agent.feed",
      payload: {
        role: "agent",
        agentId,
        text: parsed.narration
      }
    });

    for (const action of parsed.actions) {
      this.actionQueueByAgent.get(agentId)?.push(action);
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.action",
        payload: {
          agentId,
          action,
          result: "accepted"
        }
      });
    }
    this.metrics.setQueueDepth(this.totalQueuedActions());
    await this.logReplay("turn.actions_enqueued", {
      agentId,
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
        agentId: "builder",
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
    agentId: string;
    threadId: string;
    prompt: string;
    outputSchema: Record<string, unknown>;
  }): Promise<CompletedTurn> {
    const agentConfig = this.agentConfigs.get(args.agentId);
    const model = agentConfig?.model ?? this.turnModel;
    const effort = parseTurnEffort(agentConfig?.effort ?? this.turnEffort);

    const result = await this.codexClient.request("turn/start", {
      threadId: args.threadId,
      input: [{ type: "text", text: args.prompt }],
      cwd: runtimeConfig.codexCwd,
      approvalPolicy: "never",
      model,
      effort,
      outputSchema: args.outputSchema
    });

    const turnId = ensureTurnId(result);
    this.activeTurn = { agentId: args.agentId, turnId };

    if (args.agentId !== "builder") {
      this.emitMessage({
        version: PROTOCOL_VERSION,
        type: "agent.turn",
        payload: {
          agentId: args.agentId,
          turnId,
          status: "started",
          latencyMs: 0
        }
      });
    }

    try {
      const completed = await new Promise<CompletedTurn>((resolve, reject) => {
        const startedAt = Date.now();
        const collector: PendingTurnCollector = {
          agentId: args.agentId,
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

      if (args.agentId !== "builder") {
        this.emitMessage({
          version: PROTOCOL_VERSION,
          type: "agent.turn",
          payload: {
            agentId: args.agentId,
            turnId,
            status: "completed",
            latencyMs: completed.latencyMs,
            ...(completed.usage ? { usage: completed.usage } : {})
          }
        });
      }

      return completed;
    } catch (error) {
      if (args.agentId !== "builder") {
        const message = (error as Error).message.toLowerCase();
        const status = message.includes("interrupted") ? "interrupted" : "failed";
        this.emitMessage({
          version: PROTOCOL_VERSION,
          type: "agent.turn",
          payload: {
            agentId: args.agentId,
            turnId,
            status,
            latencyMs: 0
          }
        });
      }
      throw error;
    } finally {
      if (this.activeTurn?.turnId === turnId) {
        this.activeTurn = null;
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
    const gameplayAgentId = threadId ? this.threadToAgentId.get(threadId) : undefined;

    if (
      notification.method === "item/reasoning/summaryTextDelta" ||
      notification.method === "item/reasoning/textDelta"
    ) {
      if (!gameplayAgentId) {
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
          agentId: gameplayAgentId,
          text: delta
        }
      });
      return;
    }

    if (notification.method === "item/reasoning/summaryPartAdded") {
      if (!gameplayAgentId) {
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
          agentId: gameplayAgentId,
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
      if (!item || !gameplayAgentId) {
        return;
      }
      const itemType = String(item.type ?? "");
      if (itemType === "reasoning") {
        this.emitMessage({
          version: PROTOCOL_VERSION,
          type: "agent.feed",
          payload: {
            role: "reasoning",
            agentId: gameplayAgentId,
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
      const isGameplayThread = !!(threadId && this.threadToAgentId.has(threadId));
      if (isGameplayThread || threadId === this.threadIds.builder) {
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
      for (const threadId of Object.values(this.threadIds.gameplayByAgentId)) {
        await this.codexClient.request("thread/resume", { threadId });
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
        agents: snapshot.agents.map((agent) => ({
          ...agent,
          model: this.agentConfigs.get(agent.id)?.model ?? this.turnModel,
          effort: parseTurnEffort(this.agentConfigs.get(agent.id)?.effort ?? this.turnEffort)
        })),
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
      for (const agent of saved.simulation.agents ?? []) {
        this.agentConfigs.set(agent.id, { id: agent.id, name: agent.name });
      }
      this.resetAgentLoopState((saved.simulation.agents ?? []).map((agent) => agent.id));
    } else if (typeof saved.seed === "number") {
      this.simulation = new Simulation(saved.seed, DEFAULT_WORLD_SIZE, DEFAULT_WORLD_SIZE, content, [
        { id: "agent-1", name: "Agent 1" }
      ]);
      this.seed = saved.seed;
      this.agentConfigs.set("agent-1", { id: "agent-1", name: "Agent 1" });
      this.resetAgentLoopState(["agent-1"]);
    } else {
      return;
    }

    this.phase = "running";
    this.preparedSeed = null;
    this.threadIds = { gameplayByAgentId: {} };
    this.threadToAgentId.clear();
    this.activeTurn = null;
    this.schedulerIndex = 0;
    await this.logReplay("session.restored", {
      seed: this.seed,
      tick: this.simulation.getState().tick
    });
  }

  private async interruptActiveTurn(): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }
    const collector = this.pendingTurns.get(activeTurn.turnId);
    if (!collector) {
      return;
    }
    this.interruptedTurnIds.add(activeTurn.turnId);
    try {
      await this.codexClient.request("turn/interrupt", {
        threadId: collector.threadId,
        turnId: activeTurn.turnId
      });
    } catch {
      this.interruptedTurnIds.delete(activeTurn.turnId);
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
