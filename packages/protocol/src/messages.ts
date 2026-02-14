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
export type SessionStartPayload = {
  seed?: number | undefined;
  model?: string | undefined;
  effort?: TurnEffort | undefined;
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
      payload: { text: string };
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
};

export type ServerMessage =
  | {
      version: Version;
      type: "session.state";
      payload: {
        phase: SessionPhase;
        paused: boolean;
        preparedSeed: number | null;
        threadIds: { gameplay?: string; builder?: string };
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
          entities: Array<{
            id: string;
            type: "resource" | "creature";
            subtype: string;
            x: number;
            y: number;
            quantity: number;
          }>;
          placements: Array<{ id: string; prefabId: string; x: number; y: number }>;
        };
        actor: {
          id: string;
          x: number;
          y: number;
          facing: string;
          stamina: number;
        };
        inventory: Record<string, number>;
        nearbyEntities: WorldNearbyEntity[];
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
        action: AgentAction;
        result: "accepted" | "invalid" | "applied" | "rejected";
        reason?: string;
      };
    }
  | {
      version: Version;
      type: "agent.feed";
      payload: {
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

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("session.start"),
    payload: z.object({
      seed: z.number().int().optional(),
      model: z.string().min(1).max(120).optional(),
      effort: z.string().min(1).max(32).optional()
    })
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("god.send"),
    payload: z.object({ text: z.string().min(1) })
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
