# `src/server/runtime.ts` under-500 plan

Current measurement on 2026-05-06:

- `src/server/runtime.ts`: **690 bun-cloc LOC**
- repo total from full `bun cloc`: **13967 LOC**

This is a planning document only. The user should review/refine before implementation.

## Why this file keeps growing

`runtime.ts` is the server-side orchestration sink. It owns:

- active session ordering
- session open/fork/resume/move/close
- shared state broadcast
- prompt dispatch and command handling
- context estimate publishing
- reset/compact maintenance
- generation lifecycle
- spawn-agent lifecycle
- model metadata refresh and alias suggestions
- startup recovery / interrupted tool repair / auto-continue
- MCP and inbox startup
- command tail loop

The file grew again because model metadata refresh, alias suggestions, spawn handling, target-cwd startup, and command/open behavior all landed in the runtime orchestrator.

## Architecture alternatives

### Alternative A — Runtime remains orchestrator; extract side domains

Move cohesive side domains out:

- `src/server/model-refresh.ts`
- `src/server/spawn.ts`
- `src/server/session-maintenance.ts`
- `src/server/runtime-startup.ts`

`runtime.ts` keeps session order, command loop, and high-level dispatch.

This is the recommended architecture.

### Alternative B — Command handler table/module

Move most `handleCommand()` cases into a command-handler table with injected runtime operations.

This could reduce `runtime.ts`, but it risks adapter churn and overlaps with `src/runtime/commands.ts`, which is currently also above 500. Use only after side-domain extraction.

### Alternative C — Supervisor/controller split

Split into:

- supervisor: startup, locks, watchers, tail loops
- session controller: active sessions, open/fork/resume/close/move
- generation controller: prompt/generation/context/reset/compact

This is clean long-term, but larger than needed for the first under-500 pass.

## Recommended execution path

### Step 1 — Extract model metadata refresh

Move to `src/server/model-refresh.ts`:

- `formatModelRefreshMessage()`
- `buildAliasUpdateSuggestionText()`
- `emitSyntheticAssistant()`
- `suggestAliasUpdates()`
- `refreshModelMetadata()`

New namespace:

```ts
export const modelRefresh = {
	refresh,
	formatModelRefreshMessage,
	buildAliasUpdateSuggestionText,
}
```

Expected impact:

- `runtime.ts`: -70 to -95 LOC
- repo net: flat/down

Why first: cohesive, weakly coupled, and clearly not core command/runtime dispatch.

### Step 2 — Extract spawn-agent lifecycle

Move to `src/server/spawn.ts` if the dependency injection stays small:

- `buildSpawnPrompt()`
- `spawnSession()`
- `startSpawnedSession()`

The helper may accept operations for:

- create session tab
- dispatch prompt command
- publish context estimate
- record info

If that ops object gets large, only move `buildSpawnPrompt()` and the prompt text construction.

Expected impact:

- `runtime.ts`: -35 to -55 LOC
- repo net: flat/slightly down

### Step 3 — Extract reset/compact maintenance

Move shared maintenance flow to `src/server/session-maintenance.ts` or dedupe locally if extraction adds too much glue:

- owns-host-lock guard
- active-generation guard
- old-log lookup
- rotation rewrite
- context estimate republish callback
- final user-visible info message

Expected impact:

- `runtime.ts`: -25 to -40 LOC
- repo net: flat/down

### Step 4 — Extract startup recovery and service startup

Move from `startRuntime()` to `src/server/runtime-startup.ts`:

- interrupted-tool repair loop
- auto-continue scan
- dynamic MCP startup
- inbox startup
- maybe abort cleanup wiring

Keep in `runtime.ts`:

- active runtime pid
- active session ids
- target-cwd activation
- broadcast timing
- command tail loop unless a later step addresses it

Expected impact:

- `runtime.ts`: -70 to -110 LOC
- repo net: flat/down

### Step 5 — Simplify `handleCommand()` after extraction

After spawn/reset/compact/open helpers are clearer, reduce `handleCommand()` into routing:

- helper for session-required commands
- helper for open command variants
- helper for resume
- cases call named operations

Expected impact:

- `runtime.ts`: -30 to -60 LOC
- repo net: small down

## Expected outcome

Conservative path:

- model refresh: 690 → ~610
- spawn: ~610 → ~565
- maintenance/startup: ~565 → ~490

Aggressive path:

- model refresh + runtime startup + command dispatch cleanup: **430–470 LOC**

## Tests to watch

- `src/server/runtime.test.ts`
- `tests/tabs.test.ts`
- `tests/ipc.test.ts`
- `tests/main.test.ts`
- `src/runtime/commands.test.ts`
- `src/runtime/context.test.ts`
- `src/runtime/agent-loop.test.ts`
- `src/tools/spawn_agent.test.ts`

## Must not happen

- Do not move logic into `src/runtime/commands.ts`; it is currently above 500.
- Do not make `src/server/sessions.ts` a dumping ground.
- Do not create a generic `runtime-manager` wrapper module.
- Do not repeat previous failed dedupe attempts unless current code visibly changed.
- Do not accept extraction if repo `bun cloc` grows materially.
