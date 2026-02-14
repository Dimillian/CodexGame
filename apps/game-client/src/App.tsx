import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Phaser from "phaser";
import type { RuntimeModelOption, ServerMessage, SessionPhase } from "@codexgame/protocol";
import { PROTOCOL_VERSION } from "@codexgame/protocol";
import { GodConsoleSidebar } from "./components/GodConsoleSidebar";
import { IsometricScene, type IsoSnapshot } from "./game/IsometricScene";

type FeedItem = {
  id: string;
  agentId?: string | undefined;
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

type RuntimeAgent = {
  id: string;
  name: string;
  x: number;
  y: number;
  stamina: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  inventory: Record<string, number>;
  nearbyEntities: Array<{ id: string; type: string; distance: number }>;
  model: string | null;
  effort: string;
};

type AgentConfigDraft = {
  id: string;
  model: string;
  effort: string;
};

const runtimeUrl = import.meta.env.VITE_RUNTIME_WS_URL ?? "ws://127.0.0.1:8787";

function formatItemId(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function defaultAgentConfig(index: number): AgentConfigDraft {
  const id = `agent-${index + 1}`;
  return {
    id,
    model: "",
    effort: "low"
  };
}

function effortOptionsForModel(modelValue: string, availableModels: RuntimeModelOption[]): string[] {
  if (!modelValue) {
    return ["low", "medium", "high"];
  }
  const model = availableModels.find((entry) => entry.model === modelValue);
  if (!model) {
    return ["low", "medium", "high"];
  }
  const supported = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  const withDefault = model.defaultReasoningEffort ? [model.defaultReasoningEffort, ...supported] : supported;
  const unique = [...new Set(withDefault.filter((value) => value.trim().length > 0))];
  return unique.length > 0 ? unique : ["low", "medium", "high"];
}

function defaultModelValue(availableModels: RuntimeModelOption[]): string {
  const defaultModel = availableModels.find((model) => model.isDefault) ?? availableModels[0];
  return defaultModel?.model ?? "";
}

export default function App() {
  const phaserContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<IsometricScene | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const shouldStickFeedToBottomRef = useRef(true);
  const selectedAgentIdRef = useRef<string>("agent-1");

  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [connected, setConnected] = useState(false);
  const [threadIds, setThreadIds] = useState<{ gameplayByAgentId: Record<string, string>; builder?: string }>({
    gameplayByAgentId: {}
  });
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [latencyMs, setLatencyMs] = useState<number>(0);
  const [tick, setTick] = useState<number>(0);
  const [catalog, setCatalog] = useState<{ prefabs: CatalogPrefab[]; recipes: CatalogRecipe[] }>({
    prefabs: [],
    recipes: []
  });
  const [worldEntities, setWorldEntities] = useState<Array<{ id: string; type: "resource" | "creature"; subtype: string; quantity: number }>>([]);
  const [runtimeAgents, setRuntimeAgents] = useState<RuntimeAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("agent-1");

  const [buildGoal, setBuildGoal] = useState("");
  const [chatText, setChatText] = useState("");
  const [godTargetAgentId, setGodTargetAgentId] = useState<string>("all");
  const [paused, setPaused] = useState(false);
  const [preparedSeed, setPreparedSeed] = useState<number | null>(null);

  const [availableModels, setAvailableModels] = useState<RuntimeModelOption[]>([]);
  const [runtimeModel, setRuntimeModel] = useState<string | null>(null);
  const [runtimeEffort, setRuntimeEffort] = useState<string>("low");
  const [runtimeSchedulerMs, setRuntimeSchedulerMs] = useState<number>(0);
  const [runtimeQueueAhead, setRuntimeQueueAhead] = useState<number>(0);

  const [agentConfigs, setAgentConfigs] = useState<AgentConfigDraft[]>([defaultAgentConfig(0)]);

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  function appendFeed(role: FeedItem["role"], text: string, agentId?: string): void {
    setFeed((current) => {
      if (role === "reasoning" && current.length > 0) {
        const last = current[current.length - 1];
        if (last && last.role === "reasoning" && last.agentId === agentId) {
          const merged = [...current];
          merged[merged.length - 1] = {
            ...last,
            text: `${last.text}${text}`
          };
          return merged.slice(-160);
        }
      }
      return [
        ...current,
        {
          id: `${Date.now()}-${Math.random()}`,
          role,
          text,
          agentId
        }
      ].slice(-160);
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
    scene.setOnAgentSelect((agentId) => {
      setSelectedAgentId(agentId);
    });
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
          setPaused(message.payload.paused);
          setPreparedSeed(message.payload.preparedSeed);
          setThreadIds(message.payload.threadIds);
          setRuntimeModel(message.payload.runtime.model);
          setRuntimeEffort(message.payload.runtime.effort);
          setRuntimeSchedulerMs(message.payload.runtime.schedulerMs);
          setRuntimeQueueAhead(message.payload.runtime.maxQueuedActionsBeforeTurn);
          setAvailableModels(message.payload.runtime.availableModels);
          if (message.payload.phase === "idle") {
            setTick(0);
            setRuntimeAgents([]);
            setWorldEntities([]);
            setCatalog({ prefabs: [], recipes: [] });
            sceneRef.current?.clearSnapshot();
          }
          return;
        case "world.snapshot": {
          const currentSelectedAgentId = selectedAgentIdRef.current;
          const nextSnapshot: IsoSnapshot = {
            seed: message.payload.world.seed,
            tiles: message.payload.world.tiles,
            entities: message.payload.world.entities,
            agents: message.payload.agents.map((agent) => ({
              id: agent.id,
              name: agent.name,
              x: agent.x,
              y: agent.y,
              alive: agent.alive
            })),
            focusedAgentId: currentSelectedAgentId,
            placements: message.payload.world.placements
          };

          setTick(message.payload.tick);
          setRuntimeAgents(message.payload.agents);
          setWorldEntities(
            message.payload.world.entities.map((entity) => ({
              id: entity.id,
              type: entity.type,
              subtype: entity.subtype,
              quantity: entity.quantity
            }))
          );
          setCatalog(message.payload.catalog);

          if (!message.payload.agents.some((agent) => agent.id === currentSelectedAgentId)) {
            setSelectedAgentId(message.payload.agents[0]?.id ?? "agent-1");
          }

          sceneRef.current?.setSnapshot(nextSnapshot);
          return;
        }
        case "agent.feed":
          appendFeed(message.payload.role, message.payload.text, message.payload.agentId);
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

  useEffect(() => {
    const node = feedRef.current;
    if (!node || !shouldStickFeedToBottomRef.current) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [feed]);

  const selectedAgent = useMemo(
    () => runtimeAgents.find((agent) => agent.id === selectedAgentId) ?? runtimeAgents[0] ?? null,
    [runtimeAgents, selectedAgentId]
  );

  useEffect(() => {
    const fallbackModel = defaultModelValue(availableModels);
    if (!fallbackModel) {
      return;
    }
    setAgentConfigs((current) =>
      current.map((entry) => {
        const model = entry.model || fallbackModel;
        const options = effortOptionsForModel(model, availableModels);
        const effort = options.includes(entry.effort) ? entry.effort : (options[0] ?? "low");
        if (model === entry.model && effort === entry.effort) {
          return entry;
        }
        return { ...entry, model, effort };
      })
    );
  }, [availableModels]);

  const threadSummary = useMemo(() => {
    const ids = Object.entries(threadIds.gameplayByAgentId)
      .map(([agentId, threadId]) => `${agentId}:${threadId.slice(0, 6)}`)
      .join(" | ");
    const builder = threadIds.builder ? `build:${threadIds.builder.slice(0, 6)}` : "build:-";
    return `${ids || "agents:-"} | ${builder}`;
  }, [threadIds]);

  const itemNameById = useMemo(() => {
    const entries = catalog.prefabs.map((prefab) => [prefab.id, prefab.name] as const);
    return new Map(entries);
  }, [catalog.prefabs]);

  const inventoryEntries = useMemo(() => {
    if (!selectedAgent) {
      return [];
    }
    return Object.entries(selectedAgent.inventory)
      .map(([item, count]) => ({
        item,
        count,
        label: itemNameById.get(item) ?? formatItemId(item)
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [selectedAgent, itemNameById]);

  const nearbyResources = useMemo(() => {
    if (!selectedAgent) {
      return [] as Array<{ id: string; subtype: string; quantity: number; distance: number }>;
    }
    const quantityById = new Map(worldEntities.map((entity) => [entity.id, entity.quantity] as const));
    const typeById = new Map(worldEntities.map((entity) => [entity.id, entity.subtype] as const));

    return selectedAgent.nearbyEntities
      .filter((entity) => entity.type.startsWith("resource:"))
      .map((entity) => ({
        id: entity.id,
        subtype: typeById.get(entity.id) ?? entity.type.replace("resource:", ""),
        quantity: quantityById.get(entity.id) ?? 0,
        distance: entity.distance
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
  }, [selectedAgent, worldEntities]);

  const recipeRows = useMemo(() => {
    if (!selectedAgent) {
      return [];
    }
    return catalog.recipes.map((recipe) => {
      const craftable = recipe.input.every((ingredient) => (selectedAgent.inventory[ingredient.item] ?? 0) >= ingredient.count);
      return {
        id: recipe.id,
        output: `${itemNameById.get(recipe.output.item) ?? formatItemId(recipe.output.item)} x${recipe.output.count}`,
        input: recipe.input.map((ingredient) => `${formatItemId(ingredient.item)} x${ingredient.count}`).join(", "),
        craftable
      };
    });
  }, [catalog.recipes, selectedAgent, itemNameById]);

  const buildableRows = useMemo(() => {
    if (!selectedAgent) {
      return [];
    }
    return catalog.prefabs
      .filter((prefab) => prefab.kind === "structure")
      .map((prefab) => ({
        id: prefab.id,
        label: prefab.name,
        owned: selectedAgent.inventory[prefab.id] ?? 0
      }));
  }, [catalog.prefabs, selectedAgent]);

  function send(payload: Record<string, unknown>): void {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function startSession(seed?: number): void {
    const sanitized = agentConfigs
      .map((config, index) => ({
        id: config.id.trim() || `agent-${index + 1}`,
        name: config.id.trim() || `agent-${index + 1}`,
        model: config.model.trim() || undefined,
        effort: config.effort.trim() || undefined
      }))
      .slice(0, 4);

    send({
      version: PROTOCOL_VERSION,
      type: "session.start",
      payload: {
        seed,
        agents: sanitized
      }
    });
  }

  function togglePause(): void {
    send({
      version: PROTOCOL_VERSION,
      type: paused ? "agent.resume" : "agent.pause",
      payload: {}
    });
  }

  function prepareNewWorld(): void {
    const nextSeed = Math.floor(Math.random() * 1_000_000_000);
    setFeed([]);
    setChatText("");
    setBuildGoal("");
    setLatencyMs(0);
    setTick(0);
    setRuntimeAgents([]);
    setWorldEntities([]);
    setCatalog({ prefabs: [], recipes: [] });
    setPhase("idle");
    setPaused(false);
    setPreparedSeed(nextSeed);
    sceneRef.current?.clearSnapshot();
    send({
      version: PROTOCOL_VERSION,
      type: "session.reset",
      payload: {
        seed: nextSeed
      }
    });
  }

  function onSessionPrimaryAction(): void {
    if (phase === "running") {
      togglePause();
      return;
    }
    startSession(preparedSeed ?? undefined);
  }

  function onBuildRequest(event: FormEvent): void {
    event.preventDefault();
    if (phase !== "running") {
      return;
    }
    send({
      version: PROTOCOL_VERSION,
      type: "build.request",
      payload: {
        goal: buildGoal
      }
    });
  }

  function sendGodMessage(text: string): void {
    send({
      version: PROTOCOL_VERSION,
      type: "god.send",
      payload: {
        text,
        targetAgentId: godTargetAgentId === "all" ? undefined : godTargetAgentId
      }
    });
  }

  function onChatSend(event: FormEvent): void {
    event.preventDefault();
    if (phase !== "running") {
      return;
    }
    const text = chatText.trim();
    if (!text) {
      return;
    }
    sendGodMessage(text);
    setChatText("");
  }

  function onChatKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (phase !== "running") {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const text = chatText.trim();
    if (!text) {
      return;
    }
    sendGodMessage(text);
    setChatText("");
  }

  function updateAgentConfig(index: number, key: keyof AgentConfigDraft, value: string): void {
    setAgentConfigs((current) =>
      current.map((entry, idx) => {
        if (idx !== index) {
          return entry;
        }
        if (key === "model") {
          const options = effortOptionsForModel(value, availableModels);
          return {
            ...entry,
            model: value,
            effort: options.includes(entry.effort) ? entry.effort : (options[0] ?? "low")
          };
        }
        return { ...entry, [key]: value };
      })
    );
  }

  function addAgentConfig(): void {
    setAgentConfigs((current) => {
      if (current.length >= 4) {
        return current;
      }
      const next = defaultAgentConfig(current.length);
      const model = defaultModelValue(availableModels);
      const effort = effortOptionsForModel(model, availableModels)[0] ?? "low";
      return [
        ...current,
        {
          ...next,
          model,
          effort
        }
      ];
    });
  }

  function removeAgentConfig(index: number): void {
    setAgentConfigs((current) => (current.length <= 1 ? current : current.filter((_, idx) => idx !== index)));
  }

  const primarySessionLabel = phase === "running" ? (paused ? "Resume" : "Pause") : phase === "starting" ? "Starting..." : "Start";
  const primarySessionDisabled = !connected || phase === "starting";
  const worldSeedLabel = preparedSeed ? `Next World Seed: ${preparedSeed}` : "Next World Seed: random";
  const worldInteractionEnabled = phase === "running";

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
              <h3>Selected Agent</h3>
              <p>Tick: {tick}</p>
              <p>Agent: {selectedAgent?.id ?? "-"}</p>
              <p>Status: {selectedAgent?.alive ? "alive" : "down"}</p>
              <p>
                HP: {selectedAgent?.hp ?? 0}/{selectedAgent?.maxHp ?? 0}
              </p>
              <p>Stamina: {selectedAgent?.stamina ?? 0}</p>
            </div>

            <div className="hud-card">
              <h3>Agents</h3>
              {runtimeAgents.map((agent) => (
                <p key={agent.id} className={agent.id === selectedAgent?.id ? "ok" : undefined}>
                  {agent.id} {agent.hp}/{agent.maxHp}
                </p>
              ))}
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

      <GodConsoleSidebar
        phase={phase}
        threadSummary={threadSummary}
        runtimeQueueAhead={runtimeQueueAhead}
        worldSeedLabel={worldSeedLabel}
        agentConfigs={agentConfigs}
        availableModels={availableModels}
        effortOptionsForModel={effortOptionsForModel}
        updateAgentConfig={updateAgentConfig}
        removeAgentConfig={removeAgentConfig}
        addAgentConfig={addAgentConfig}
        selectedAgentId={selectedAgentId}
        setSelectedAgentId={setSelectedAgentId}
        godTargetAgentId={godTargetAgentId}
        setGodTargetAgentId={setGodTargetAgentId}
        runtimeAgents={runtimeAgents.map((agent) => ({ id: agent.id }))}
        primarySessionLabel={primarySessionLabel}
        primarySessionDisabled={primarySessionDisabled}
        onSessionPrimaryAction={onSessionPrimaryAction}
        onPrepareNewWorld={prepareNewWorld}
        newDisabled={!connected || phase === "starting"}
        modelsCount={availableModels.length}
        feed={feed}
        feedRef={feedRef}
        onFeedScroll={onFeedScroll}
        buildGoal={buildGoal}
        setBuildGoal={setBuildGoal}
        onBuildRequest={onBuildRequest}
        chatText={chatText}
        setChatText={setChatText}
        onChatKeyDown={onChatKeyDown}
        onChatSend={onChatSend}
        worldInteractionEnabled={worldInteractionEnabled}
      />
    </div>
  );
}
