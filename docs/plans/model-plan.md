# Per-Tab Model / Provider Plan

## Goal

Allow each tab (session) to use its own provider/model, so:

- `/model` in one tab does not change other tabs
- multiple models can run side-by-side in one HAL process for comparison
- different tabs can use different models for different jobs

## Current Behavior (Root Cause)

Model selection is global today.

- `/model` updates `config.ason` via `updateConfig({ model })`
	- `src/runtime/handle-command.ts:291`
	- `src/runtime/handle-command.ts:301`
- `config.ason` lives under `HAL_DIR`, not `HAL_STATE_DIR`
	- `src/config.ts:5`
	- `src/state.ts:4`
	- `src/state.ts:7`
- `-f/--fresh` only creates a fresh state dir, so it does not isolate model config
	- `src/args.ts:8`
	- `src/args.ts:29`
	- `src/args.ts:32`

This explains the "whoops" behavior: a fresh run gets fresh sessions, but still mutates the shared default model in `config.ason`.

## Where Model Is Assumed Global

The runtime currently reads `loadConfig().model` at execution time in multiple places:

- prompt logging + provider selection
	- `src/runtime/process-prompt.ts:62`
	- `src/runtime/process-prompt.ts:64`
- agent loop provider/model selection
	- `src/runtime/agent-loop.ts:27`
	- `src/runtime/agent-loop.ts:32`
- system prompt reload (`<if model="...">` tags in `SYSTEM.md` / `AGENTS.md`)
	- `src/runtime/sessions.ts:202`
	- `src/runtime/sessions.ts:207`
	- `src/prompt.ts:5`
- handoff summary compact model selection
	- `src/runtime/handle-command.ts:200`
	- `src/runtime/handle-command.ts:210`

## Session Persistence Gap

Session metadata does not currently store a model/provider.

- `SessionInfo` has no `model` field
	- `src/session.ts:11`
- new sessions are created without model metadata
	- `src/runtime/sessions.ts:141`
	- `src/runtime/sessions.ts:146`
- session registry loader does not backfill/migrate session model
	- `src/session.ts:80`
	- `src/session.ts:94`

This means per-tab model support needs persistence changes, not just UI changes.

## Recommended Design

### 1) Make model session-scoped

Add an optional `model?: string` to `SessionInfo` (stored as full `provider/model-id`).

Behavior:

- `config.model` remains the default model for new sessions
- each session may override that default
- `/model` changes the current session model only

### 2) Add an effective model resolver

Add a helper in runtime/session code (or shared helper):

- `getSessionModel(sessionId)` / `effectiveModelForSession(sessionId)`

It should return:

- `session.model` if present
- otherwise `resolveModel(loadConfig().model)` as fallback

Use this helper in:

- `processPrompt()`
- `runAgentLoop()`
- `reloadSystemPromptForSession()`
- `runHandoff()` (for compact model based on the session's active model)

### 3) Change `/model` semantics

Current `/model` mutates global config. Proposed:

- `/model` with no args: show current session model (effective model)
- `/model <name>`: set current session model only

Optional follow-up (recommended for clarity):

- `/model --global <name>` or `/default-model <name>` to update `config.model`

This keeps "default for future sessions" separate from "current tab override".

### 4) Session creation and fork behavior

Session creation:

- new sessions should initialize `session.model` from current global default (`config.model`)

Fork:

- forked sessions should inherit the source session model, not the global default
	- `src/runtime/handle-command.ts:99`
	- `src/runtime/handle-command.ts:110`

This matches user expectation when comparing models or branching a conversation.

### 5) UI/event payloads (optional but useful)

`SessionInfo` events can carry the model so CLI/Web can display per-tab model labels.

If adding model to session events, update the `publishSessions()` dedupe key too, or model-only changes may not emit a new sessions event.

- `src/runtime/event-publisher.ts:135`
- `src/runtime/event-publisher.ts:141`

CLI currently tracks context status metadata per tab, but not model metadata.

- `src/cli/client.ts:591`

This is not required for correctness, only for visibility.

## Important Hidden Risk: OpenAI Provider Concurrency

Per-tab model support is feasible, but "competing models in one process" also depends on provider concurrency safety.

The OpenAI provider currently uses shared module-level mutable state:

- `streamState` global
	- `src/providers/openai.ts:231`
- `currentSessionId` global
	- `src/providers/openai.ts:232`
- both are mutated per request in `buildRequestBody()`
	- `src/providers/openai.ts:266`
	- `src/providers/openai.ts:267`
	- `src/providers/openai.ts:268`
- `currentSessionId` is later read in `fetch()` headers
	- `src/providers/openai.ts:241`
	- `src/providers/openai.ts:256`
- `streamState` is read during `parseSSE()`
	- `src/providers/openai.ts:301`

Providers are registered as singletons:

- `src/provider.ts:167`
- `src/provider.ts:173`
- `main.ts:22`
- `main.ts:34`

### Why this matters

Two concurrent OpenAI sessions can overwrite each other's stream parsing state or session header context.

This is separate from per-session model selection, but it becomes much more visible once multi-model comparisons are encouraged.

### Recommended fix (same project, separate step)

Make OpenAI stream parsing/request context request-scoped, not module-scoped.

Options:

- preferred: create a per-request parser state object and thread it through streaming functions
- acceptable: create per-request provider instances (less ideal if provider state is mostly stateless)

The first option is cleaner and keeps provider registration simple.

## Complexity Estimate

### Scope A: Per-session model/provider support (no UI polish)

Estimate: 0.5 to 1.5 days

Includes:

- session metadata schema change (`SessionInfo.model`)
- runtime plumbing to use effective per-session model
- `/model` command semantics change
- fork inheritance
- handoff compact model based on session model
- migration/backfill behavior for existing session registry entries
- tests updates/additions

### Scope B: UI surfacing (CLI/Web show per-tab model)

Estimate: 0.25 to 0.5 day

Includes:

- session event payload + dedupe key update
- CLI tab metadata display (optional)
- web status display (optional)

### Scope C: OpenAI concurrency safety for true side-by-side comparisons

Estimate: 0.5 to 1.5 days

Includes:

- removing module-global request/stream state from `src/providers/openai.ts`
- tests for concurrent OpenAI sessions (or at minimum a regression harness)

## Suggested Implementation Order

### Phase 1 (fix correctness / user expectation)

- make `/model` session-scoped
- persist `session.model`
- use session model in prompt execution and system prompt loading
- use session model for handoff compact model

This solves the "changing one tab changes others" problem.

### Phase 2 (visibility)

- include model in session events
- show per-tab model in CLI/web (if desired)

### Phase 3 (robust concurrent comparisons)

- refactor OpenAI provider stream/request state to be request-scoped

This is the step that makes "run competing models in one process" reliable for OpenAI sessions.

## Test Plan (Recommended)

- `/model` in tab A does not change tab B
- new tab gets default model unless overridden
- `/fork` inherits source session model
- session model persists across restart
- `SYSTEM.md` / `AGENTS.md` model-tag prompt reload changes when session model changes
- `/handoff` uses compact model derived from the session's model
- concurrent OpenAI sessions do not cross-wire stream output (Phase 3)

## Bottom Line

This is a good change and not huge, but it is not "just a command tweak".

The per-session model part is moderate. The OpenAI concurrency cleanup is the main hidden work if the goal is reliable side-by-side comparisons inside one process.
