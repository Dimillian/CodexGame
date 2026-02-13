import type { RuntimeModelOption } from "@codexgame/protocol";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toReasoningEntry(value: unknown): { reasoningEffort: string; description: string } | null {
  const entry = asRecord(value);
  if (!entry) {
    return null;
  }
  const reasoningEffort = normalizeText(entry.reasoningEffort ?? entry.reasoning_effort);
  if (!reasoningEffort) {
    return null;
  }
  return {
    reasoningEffort,
    description: String(entry.description ?? "")
  };
}

function parseReasoningEfforts(entry: Record<string, unknown>): RuntimeModelOption["supportedReasoningEfforts"] {
  const camel = entry.supportedReasoningEfforts;
  if (Array.isArray(camel)) {
    return camel
      .map((value) => toReasoningEntry(value))
      .filter((value): value is { reasoningEffort: string; description: string } => value !== null);
  }
  const snake = entry.supported_reasoning_efforts;
  if (Array.isArray(snake)) {
    return snake
      .map((value) => toReasoningEntry(value))
      .filter((value): value is { reasoningEffort: string; description: string } => value !== null);
  }
  return [];
}

function extractModelItems(raw: unknown): unknown[] {
  const top = asRecord(raw);
  if (!top) {
    return [];
  }
  const result = asRecord(top.result);
  if (result && Array.isArray(result.data)) {
    return result.data;
  }
  if (Array.isArray(top.data)) {
    return top.data;
  }
  return [];
}

export function parseModelListResponse(raw: unknown): RuntimeModelOption[] {
  return extractModelItems(raw)
    .map((item) => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }
      const id = normalizeText(record.id ?? record.model);
      const model = normalizeText(record.model ?? record.id);
      if (!id || !model) {
        return null;
      }
      const defaultReasoningEffort = normalizeText(
        record.defaultReasoningEffort ?? record.default_reasoning_effort
      );
      return {
        id,
        model,
        displayName: String(record.displayName ?? record.display_name ?? model),
        description: String(record.description ?? ""),
        supportedReasoningEfforts: parseReasoningEfforts(record),
        defaultReasoningEffort,
        isDefault: Boolean(record.isDefault ?? record.is_default ?? false)
      } satisfies RuntimeModelOption;
    })
    .filter((value): value is RuntimeModelOption => value !== null);
}

