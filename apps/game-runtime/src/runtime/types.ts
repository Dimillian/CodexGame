import type { AgentAction, BuildOutput, ContentOperation, ServerMessage, SessionPhase } from "@codexgame/protocol";
import type { ContentSet, SimulationState, WorldSnapshot } from "@codexgame/simulation";

export type ThreadIds = {
  gameplay?: string;
  builder?: string;
};

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type CompletedTurn = {
  turnId: string;
  text: string;
  usage?: TurnUsage;
  latencyMs: number;
};

export type RuntimeMetrics = {
  turnsTotal: number;
  invalidOutputCount: number;
  actionAppliedCount: number;
  actionRejectedCount: number;
  queuedActions: number;
};

export type SessionSnapshot = {
  seed: number;
  tick: number;
  actor: WorldSnapshot["actor"];
  threadIds: ThreadIds;
  metrics: RuntimeMetrics;
  simulation: SimulationState;
};

export type BuildApplyResult = {
  changedFiles: string[];
  content: ContentSet;
  operations: ContentOperation[];
};

export type AgentLoopState = {
  phase: SessionPhase;
  connected: boolean;
  paused: boolean;
  activeTurnId: string | null;
  lastTurnStartAt: number | null;
  actionQueue: AgentAction[];
};

export type RuntimeEvent = {
  ts: number;
  event: string;
  payload: Record<string, unknown>;
};

export type BroadcastFn = (message: ServerMessage) => void;

export type BuildRequestResult = {
  status: "success" | "failed";
  summary: string;
  changedFiles: string[];
};

export type BuildTurnResult = {
  parsed: BuildOutput;
  turn: CompletedTurn;
};
