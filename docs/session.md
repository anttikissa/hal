# Session & Context Management

## Session Persistence

Sessions are stored per session id under `state/sessions/<sessionId>/`:

- `session.asonl` -- lean message spine with block refs (append-only ASONL). Large content (thinking, tool calls) is replaced with refs to block files.
- `session.N.asonl` -- rotated archives (N=1 oldest, higher=more recent). Created by `/handoff` or `/reset`.
- `blocks/` -- external content blocks (thinking text + signatures, tool call inputs + results). One `.ason` file per block ref. Shared across all rotations.
- `conversation.asonl` -- append-only event log for TUI replay on restart and input history. Never truncated.
- `info.ason` -- per-session metadata (workingDir, model, topic, lastPrompt, tokenTotals)
- `draft.txt` -- unsent prompt text

Registry metadata lives in `state/sessions/index.ason`.

Core logic: `src/session.ts`.

### conversation.asonl event types

| type | fields | description |
|------|--------|-------------|
| `user` | `text`, `ts` | User prompt |
| `assistant` | `text`, `thinking?`, `ts` | Assistant text response (one per agent-loop turn; tool-only turns are skipped) |
| `tool` | `text`, `ts` | Tool execution output (one event per tool-loop iteration, lines joined with `\n`) |
| `model` | `from`, `to`, `ts` | Model change (`/model`) |
| `cd` | `from`, `to`, `ts` | Working directory change (`/cd`) |
| `topic` | `from?`, `to`, `auto?`, `ts` | Topic change (manual or auto-generated) |
| `fork` | `parent`, `child`, `ts` | Fork event (written to both parent and child) |
| `handoff` | `ts` | Context rotation with prompt injection |
| `reset` | `ts` | Clean slate rotation |
| `start` | `workingDir`, `ts` | Session creation |

On restart, `replayConversationEvents()` replays `user`, `assistant`, and `tool` events after the last `reset`/`handoff`. Consecutive `assistant` events (from multi-turn tool loops) are merged. `tool` events are rendered as `<tool>` lines in the TUI.

## Block Storage (v2)

Large content is stored in `blocks/` as individual `.ason` files:

- **Thinking blocks**: `{ thinking: '...full text...', signature: '...base64...' }` — preserves cache hit on restore.
- **Tool calls**: `{ call: { name, input }, result: { content } }` — call and result in one file.

Block refs in `session.asonl` look like `1709123456789-a3b2c1` (timestamp + random hex).

The session.asonl spine stays human-readable — you can see message roles, tool names, and text content inline. Only thinking and tool I/O moves to block files.

## Session Lifecycle

- Startup loads/repairs `index.ason`; if missing/empty, creates `s-default`.
- Runtime tracks session metadata in memory and persists registry updates.
- Session content is **appended** after each turn in `runAgentLoop(...)`. The runtime tracks `persistedCount` to know which messages are already on disk.
- Runtime replays `conversation.asonl` for the active startup session as prompt/chunk events. CLI also hydrates each tab transcript directly from `conversation.asonl` (including `/restore`), so history survives owner changes and full app restarts. Only events after the last `/reset` or `/handoff` are replayed (`replayConversationEvents()` in `src/session.ts`).
- `/reset` rotates `session.asonl` → `session.N.asonl` (no deletion) and clears in-memory cache.
- `/close` removes session from registry/cache and emits updated session snapshot.
- `/cd` updates `workingDir` for the session and reloads system prompt context.
- `/fork` copies `session.asonl`, `conversation.asonl`, and `blocks/` directory to a new session.
- Auto-topic: after the first assistant response, runtime generates a short topic.

## Rotation (replaces handoff)

`/handoff` and `/reset` both rotate the session — no LLM summarization.

**Rotation**:
1. Save any unsaved messages to `session.asonl`
2. Rename `session.asonl` → `session.N.asonl` (N = highest existing + 1)
3. Clear runtime cache

**Handoff** additionally injects a deterministic context message with the first 10 + last 10 user prompts from the previous session (`buildRotationContext()`).

**Reset** rotates without context injection — clean slate.

Properties:
- **Instant** — no LLM call
- **Free** — no API cost
- **Deterministic** — same input always produces same rotation

Naming: `session.1.asonl` (first archive), `session.2.asonl` (second), etc. Higher N = more recent. `session.asonl` is always current.

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

## Timestamps

When `timestamps: true` is set in `config.ason`, line and prompt events display a `HH:MM` timestamp prefix in the TUI. Chunk events (streaming) do not get timestamps.

## State Directory Summary

Default root is `state/` (override with `HAL_STATE_DIR`).

Typical files:

- `state/ipc/*` -- owner lock, command/event logs, state snapshot
- `state/sessions/index.ason` -- registry
- `state/sessions/<sessionId>/*` -- per-session files listed above
- `state/calibration.ason` -- token calibration
- `state/tool-calls.asonl` -- optional tool-call log (when `config.debug.toolCalls = true`)

Path constants are defined in `src/state.ts`.
