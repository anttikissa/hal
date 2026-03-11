# Session & Context Management

## Session Persistence

Sessions are stored per session id under `state/sessions/<sessionId>/`:

- `historyN.asonl` -- rotated archives (N=1 oldest, higher=more recent). Created by `/compact` or `/reset`.
- `blobs/` -- external payload blobs (thinking text + signatures, tool call inputs + results, pasted images). One `.ason` file per blob id. Shared across all rotations and resolved across fork ancestry.
- `history.asonl` -- unified append-only message log (API messages + conversation events). Never truncated.
- `session.ason` -- per-session metadata (workingDir, model, topic, lastPrompt, tokenTotals)
- `draft.txt` -- unsent prompt text

Registry metadata lives in `state/sessions/index.ason`.

Core logic: `src/session/session.ts`.

### history.asonl event types

| type | fields | description |
|------|--------|-------------|
| `user` | `text`, `ts` | User prompt |
| `assistant` | `text`, `thinking?`, `thinkingSignature?`, `ts` | Assistant text response (one per agent-loop turn; tool-only turns are skipped) |
| `tool` | `text`, `ts` | Tool execution output (one event per tool-loop iteration, lines joined with `\n`) |
| `model` | `from`, `to`, `ts` | Model change (`/model`) |
| `cd` | `from`, `to`, `ts` | Working directory change (`/cd`) |
| `topic` | `from?`, `to`, `auto?`, `ts` | Topic change (manual or auto-generated) |
| `fork` | `parent`, `child`, `ts` | Fork event (written to both parent and child) |
| `compact` | `ts` | Context compaction with prompt injection |
| `reset` | `ts` | Clean slate rotation |
| `start` | `workingDir`, `ts` | Session creation |

On restart, `replayConversationEvents()` replays `user`, `assistant`, and `tool` events after the last `reset`/`compact`. Consecutive `assistant` events (from multi-turn tool loops) are merged. `tool` events are rendered as `<tool>` lines in the TUI.

## Blob Storage

Large payloads are stored in `blobs/` as individual `.ason` files:

- **Thinking blobs**: `{ thinking: '...full text...', signature: '...base64...' }` — signature is required to send thinking back to the Anthropic API.
- **Tool blobs**: `{ call: { name, input }, result: { content, status? } }` — call and result in one file.
- **Image blobs**: `{ media_type, data }` — pasted or attached images stored out of line from the message log.

Blob ids in `history.asonl` are short stable ids like `1709123456789-a3b2c1` (timestamp + random suffix).

The `history.asonl` spine stays human-readable — you can see message roles, tool names, text content, and blob ids inline. Only heavy payloads move into blob files.

## Context Compaction

API messages are compacted before sending to strip old heavy content (tool results, images, thinking). This prevents quadratic token cost growth. See `docs/context-compaction.md` for details.

## Session Lifecycle

- Startup loads/repairs `index.ason`; if missing/empty, creates `s-default`.
- Runtime tracks session metadata in memory and persists registry updates.
- Session content is **appended** after each turn in `runAgentLoop(...)`. The runtime tracks `persistedCount` to know which messages are already on disk.
- Runtime replays `history.asonl` for the active startup session as prompt/chunk events. CLI also hydrates each tab transcript directly from `history.asonl` (including `/restore`), so history survives owner changes and full app restarts. Only events after the last `/reset` or `/compact` are replayed (`replayConversationEvents()` in `src/session/session.ts`).
- `/reset` rotates `history.asonl` → `historyN.asonl` (no deletion) and clears in-memory cache.
- `/close` removes session from registry/cache and emits updated session snapshot.
- `/cd` updates `workingDir` for the session and reloads system prompt context.
- `/fork` keeps using the parent session's blob ids through ancestry-aware lookup. New blobs created in the child go to the child's `blobs/` directory.
- Auto-topic: after the first assistant response, runtime generates a short topic.

## Rotation

`/compact` and `/reset` both rotate the session.

**Rotation**:
1. Save any unsaved messages to `history.asonl`
2. Rename `history.asonl` → `historyN.asonl` (N = highest existing + 1)
3. Clear runtime cache

**Compact** additionally injects a deterministic context message with the first 10 + last 10 user prompts from the previous session (`buildRotationContext()`). Triggers automatically when context reaches 70% of model limit.

**Reset** rotates without context injection — clean slate.

Properties:
- **Instant** — no LLM call
- **Free** — no API cost
- **Deterministic** — same input always produces same rotation

Naming: `history1.asonl` (first archive), `history2.asonl` (second), etc. Higher N = more recent. `history.asonl` is always current.

## Context Tracking

- Max context is defined per model in `src/runtime/context.ts` (typically `200_000` tokens).
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
