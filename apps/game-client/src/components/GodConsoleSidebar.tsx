import { useMemo } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import type { RuntimeModelOption, SessionPhase } from "@codexgame/protocol";

type FeedItem = {
  id: string;
  agentId?: string | undefined;
  role: "god" | "agent" | "system" | "reasoning";
  text: string;
};

type AgentConfigDraft = {
  id: string;
  model: string;
  effort: string;
};

type RuntimeAgentOption = {
  id: string;
};

type FeedOwnerKind = "agent" | "god" | "system";
type FeedEntryKind = "message" | "action" | "reasoning" | "system";
type FeedEntry = {
  id: string;
  kind: FeedEntryKind;
  label: string;
  text: string;
};
type FeedGroup = {
  id: string;
  ownerKey: string;
  ownerKind: FeedOwnerKind;
  ownerLabel: string;
  entries: FeedEntry[];
};

type Props = {
  phase: SessionPhase;
  threadSummary: string;
  runtimeQueueAhead: number;
  worldSeedLabel: string;
  agentConfigs: AgentConfigDraft[];
  availableModels: RuntimeModelOption[];
  effortOptionsForModel: (modelValue: string, availableModels: RuntimeModelOption[]) => string[];
  updateAgentConfig: (index: number, key: keyof AgentConfigDraft, value: string) => void;
  removeAgentConfig: (index: number) => void;
  addAgentConfig: () => void;
  selectedAgentId: string;
  setSelectedAgentId: (value: string) => void;
  godTargetAgentId: string;
  setGodTargetAgentId: (value: string) => void;
  runtimeAgents: RuntimeAgentOption[];
  primarySessionLabel: string;
  primarySessionDisabled: boolean;
  onSessionPrimaryAction: () => void;
  onPrepareNewWorld: () => void;
  newDisabled: boolean;
  modelsCount: number;
  feed: FeedItem[];
  feedRef: RefObject<HTMLDivElement | null>;
  onFeedScroll: () => void;
  buildGoal: string;
  setBuildGoal: (value: string) => void;
  onBuildRequest: (event: FormEvent) => void;
  chatText: string;
  setChatText: (value: string) => void;
  onChatKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onChatSend: (event: FormEvent) => void;
  worldInteractionEnabled: boolean;
};

function formatReasoningText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "...";
  }
  if (/^thinking(?:\.\.\.)?$/i.test(trimmed)) {
    return "...";
  }
  return trimmed.replace(/^thinking(?:\.\.\.)?\s*/i, "");
}

function describeFeedOwner(item: FeedItem): { ownerKey: string; ownerKind: FeedOwnerKind; ownerLabel: string } {
  if (item.agentId) {
    return {
      ownerKey: `agent:${item.agentId}`,
      ownerKind: "agent",
      ownerLabel: item.agentId
    };
  }
  if (item.role === "god") {
    return {
      ownerKey: "god",
      ownerKind: "god",
      ownerLabel: "god"
    };
  }
  return {
    ownerKey: "system",
    ownerKind: "system",
    ownerLabel: "runtime"
  };
}

function describeFeedEntry(item: FeedItem): FeedEntry {
  if (item.role === "reasoning") {
    return {
      id: item.id,
      kind: "reasoning",
      label: "thinking",
      text: formatReasoningText(item.text)
    };
  }
  if (item.role === "agent") {
    return {
      id: item.id,
      kind: "message",
      label: "say",
      text: item.text
    };
  }
  if (item.role === "god") {
    return {
      id: item.id,
      kind: "message",
      label: "god",
      text: item.text
    };
  }
  const normalized = item.text.trim();
  const looksLikeAction = /^(move|talk|relation|inspect|loot|attack|gather|craft|place|wait|interact)\b/i.test(normalized);
  if (looksLikeAction) {
    return {
      id: item.id,
      kind: "action",
      label: "action",
      text: item.text
    };
  }
  const looksLikeTool = /^tool\b/i.test(normalized) || normalized.toLowerCase().includes("tool call");
  if (looksLikeTool) {
    return {
      id: item.id,
      kind: "action",
      label: "tool",
      text: item.text
    };
  }
  return {
    id: item.id,
    kind: "system",
    label: item.agentId ? "event" : "system",
    text: item.text
  };
}

export function GodConsoleSidebar(props: Props) {
  const {
    phase,
    threadSummary,
    runtimeQueueAhead,
    worldSeedLabel,
    agentConfigs,
    availableModels,
    effortOptionsForModel,
    updateAgentConfig,
    removeAgentConfig,
    addAgentConfig,
    selectedAgentId,
    setSelectedAgentId,
    godTargetAgentId,
    setGodTargetAgentId,
    runtimeAgents,
    primarySessionLabel,
    primarySessionDisabled,
    onSessionPrimaryAction,
    onPrepareNewWorld,
    newDisabled,
    modelsCount,
    feed,
    feedRef,
    onFeedScroll,
    buildGoal,
    setBuildGoal,
    onBuildRequest,
    chatText,
    setChatText,
    onChatKeyDown,
    onChatSend,
    worldInteractionEnabled
  } = props;

  const groupedFeed = useMemo(() => {
    const groups: FeedGroup[] = [];
    for (const item of feed) {
      const owner = describeFeedOwner(item);
      const entry = describeFeedEntry(item);
      const previous = groups[groups.length - 1];
      if (previous && previous.ownerKey === owner.ownerKey) {
        previous.entries.push(entry);
        continue;
      }
      groups.push({
        id: `${owner.ownerKey}-${item.id}`,
        ownerKey: owner.ownerKey,
        ownerKind: owner.ownerKind,
        ownerLabel: owner.ownerLabel,
        entries: [entry]
      });
    }
    return groups;
  }, [feed]);

  return (
    <aside className="console">
      <h2>God Console</h2>
      <div className="console-meta">
        <span className="pill">{threadSummary}</span>
        <span className="pill">Queue-ahead: {runtimeQueueAhead || "-"}</span>
        <span className="pill">{worldSeedLabel}</span>
      </div>

      {phase !== "running" ? (
        <div className="session-controls session-controls--setup">
          <div className="agent-config-list">
            {agentConfigs.map((agent, index) => (
              <div className="agent-config-card" key={`${agent.id}-${index}`}>
                <div className="agent-config-head">
                  <span>Agent {index + 1}</span>
                  {agentConfigs.length > 1 ? (
                    <button type="button" className="remove-agent-btn" onClick={() => removeAgentConfig(index)}>
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="agent-config-fields">
                  <input
                    className="agent-config-id"
                    value={agent.id}
                    onChange={(event) => updateAgentConfig(index, "id", event.target.value)}
                    placeholder="agent id"
                  />

                  {availableModels.length > 0 ? (
                    <select value={agent.model} onChange={(event) => updateAgentConfig(index, "model", event.target.value)}>
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.model}>
                          {model.displayName || model.model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select value="" disabled>
                      <option value="">no models</option>
                    </select>
                  )}

                  <select value={agent.effort} onChange={(event) => updateAgentConfig(index, "effort", event.target.value)}>
                    {effortOptionsForModel(agent.model, availableModels).map((effortOption) => (
                      <option key={effortOption} value={effortOption}>
                        {effortOption}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
          <div className="session-controls-inline">
            <span className="console-hint muted">Agents: {agentConfigs.length}/4</span>
            <button type="button" onClick={addAgentConfig} disabled={agentConfigs.length >= 4}>
              Add Agent
            </button>
          </div>
        </div>
      ) : (
        <div className="session-controls">
          <div className="session-controls-selects">
            <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
              {runtimeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.id}
                </option>
              ))}
            </select>
            <select value={godTargetAgentId} onChange={(event) => setGodTargetAgentId(event.target.value)}>
              <option value="all">All Agents</option>
              {runtimeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.id}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="session-controls-actions">
        <button type="button" onClick={onSessionPrimaryAction} className="button-compact" disabled={primarySessionDisabled}>
          {primarySessionLabel}
        </button>
        <button type="button" onClick={onPrepareNewWorld} className="button-compact" disabled={newDisabled}>
          New
        </button>
      </div>

      <div className="console-hint muted">Models from app-server: {modelsCount}</div>

      <div className="feed" ref={feedRef} onScroll={onFeedScroll}>
        {groupedFeed.length === 0 ? (
          <div className="feed-empty muted">No events yet.</div>
        ) : (
          groupedFeed.map((group) => (
            <div className={`feed-group feed-group--${group.ownerKind}`} key={group.id}>
              <div className="feed-group-head">
                <span className="feed-group-owner">{group.ownerLabel}</span>
                <span className="feed-group-count">{group.entries.length}</span>
              </div>
              <div className="feed-tree">
                {group.entries.map((entry) => (
                  <div className={`feed-entry feed-entry--${entry.kind}`} key={entry.id}>
                    <span className="feed-entry-label">{entry.label}</span>
                    <span className={entry.kind === "reasoning" ? "feed-entry-text feed-entry-text--reasoning" : "feed-entry-text"}>
                      {entry.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="console-compose">
        <form className="row" onSubmit={onBuildRequest}>
          <input
            value={buildGoal}
            onChange={(event) => setBuildGoal(event.target.value)}
            disabled={!worldInteractionEnabled}
            placeholder="Example: add a wooden shield recipe (3 wood, 2 fiber, output 1 wooden_shield)"
          />
          <button type="submit" disabled={!worldInteractionEnabled}>
            Build
          </button>
        </form>

        <form onSubmit={onChatSend}>
          <textarea
            rows={3}
            value={chatText}
            onChange={(event) => setChatText(event.target.value)}
            onKeyDown={onChatKeyDown}
            disabled={!worldInteractionEnabled}
            placeholder="Speak to the on-screen Codex agents..."
          />
          <div className="row chat-send-row">
            <button type="submit" disabled={!worldInteractionEnabled}>
              Send
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
