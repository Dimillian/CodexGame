import type { JsonRpcNotification } from "../codex/CodexAppServerClient";

export function getParamString(params: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "";
}

export function getTurnIdFromNotification(notification: JsonRpcNotification): string {
  const params = notification.params;
  const turn = params.turn as Record<string, unknown> | undefined;
  return (
    getParamString(params, "turnId", "turn_id") ||
    (typeof turn?.id === "string" ? turn.id : "")
  );
}

export function getThreadIdFromNotification(notification: JsonRpcNotification): string {
  const params = notification.params;
  const thread = params.thread as Record<string, unknown> | undefined;
  return (
    getParamString(params, "threadId", "thread_id") ||
    (typeof thread?.id === "string" ? thread.id : "")
  );
}
