import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Phaser from "phaser";
import type { RuntimeModelOption, ServerMessage, SessionPhase, TurnEffort } from "@codexgame/protocol";
import { PROTOCOL_VERSION } from "@codexgame/protocol";
import { IsometricScene, type IsoSnapshot } from "./game/IsometricScene";

type FeedItem = {
  id: string;
  role: "god" | "agent" | "system" | "reasoning";
  text: string;
};

type CatalogRecipe = {
  id: string;
  input: Array<{ item: string; count: number }>;
  output: { item: string; count: number };
};

type CatalogPrefab = {
  id: string;
  name: string;
  kind: string;
};

const runtimeUrl = import.meta.env.VITE_RUNTIME_WS_URL ?? "ws://127.0.0.1:8787";

function formatItemId(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

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

export default function App() {
  const phaserContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<IsometricScene | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const shouldStickFeedToBottomRef = useRef(true);

  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [connected, setConnected] = useState(false);
  const [threadIds, setThreadIds] = useState<{ gameplay?: string; builder?: string }>({});
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [latencyMs, setLatencyMs] = useState<number>(0);
  const [tick, setTick] = useState<number>(0);
  const [stamina, setStamina] = useState<number>(0);
  const [inventory, setInventory] = useState<Record<string, number>>({});
  const [nearbyResources, setNearbyResources] = useState<Array<{ id: string; subtype: string; quantity: number; distance: number }>>([]);
  const [catalog, setCatalog] = useState<{ prefabs: CatalogPrefab[]; recipes: CatalogRecipe[] }>({
    prefabs: [],
    recipes: []
  });
  const [buildGoal, setBuildGoal] = useState("");
  const [chatText, setChatText] = useState("");
  const [paused, setPaused] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [effort, setEffort] = useState<TurnEffort>("low");
  const [availableModels, setAvailableModels] = useState<RuntimeModelOption[]>([]);
  const [runtimeModel, setRuntimeModel] = useState<string | null>(null);
  const [runtimeEffort, setRuntimeEffort] = useState<TurnEffort>("low");
  const [runtimeSchedulerMs, setRuntimeSchedulerMs] = useState<number>(0);
  const [runtimeQueueAhead, setRuntimeQueueAhead] = useState<number>(0);

  function appendFeed(role: FeedItem["role"], text: string): void {
    setFeed((current) => {
      if (role === "reasoning" && current.length > 0) {
        const last = current[current.length - 1];
        if (last && last.role === "reasoning") {
          const merged = [...current];
          merged[merged.length - 1] = {
            ...last,
            text: `${last.text}${text}`
          };
          return merged.slice(-100);
        }
      }
      return [
        ...current,
        {
          id: `${Date.now()}-${Math.random()}`,
          role,
          text
        }
      ].slice(-100);
    });
  }

  function onFeedScroll(): void {
    const node = feedRef.current;
    if (!node) {
      return;
    }
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    shouldStickFeedToBottomRef.current = distanceFromBottom < 24;
  }

  useEffect(() => {
    if (!phaserContainerRef.current) {
      return;
    }

    const scene = new IsometricScene();
    sceneRef.current = scene;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: phaserContainerRef.current,
      width: phaserContainerRef.current.clientWidth,
      height: phaserContainerRef.current.clientHeight,
      scene: [scene],
      transparent: true
    });

    return () => {
      game.destroy(true);
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ws = new WebSocket(runtimeUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;

      switch (message.type) {
        case "session.state":
          setPhase(message.payload.phase);
          setThreadIds(message.payload.threadIds);
          setRuntimeModel(message.payload.runtime.model);
          setRuntimeEffort(message.payload.runtime.effort);
          setRuntimeSchedulerMs(message.payload.runtime.schedulerMs);
          setRuntimeQueueAhead(message.payload.runtime.maxQueuedActionsBeforeTurn);
          setAvailableModels(message.payload.runtime.availableModels);
          return;
        case "world.snapshot": {
          const nextSnapshot: IsoSnapshot = {
            tiles: message.payload.world.tiles,
            entities: message.payload.world.entities,
            actor: {
              x: message.payload.actor.x,
              y: message.payload.actor.y
            },
            placements: message.payload.world.placements
          };

          const resources = message.payload.world.entities
            .filter((entity) => entity.type === "resource")
            .map((entity) => ({
              id: entity.id,
              subtype: entity.subtype,
              quantity: entity.quantity,
              distance: Math.abs(entity.x - message.payload.actor.x) + Math.abs(entity.y - message.payload.actor.y)
            }))
            .filter((entity) => entity.distance <= 6)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 8);

          setTick(message.payload.tick);
          setStamina(message.payload.actor.stamina);
          setInventory(message.payload.inventory);
          setCatalog(message.payload.catalog);
          setNearbyResources(resources);
          sceneRef.current?.setSnapshot(nextSnapshot);
          return;
        }
        case "agent.feed":
          appendFeed(message.payload.role, message.payload.text);
          return;
        case "agent.turn":
          setLatencyMs(message.payload.latencyMs);
          return;
        case "build.result":
          appendFeed("system", `Build ${message.payload.status}: ${message.payload.summary}`);
          return;
        case "error":
          appendFeed("system", `Error (${message.payload.code}): ${message.payload.message}`);
          return;
        default:
          return;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const threadSummary = useMemo(() => {
    const gameplay = threadIds.gameplay ? `game: ${threadIds.gameplay.slice(0, 8)}` : "game: -";
    const builder = threadIds.builder ? `build: ${threadIds.builder.slice(0, 8)}` : "build: -";
    return `${gameplay} | ${builder}`;
  }, [threadIds.builder, threadIds.gameplay]);

  useEffect(() => {
    if (availableModels.length === 0) {
      return;
    }
    if (selectedModelId && availableModels.some((model) => model.id === selectedModelId)) {
      return;
    }
    const defaultModel = availableModels.find((model) => model.isDefault) ?? availableModels[0];
    if (defaultModel) {
      setSelectedModelId(defaultModel.id);
    }
  }, [availableModels, selectedModelId]);

  const selectedModel = useMemo(
    () => availableModels.find((model) => model.id === selectedModelId) ?? null,
    [availableModels, selectedModelId]
  );

  const effortOptions = useMemo(() => {
    const fromModel = selectedModel?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) ?? [];
    const fromDefault = selectedModel?.defaultReasoningEffort ? [selectedModel.defaultReasoningEffort] : [];
    const merged = [...new Set([...fromModel, ...fromDefault].filter((value) => value.trim().length > 0))];
    if (merged.length > 0) {
      return merged;
    }
    return ["low", "medium", "high"];
  }, [selectedModel]);

  useEffect(() => {
    if (effortOptions.includes(effort)) {
      return;
    }
    setEffort(effortOptions[0] ?? "low");
  }, [effort, effortOptions]);

  useEffect(() => {
    const node = feedRef.current;
    if (!node || !shouldStickFeedToBottomRef.current) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [feed]);

  const itemNameById = useMemo(() => {
    const entries = catalog.prefabs.map((prefab) => [prefab.id, prefab.name] as const);
    return new Map(entries);
  }, [catalog.prefabs]);

  const inventoryEntries = useMemo(
    () =>
      Object.entries(inventory)
        .map(([item, count]) => ({
          item,
          count,
          label: itemNameById.get(item) ?? formatItemId(item)
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    [inventory, itemNameById]
  );

  const recipeRows = useMemo(
    () =>
      catalog.recipes.map((recipe) => {
        const craftable = recipe.input.every((ingredient) => (inventory[ingredient.item] ?? 0) >= ingredient.count);
        return {
          id: recipe.id,
          output: `${itemNameById.get(recipe.output.item) ?? formatItemId(recipe.output.item)} x${recipe.output.count}`,
          input: recipe.input
            .map((ingredient) => `${formatItemId(ingredient.item)} x${ingredient.count}`)
            .join(", "),
          craftable
        };
      }),
    [catalog.recipes, inventory, itemNameById]
  );

  const buildableRows = useMemo(
    () =>
      catalog.prefabs
        .filter((prefab) => prefab.kind === "structure")
        .map((prefab) => ({
          id: prefab.id,
          label: prefab.name,
          owned: inventory[prefab.id] ?? 0
        })),
    [catalog.prefabs, inventory]
  );

  function send(payload: Record<string, unknown>): void {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function startSession(): void {
    send({
      version: PROTOCOL_VERSION,
      type: "session.start",
      payload: {
        model: selectedModel?.model ?? undefined,
        effort
      }
    });
  }

  function togglePause(): void {
    const next = !paused;
    setPaused(next);
    send({
      version: PROTOCOL_VERSION,
      type: next ? "agent.pause" : "agent.resume",
      payload: {}
    });
  }

  function onBuildRequest(event: FormEvent): void {
    event.preventDefault();
    send({
      version: PROTOCOL_VERSION,
      type: "build.request",
      payload: {
        goal: buildGoal
      }
    });
  }

  function onChatSend(event: FormEvent): void {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) {
      return;
    }
    send({
      version: PROTOCOL_VERSION,
      type: "god.send",
      payload: {
        text
      }
    });
    setChatText("");
  }

  function onChatKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const text = chatText.trim();
    if (!text) {
      return;
    }
    send({
      version: PROTOCOL_VERSION,
      type: "god.send",
      payload: {
        text
      }
    });
    setChatText("");
  }

  return (
    <div className="app">
      <div className="game-shell">
        <div className="game-topbar">
          <span className="pill">Runtime: {connected ? "connected" : "offline"}</span>
          <span className="pill">Phase: {phase}</span>
          <span className="pill">Latency: {latencyMs}ms</span>
          <span className="pill">Model: {runtimeModel ?? "default"}</span>
          <span className="pill">
            Effort: {runtimeEffort} | Scheduler: {runtimeSchedulerMs || "-"}ms
          </span>
        </div>

        <div className="game-stage">
          <div className="game-surface" ref={phaserContainerRef} />
          <div className="game-hud">
            <div className="hud-card">
              <h3>Agent</h3>
              <p>Tick: {tick}</p>
              <p>Stamina: {stamina}</p>
            </div>

            <div className="hud-card">
              <h3>Inventory</h3>
              {inventoryEntries.length === 0 ? (
                <p className="muted">Empty</p>
              ) : (
                inventoryEntries.map((entry) => (
                  <p key={entry.item}>
                    {entry.label}: {entry.count}
                  </p>
                ))
              )}
            </div>

            <div className="hud-card">
              <h3>Nearby Resources</h3>
              {nearbyResources.length === 0 ? (
                <p className="muted">None in range</p>
              ) : (
                nearbyResources.map((resource) => (
                  <p key={resource.id}>
                    {formatItemId(resource.subtype)} (q{resource.quantity}) d{resource.distance}
                  </p>
                ))
              )}
            </div>

            <div className="hud-card">
              <h3>Crafting</h3>
              {recipeRows.length === 0 ? (
                <p className="muted">No recipes</p>
              ) : (
                recipeRows.map((row) => (
                  <p key={row.id} className={row.craftable ? "ok" : "muted"}>
                    {row.output} [{row.craftable ? "ready" : row.input}]
                  </p>
                ))
              )}
            </div>

            <div className="hud-card">
              <h3>Buildables</h3>
              {buildableRows.map((row) => (
                <p key={row.id}>
                  {row.label}: {row.owned}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>

      <aside className="console">
        <h2>God Console</h2>
        <div className="console-meta">
          <span className="pill">{threadSummary}</span>
          <span className="pill">Queue-ahead: {runtimeQueueAhead || "-"}</span>
        </div>
        <div className="session-controls">
          <select
            aria-label="Model"
            value={selectedModelId}
            onChange={(event) => setSelectedModelId(event.target.value)}
          >
            <option value="">Default model</option>
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName || model.model}
              </option>
            ))}
          </select>
          <select
            aria-label="Reasoning effort"
            value={effort}
            onChange={(event) => setEffort(event.target.value as TurnEffort)}
          >
            {effortOptions.map((effortOption) => (
              <option key={effortOption} value={effortOption}>
                {effortOption}
              </option>
            ))}
          </select>
          <button type="button" onClick={startSession} className="button-compact">
            Start
          </button>
          <button type="button" onClick={togglePause} className="button-compact">
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
        <div className="console-hint muted">Models from app-server: {availableModels.length}</div>

        <div className="feed" ref={feedRef} onScroll={onFeedScroll}>
          {feed.map((item) => (
            <div className={`feed-item${item.role === "reasoning" ? " feed-item--reasoning" : ""}`} key={item.id}>
              <span className={`feed-role feed-role--${item.role}`}>
                {item.role === "reasoning" ? "thinking" : item.role}
              </span>
              <span className={item.role === "reasoning" ? "feed-text--reasoning" : undefined}>
                {item.role === "reasoning" ? formatReasoningText(item.text) : item.text}
              </span>
            </div>
          ))}
        </div>

        <div className="console-compose">
          <form className="row" onSubmit={onBuildRequest}>
            <input
              value={buildGoal}
              onChange={(event) => setBuildGoal(event.target.value)}
              placeholder="Example: add a wooden shield recipe (3 wood, 2 fiber, output 1 wooden_shield)"
            />
            <button type="submit">Build</button>
          </form>

          <form onSubmit={onChatSend}>
            <textarea
              rows={3}
              value={chatText}
              onChange={(event) => setChatText(event.target.value)}
              onKeyDown={onChatKeyDown}
              placeholder="Speak to the on-screen Codex agent..."
            />
            <div className="row chat-send-row">
              <button type="submit">Send</button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  );
}
