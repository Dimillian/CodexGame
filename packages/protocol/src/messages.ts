import { z } from "zod";
import type { AgentAction } from "./actions";

export const PROTOCOL_VERSION = "v1" as const;

type Version = typeof PROTOCOL_VERSION;

export type SessionPhase = "idle" | "starting" | "running" | "error";
export type TurnEffort = string;
export type RuntimeModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
  defaultReasoningEffort: string | null;
  isDefault: boolean;
};

export type SessionAgentConfig = {
  id: string;
  name: string;
  model?: string | undefined;
  effort?: TurnEffort | undefined;
};

export type SessionStartPayload = {
  seed?: number | undefined;
  model?: string | undefined;
  effort?: TurnEffort | undefined;
  agents: SessionAgentConfig[];
};

export type ClientMessage =
  | {
      version: Version;
      type: "session.start";
      payload: SessionStartPayload;
    }
  | {
      version: Version;
      type: "god.send";
      payload: { text: string; targetAgentId?: string | undefined };
    }
  | {
      version: Version;
      type: "build.request";
      payload: { goal: string };
    }
  | {
      version: Version;
      type: "agent.pause";
      payload: Record<string, never>;
    }
  | {
      version: Version;
      type: "agent.resume";
      payload: Record<string, never>;
    }
  | {
      version: Version;
      type: "session.reset";
      payload: {
        seed?: number | undefined;
      };
    };

export type WorldNearbyEntity = {
  id: string;
  type: string;
  x: number;
  y: number;
  distance: number;
  hp?: number;
  maxHp?: number;
  hostile?: boolean;
};

type WorldResourceEntityMessage = {
  id: string;
  type: "resource";
  subtype: string;
  x: number;
  y: number;
  quantity: number;
};

type WorldCreatureEntityMessage = {
  id: string;
  type: "creature";
  subtype: string;
  x: number;
  y: number;
  quantity: number;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  aggroRange: number;
  attackRange: number;
  cooldownTicks: number;
  maxCooldownTicks: number;
  hostile: boolean;
  behaviorState: "idle" | "chase" | "attack";
};

export type ServerMessage =
  | {
      version: Version;
      type: "session.state";
      payload: {
        phase: SessionPhase;
        paused: boolean;
        preparedSeed: number | null;
        threadIds: { gameplayByAgentId: Record<string, string>; builder?: string };
        connected: boolean;
        runtime: {
          model: string | null;
          effort: TurnEffort;
          tickMs: number;
          schedulerMs: number;
          maxQueuedActionsBeforeTurn: number;
          availableModels: RuntimeModelOption[];
        };
      };
    }
  | {
      version: Version;
      type: "world.snapshot";
      payload: {
        tick: number;
        world: {
          width: number;
          height: number;
          seed: number;
          tiles: string[][];
          entities: Array<WorldResourceEntityMessage | WorldCreatureEntityMessage>;
          placements: Array<{ id: string; prefabId: string; x: number; y: number }>;
        };
        agents: Array<{
          id: string;
          name: string;
          x: number;
          y: number;
          facing: string;
          stamina: number;
          hp: number;
          maxHp: number;
          attack: number;
          defense: number;
          attackRange: number;
          cooldownTicks: number;
          alive: boolean;
          inventory: Record<string, number>;
          nearbyEntities: WorldNearbyEntity[];
          relations: {
            allies: string[];
            enemies: string[];
            neutral: string[];
          };
          inbox: Array<{
            fromAgentId: string;
            message: string;
            tick: number;
          }>;
          model: string | null;
          effort: TurnEffort;
        }>;
        catalog: {
          prefabs: Array<{
            id: string;
            name: string;
            kind: string;
          }>;
          recipes: Array<{
            id: string;
            input: Array<{
              item: string;
              count: number;
            }>;
            output: {
              item: string;
              count: number;
            };
          }>;
        };
      };
    }
  | {
      version: Version;
      type: "agent.turn";
      payload: {
        agentId: string;
        turnId: string;
        status: "started" | "completed" | "failed" | "interrupted";
        latencyMs: number;
        usage?: {
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number;
        };
      };
    }
  | {
      version: Version;
      type: "agent.action";
      payload: {
        agentId: string;
        action: AgentAction;
        result: "accepted" | "invalid" | "applied" | "rejected";
        reason?: string;
      };
    }
  | {
      version: Version;
      type: "agent.feed";
      payload: {
        agentId?: string;
        role: "god" | "agent" | "system" | "reasoning";
        text: string;
      };
    }
  | {
      version: Version;
      type: "build.result";
      payload: {
        status: "success" | "failed";
        changedFiles: string[];
        summary: string;
      };
    }
  | {
      version: Version;
      type: "error";
      payload: {
        code: string;
        message: string;
        recoverable: boolean;
      };
    };

const sessionAgentSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  model: z.string().min(1).max(120).optional(),
  effort: z.string().min(1).max(32).optional()
});

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("session.start"),
    payload: z.object({
      seed: z.number().int().optional(),
      model: z.string().min(1).max(120).optional(),
      effort: z.string().min(1).max(32).optional(),
      agents: z.array(sessionAgentSchema).min(1).max(4)
    })
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("god.send"),
    payload: z.object({ text: z.string().min(1), targetAgentId: z.string().min(1).optional() })
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("build.request"),
    payload: z.object({ goal: z.string().min(1) })
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("agent.pause"),
    payload: z.object({}).strict()
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("agent.resume"),
    payload: z.object({}).strict()
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("session.reset"),
    payload: z.object({
      seed: z.number().int().optional()
    })
  })
]);

export function parseClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as unknown;
  return clientMessageSchema.parse(parsed);
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
