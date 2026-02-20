# Session & Context Management

## Session Persistence

Sessions are stored per session id under `state/sessions/<sessionId>/`:

- `session.ason` -- current message history + token totals
- `session-previous.ason` -- previous full history after `/handoff`
- `handoff.md` -- handoff summary markdown
- `prompts.ason` -- append-only user prompt log

Registry metadata lives in `state/sessions/index.ason`.

Core logic: `src/session.ts`.

## Session Lifecycle

- Startup loads/repairs `index.ason`; if missing/empty, creates `s-default`.
- Runtime tracks session metadata in memory and persists registry updates.
- Session content is saved after each turn in `runAgentLoop(...)`.
- `/reset` clears `session.ason` for that session and drops in-memory cache.
- `/close` removes session from registry/cache and emits updated session snapshot.
- `/cd` updates `workingDir` for the session and reloads system prompt context.

## Handoff Behavior

`/handoff` currently:

1. generates summary with compact model
2. writes `handoff.md`
3. rotates `session.ason` -> `session-previous.ason`
4. clears runtime cache for that session

Important: blue currently does **not** auto-inject `handoff.md` back into the next prompt path. `loadHandoff(...)` exists in `src/session.ts` but is not wired into normal restore flow.

## Context Tracking

- Max context is fixed at `200_000` tokens in `src/context.ts` (`MAX_CONTEXT`).
- Usage from provider responses is reported after turns.
- Runtime warns when context exceeds ~80% (`shouldWarn(...)`).
- Estimated context at startup uses calibrated bytes->tokens ratio.

## Token Calibration

Calibration file: `state/calibration.ason`.

- On first usable usage report, runtime stores bytes->tokens ratio.
- Later token estimates use that ratio (`estimateTokensSync(...)`).
- Fallback ratio is `4` bytes/token.

## Multiplexing Model

- Commands/events are session-scoped (`sessionId` on protocol objects).
- Scheduler runs one command at a time per session, with bounded cross-session parallelism.
- Active session and busy session set are published through IPC status/events.

## CLI vs Web Session UX

- CLI client has tab/session management behavior.
- Web UI in blue is currently a simpler single-stream UI (no tab strip), though commands still carry `sessionId` and backend multiplexing remains session-aware.

## State Directory Summary

Default root is `state/` (override with `HAL_STATE_DIR`).

Typical files:

- `state/ipc/*` -- owner lock, command/event logs, state snapshot
- `state/sessions/index.ason` -- registry
- `state/sessions/<sessionId>/*` -- per-session files listed above
- `state/calibration.ason` -- token calibration
- `state/tool-calls.ason` -- optional tool-call log (when `config.debug.toolCalls = true`)

Path constants are defined in `src/state.ts`.
