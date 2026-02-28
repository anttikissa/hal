# Session & Context Management

## Session Persistence

Sessions are stored per session id under `state/sessions/<sessionId>/`:

- `session.asonl` -- full message history sent to the model (one message per line, ASONL format). Used for API context. Replaced on `/handoff`, cleared on `/reset`.
- `conversation.asonl` -- append-only human-readable event log (user text, assistant text, model changes, cd, topic, fork, handoff, reset). Used for TUI replay on restart and input history. Never truncated.
- `session-previous.asonl` -- previous full history after `/handoff`
- `handoff.md` -- handoff summary markdown (consumed on next session load)
- `info.ason` -- per-session metadata (workingDir, model, topic, lastPrompt, tokenTotals)

Registry metadata lives in `state/sessions/index.ason`.

Core logic: `src/session.ts`.
## Session Lifecycle

- Startup loads/repairs `index.ason`; if missing/empty, creates `s-default`.
- Runtime tracks session metadata in memory and persists registry updates.
- Session content is saved after each turn in `runAgentLoop(...)`.
- CLI hydrates each tab transcript directly from `conversation.asonl` on startup (including `/restore`), so history survives owner changes and full app restarts. Only events after the last `/reset` or `/handoff` are replayed (`replayConversationEvents()` in `src/session.ts`).
- `/reset` clears `session.asonl` for that session and drops in-memory cache.
- `/close` removes session from registry/cache and emits updated session snapshot.
- `/cd` updates `workingDir` for the session and reloads system prompt context.
- `/fork` copies `session.asonl` and `conversation.asonl` to a new session.
- Auto-topic: after the first assistant response, runtime generates a short topic.
## Handoff Behavior

`/handoff` currently:

1. generates summary with compact model
2. writes `handoff.md`
3. rotates `session.asonl` -> `session-previous.asonl`
4. clears runtime cache for that session
5. publishes estimated context for the fresh session

On next session load, `getOrLoadSessionRuntime(...)` calls `loadHandoff(...)` which reads `handoff.md`, injects it as a `[handoff]` user message, and renames the file to `handoff-previous.md`.

## Context Tracking

- Max context is fixed at `200_000` tokens in `src/context.ts` (`MAX_CONTEXT`).
- Usage from provider responses is reported after turns.
- Runtime warns when context exceeds ~66% (`shouldWarn(...)`).
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
- Web UI is a simpler single-stream UI (no tab strip), though commands still carry `sessionId` and backend multiplexing remains session-aware.

## State Directory Summary

Default root is `state/` (override with `HAL_STATE_DIR`).

Typical files:

- `state/ipc/*` -- owner lock, command/event logs, state snapshot
- `state/sessions/index.ason` -- registry
- `state/sessions/<sessionId>/*` -- per-session files listed above
- `state/calibration.ason` -- token calibration
- `state/tool-calls.asonl` -- optional tool-call log (when `config.debug.toolCalls = true`)

Path constants are defined in `src/state.ts`.
