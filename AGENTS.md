# CodexGame

In this repository:

- Runtime authority lives in `apps/game-runtime`; the client must stay presentation-only.
- Keep gameplay model output schema-constrained (`AgentTurnOutput`) and JSON-only.
- Keep builder output schema-constrained (`BuildOutput`) and content-only.
- Do not add code-mutation operations to builder flow unless explicitly requested.
- Protocol changes must be made in `packages/protocol` first, then runtime/client wiring.

## Core Rules

- Use `@codexgame/protocol` types everywhere for WS message contracts.
- Use `@codexgame/simulation` as the single source of game-state transitions.
- Preserve determinism for same seed + same action stream.
- Runtime protocol version is `v1` in `packages/protocol/src/messages.ts`.
- Tick cadence and scheduler defaults are intentional:
  - `tickMs = 200` (5 Hz)
  - `schedulerMs = 500`
  - `turnTimeoutMs = 45000`
- Reconnect circuit breaker (`maxReconnectAttempts`) is a hard safety guard.
- Build writes must remain atomic (tmp + rename), as implemented in `contentStore.ts`.

## Repository Structure

- `apps/game-runtime`
  - `src/runtime/GameRuntimeServer.ts`: session lifecycle, autoplay loop, build flow, WS broadcast
  - `src/codex/CodexAppServerClient.ts`: app-server stdio JSON-RPC transport
  - `src/runtime/contentStore.ts`: load/validate/apply content operations atomically
  - `src/runtime/prompting.ts`: gameplay/build prompts and retry prompt
  - `src/runtime/replay.ts`: JSONL replay logging
  - `src/runtime/stateStore.ts`: persisted runtime snapshot
- `apps/game-client`
  - `src/App.tsx`: WS client, controls, feed, state wiring
  - `src/game/IsometricScene.ts`: placeholder isometric renderer
- `packages/protocol`
  - `src/messages.ts`: envelope + message contract
  - `src/actions.ts`: gameplay action schemas + JSON schema
  - `src/build.ts`: build operation schemas + JSON schema
- `packages/simulation`
  - `src/simulation.ts`: action application + actor/world updates
  - `src/world.ts`: seeded world generation + blocking logic
  - `src/snapshot.ts`: compact snapshot + prompt context

## Runtime/Agent Conventions

- Runtime starts two Codex threads per session:
  - gameplay thread (`thread/start`)
  - builder thread (`thread/start`)
- Gameplay turns use `turn/start` with:
  - `approvalPolicy: "never"`
  - output schema `agentTurnOutputJsonSchema`
  - prompt from `buildGameplayPrompt(...)`
- Build turns use `turn/start` with:
  - `approvalPolicy: "never"`
  - output schema `buildOutputJsonSchema`
  - prompt from `buildContentPrompt(...)`
- Invalid gameplay outputs:
  - one retry with `buildValidationRetryPrompt(...)`
  - then fallback `wait` action + temporary backoff

## WebSocket API Rules

Client -> Runtime:
- `session.start { seed? }`
- `god.send { text }`
- `build.request { goal }`
- `agent.pause {}`
- `agent.resume {}`

Runtime -> Client:
- `session.state`
- `world.snapshot`
- `agent.turn`
- `agent.action`
- `agent.feed`
- `build.result`
- `error`

When changing API shape:
1. Update `packages/protocol/src/messages.ts`.
2. Update runtime parsing/emits.
3. Update client handling.
4. Add or update tests.

## Prompting Rules

- Prompts must request strict JSON-only output (no markdown wrappers).
- Keep prompts grounded in compact world state (`buildPromptContext`).
- God messages are injected as highest-priority context for the next gameplay turn.
- Builder prompt must remain content-only and include current content snapshot.

## Testing

Run these before finalizing:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

Current key tests:
- `packages/simulation/test/simulation_determinism.test.ts`
- `apps/game-runtime/test/agentOutput.test.ts`
- `apps/game-runtime/test/contentStore.test.ts`
- `apps/game-runtime/test/ui-contract.integration.test.ts`

When changing simulation or protocol behavior, add/adjust tests first.

## Safety and Persistence

- Keep replay logs enabled (`data/replay/*.jsonl`) for debugging regressions.
- Keep periodic session snapshot persistence (`data/runtime/session.json`).
- Do not remove runtime error emission (`type: "error"`) paths; client depends on them.

## Performance and Build Notes

- Client build currently emits a large Phaser chunk warning; that is expected for now.
- Prefer incremental changes over broad refactors in runtime loop code.
- If changing render performance, do not move simulation authority into client.

## Common Tasks

Add a new gameplay action:
1. Update `packages/protocol/src/actions.ts` Zod + JSON schema.
2. Update `packages/simulation/src/simulation.ts` action handling.
3. Update prompt guidance if needed.
4. Add tests for validation + simulation behavior.

Add a new content operation:
1. Update `packages/protocol/src/build.ts` Zod + JSON schema.
2. Update `apps/game-runtime/src/runtime/contentStore.ts` apply logic.
3. Add write/atomicity tests.

Adjust runtime timing/safety:
1. Change `apps/game-runtime/src/runtime/config.ts`.
2. Validate scheduler + timeout behavior via runtime integration tests.

## Known Gaps (Next Agent Priorities)

1. Implement boot-time restore from `data/runtime/session.json`.
2. Add reconnect fault-injection integration tests.
3. Expose metrics snapshots to client (queue depth, invalid outputs, action success ratios).
4. Tighten app-server event correlation for all turn/item variants.
