# Pause before local tools plan

Goal: make "pause" stop a running turn at the next **local tool execution boundary**, while surviving Hal/runtime/client restarts once that boundary has been reached.

This is not exact provider stream resume. Before the boundary, the provider request is still live and cannot be reconstructed after process death. After the boundary, the assistant message and complete tool-call batch are durable, and `continue` runs those tools before asking the model for the next iteration.

## Current state

Relevant files today:

- `src/client/cli.ts`
  - Up-arrow while working enters prompt edit and sends `abort` in `beginPreviousPromptEdit()`.
  - Down-arrow in prompt-edit sends `continue` in `continueAfterPromptEdit()`.
  - Escape sends `abort`.
- `src/server/runtime.ts`
  - `dispatchPromptCommand()` aborts a working turn before steering.
  - `continue` currently aborts any working turn, clears queue hold, then calls `runGeneration(sessionId, '')`.
  - `runGeneration()` appends user text if any, builds provider messages with `apiMessages.toProviderMessages()`, then calls `agentLoop.runAgentLoop()`.
- `src/runtime/agent-loop.ts`
  - Streams provider events.
  - Persists assistant/thinking/tool_call entries before executing tools.
  - Executes all tool calls via `executeToolsConcurrently()`.
  - Appends `turn_end` for completed/failed/aborted, but max-iteration pause intentionally returns `paused` without `turn_end`.
- `src/session/api-messages.ts`
  - Converts flat history into provider messages.
  - `repairToolPairing()` injects `[interrupted]` for unmatched tool calls. This is correct for interrupted/corrupt history, but wrong for deliberate pending tools.
- `src/server/sessions.ts`
  - Defines `HistoryEntry` and allowed serialized keys.
  - Appends `history.asonl` records.
  - Stores live uncommitted streaming UI blocks in `live.ason`.
- `src/cli/block-data.ts`, `src/client/continuation.ts`, `src/client/render-status.ts`
  - Project durable history into visible blocks and decide whether Enter can continue.
- `src/server/queue-runner.ts`, `src/runtime/prompt-queue.ts`
  - Hold/drain queued prompts after generation results.

## Durable session-file semantics to document

There is partial documentation in `docs/ason.md`, `docs/plan-3-session.md`, and `docs/rebase-plan.md`, but there is no current reference document for session file semantics and restart survival.

Add `docs/session-files.md` before or during this feature. It should describe:

- `state/sessions/<id>/session.ason`
  - durable session metadata: id, cwd, model, tab/name/closed state, current history log, context estimate.
- `state/sessions/<id>/history*.asonl`
  - append-only logical conversation history.
  - ASONL: one short ASON record per line.
  - Flat UI-friendly entries are replayed into provider messages by `src/session/api-messages.ts`.
  - Forks can inherit parent history; blob ownership follows history origin.
- `state/sessions/<id>/live.ason`
  - restart-tolerant UI snapshot for uncommitted streaming blocks.
  - Not authoritative provider context.
  - Cleared when streamed content is committed into `history.asonl`.
- `state/sessions/<id>/blobs/*.ason`
  - large thinking/tool-call/tool-result/error payloads referenced from history/live blocks.
- `state/ipc/*.ason*`
  - commands/events/shared tab state for process coordination, not conversation truth.
- Restart invariant:
  - provider context is rebuilt from `history*.asonl`, not `live.ason`.
  - any restart-surviving semantic state must be represented in history/meta, not only memory or live UI.

Document the new pending-tools marker there too.

## New history state

Add an explicit durable marker instead of inferring from dangling tool calls.

Suggested entry shape:

```ts
{ type: 'pending_tools', toolIds: string[], cwd: string, model?: string, usage?: PartialTokenUsage, reason?: 'soft-pause', ts?: string }
```

Semantics:

- Appears immediately after the full assistant/tool_call batch it protects.
- Means: all listed local tool calls are intentionally not executed yet.
- Holds the agent turn open; it is continuable.
- Must be removed or canceled once pending tools are executed.
- Must not be fed to providers as text.
- Must not be treated like an interrupted tool batch.

Why not `turn_end status:'paused'`?

- A `turn_end` normally means the model turn is semantically closed.
- Pending tools means the turn is still inside the tool-call cycle.
- A dedicated marker is easier to find and cancel, and avoids expanding `TurnEndStatus` semantics unless we later want a broader paused-turn model.

Cancellation after continue:

- Keep history append-only: when pending tools are resumed, mark the `pending_tools` entry `canceled: true` using existing history rewrite support, or append a paired marker such as `{ type: 'pending_tools_resolved', pendingId }`.
- Prefer `canceled: true` if existing rewrite machinery can do it simply and safely.
- If avoiding rewrite is important, use a resolved marker and make readers treat the latest unresolved marker as active.

Implementation note: because `history.asonl` is append-only for normal writes, a resolved marker may be safer and smaller than rewriting. The plan below assumes a helper hides that choice.

## Architecture changes

### 1. Separate hard abort from soft pause request

Add a session-level in-memory request in `agentLoop.state`, for example:

```ts
pauseBeforeTools: new Set<string>()
```

Add exported helpers:

- `requestPauseBeforeTools(sessionId: string): boolean`
  - Returns false if no turn is working.
  - Does not abort the provider request.
- `clearPauseBeforeTools(sessionId: string): void`
- `hasPauseBeforeTools(sessionId: string): boolean`

Keep existing `abort()` for hard stop/amend/steering/tab-close.

### 2. Persist pending tools at the boundary

In `src/runtime/agent-loop.ts`, after the assistant/thinking/tool_call history entries are appended and before `executeToolsConcurrently()`:

1. If `pauseBeforeTools` is requested and `toolCalls.length > 0`:
   - append `pending_tools` marker with all tool IDs, current cwd, model, and accumulated usage from the provider call if available;
   - clear `live.ason` exactly as the normal tool-call path does;
   - emit a user-visible info/log such as `[paused before tools]`;
   - emit `stream-end` with context/usage;
   - update session context metadata;
   - return `paused`;
   - do **not** execute any tool.
2. If no tools arrive, let the turn complete normally. The user's pause request becomes a no-op except for possibly showing transient status.

Invariant to comment near this branch:

> Pending-tools pause is all-or-nothing for the batch. Once any local tool starts, this feature must not call itself a clean pause before tools.

### 3. Resume pending tools before provider message rebuild

`src/server/runtime.ts` needs a preflight before normal `runGeneration()` does `apiMessages.toProviderMessages()`.

Add helper flow:

```ts
async function continuePendingTools(sessionId: string): Promise<boolean>
```

Behavior:

1. Load active unresolved `pending_tools` marker from history.
2. If none, return false.
3. Resolve the referenced `tool_call` entries and their blobs/inputs.
4. Execute the full pending batch using the marker's persisted cwd.
5. Append `tool_result` history entries and update tool blobs exactly like normal agent-loop tool execution.
6. Mark the pending marker resolved/canceled.
7. Start the next model iteration with `runGeneration(sessionId, '')`, but only after tool results exist.
8. Return true.

The `continue` command should call this before normal `runGeneration()`. It must not call `apiMessages.toProviderMessages()` while a pending marker is unresolved, otherwise `repairToolPairing()` can inject `[interrupted]`.

Implementation detail: `executeToolsConcurrently()` is currently private inside `agent-loop.ts`. Options:

- Minimal extraction inside the same file: export `agentLoop.executeToolBatch(...)` through the namespace object.
- Or move the tool-batch function to a new small module only if there are now two real callers.

Given the module-size pressure on `agent-loop.ts`, a new focused module may be acceptable if it truly owns tool execution and blob/result history writing. Otherwise keep changes local.

### 4. Teach history readers about pending tools

Files:

- `src/server/sessions.ts`
  - Extend `HistoryEntry` union and `historyTopLevelKeys` for `pending_tools` fields.
  - Add helper(s), for example:
    - `findPendingTools(sessionId): PendingToolsState | null`
    - `resolvePendingTools(sessionId, pendingId): void`
  - This helper must distinguish deliberate pending tools from crash/interruption.
- `src/session/api-messages.ts`
  - Ignore `pending_tools` and resolved markers for provider output.
  - Add a guard: if unresolved `pending_tools` exists in entries passed to `toProviderMessages()`, either omit repair past that point or throw a clear internal error. Prefer throwing in normal runtime paths so tests catch accidental misuse.
  - Keep `repairToolPairing()` behavior for genuine unmatched tool calls without a pending marker.
- `src/cli/block-data.ts`
  - Render unresolved marker as a log/info block like `[paused before tools]` if the agent-loop info entry is not separately appended.
  - Avoid double-rendering if both a marker and explicit log exist; choose one source of truth.
- `src/client/continuation.ts`
  - Treat unresolved pending-tools state as `continue`.
- `src/client/render-status.ts`
  - Show paused tab indicator for pending tools.

### 5. Queue and command semantics

Files:

- `src/server/runtime.ts`
  - `continue` path:
    - If session is working and only soft-pause requested, do not hard-abort.
    - If unresolved pending tools exist, execute them before normal generation.
  - `dispatchPromptCommand()` and prompt-amend path:
    - Steering/amend must still hard-abort or cancel the old turn. Soft pause is not a replacement for steering.
    - If there are unresolved pending tools and the user sends a new prompt, define policy explicitly. Recommended: cancel pending marker and append the new prompt, because steering means abandoning the paused tool cycle.
- `src/server/queue-runner.ts`
  - Treat `AgentLoopResult === 'paused'` from pending tools like max-iteration pause: hold queue and emit a queue-paused notice.
  - `shouldDrainQueuedPrompt()` must not drain while unresolved pending tools exist.
- `src/runtime/prompt-queue.ts`
  - Likely no structural change; maybe tests only.

### 6. Client key behavior

Files:

- `src/client/cli.ts`
  - Do not overload the existing up-arrow prompt-edit path blindly.
  - Current up-arrow means "edit just-sent prompt" and sends hard abort. That semantic is valuable.
  - Possible UI choices:
    1. Escape = request soft pause before tools; up-arrow remains hard-abort/edit.
    2. Up-arrow first requests soft pause, then entering edit mode hard-aborts if user changes/submits. This is riskier and more code.
    3. Add a separate key/command first, e.g. `/pause` or Ctrl-S, then later reconsider up-arrow.

Recommended first implementation:

- Add a slash/runtime command or explicit client command for soft pause, e.g. `/pause` or `ctrl-s` if available.
- Keep up-arrow prompt-edit semantics unchanged until the durable path is proven.
- Later, optionally make up-arrow request soft pause only when the user is just trying to pause output, not edit.

Files for command wiring:

- `src/protocol.ts` — add command type, probably `pause-before-tools` or `pause` with mode field.
- `src/client/commands.ts` — construct/send command.
- `src/runtime/commands.ts` — slash command help and parsing if exposed as `/pause`.
- `src/cli/key-help.ts`, `src/cli/help-bar.ts` — update visible help only after key semantics are chosen.

### 7. Tool confirmations and dangerous tools

Files:

- `src/tools/risk.ts`, `src/tools/tool.ts`, `src/runtime/agent-loop.ts`, `src/server/runtime.ts`

Requirement:

- Pending dangerous tools must still request confirmation when resumed.
- Confirmation state must not be ephemeral from before restart.
- Tool confirmation requests should be generated during pending-tool execution, not when the marker is created.

This probably falls out naturally if resume uses the same tool execution path as normal.

### 8. Provider-side tools

Document explicitly:

- Pause-before-tools only covers Hal-local tools emitted as `tool_call` events.
- Provider-side tools such as hosted web search may already have run inside the provider stream.
- UI should say "paused before local tools", not "paused before tools" if ambiguity becomes user-visible.

## Exact file change list

Core runtime/session:

- `src/protocol.ts`
  - Add command type/interface for soft pause.
  - Possibly add event/status text only if existing `info`/`stream-end` is insufficient.
- `src/runtime/agent-loop.ts`
  - Add pause request state and exported namespace functions.
  - Branch before `executeToolsConcurrently()` to persist pending marker and return `paused`.
  - Expose or extract pending tool execution helper.
  - Comment all-or-nothing batch invariant.
- `src/server/runtime.ts`
  - Handle new command.
  - Continue pending tools before `apiMessages.toProviderMessages()`.
  - Preserve hard-abort semantics for steering/amend/close.
  - Queue hold/drain integration.
- `src/server/sessions.ts`
  - Add `HistoryEntry` type for pending marker/resolution.
  - Add serialized keys.
  - Add pending marker lookup/resolution helper.
  - Possibly add append helper that writes assistant/tool_call/pending marker in one `appendHistory()` call.
- `src/session/api-messages.ts`
  - Ignore pending marker in provider messages.
  - Guard unresolved pending markers from accidental normal replay.
  - Keep `[interrupted]` repair for non-pending unmatched tools.

UI/continuation:

- `src/client/cli.ts`
  - Wire chosen key only if adding a key.
  - Keep prompt-edit hard-abort behavior distinct.
- `src/client/commands.ts`
  - Construct new command if client sends it directly.
- `src/runtime/commands.ts`
  - Add `/pause` command/help if exposed as slash command.
- `src/client/continuation.ts`
  - `continue` action for pending-tools marker/log.
- `src/client/render-status.ts`
  - Paused indicator for pending tools.
- `src/cli/block-data.ts`
  - Render pending state if marker is the UI source.
- `src/cli/key-help.ts`, `src/cli/help-bar.ts`
  - Update only after UX is final.

Tests:

- `src/runtime/agent-loop.test.ts`
  - Soft pause requested + tool calls: assistant/tool_call/pending marker persisted; no tool_result; result `paused`.
  - Soft pause requested + no tool calls: normal completion.
  - Pause request after tools have started does not claim clean pending state.
- `src/server/runtime.test.ts`
  - `continue` with unresolved pending tools executes real tools before model replay.
  - `continue` does not call `toProviderMessages()` first; test by ensuring no `[interrupted]` is seen.
  - Queue stays held while pending tools exist.
  - Steering prompt cancels or resolves pending state according to chosen policy.
- `src/session/api-messages.test.ts`
  - Unmatched tool call without pending marker still repairs to `[interrupted]`.
  - Unresolved pending marker causes guard/skip behavior as designed.
  - Resolved pending marker is ignored.
- `src/server/sessions.test.ts`
  - Pending marker serialization, lookup, resolution, restart-style reload.
  - Fork/history origin behavior if pending markers can exist in inherited history.
- `src/cli/block-data.test.ts`
  - Pending marker renders as continuable pause notice if marker drives UI.
- `src/client/continuation.test.ts`
  - Pending-tools pause can continue.
- `src/client/cli.test.ts`
  - Soft pause key/command does not hard-abort.
  - Up-arrow prompt edit still hard-aborts if unchanged.
- `src/client/render-status.test.ts`
  - Pending-tools history shows paused marker on tab.

Docs:

- `docs/session-files.md`
  - New reference doc for restart-surviving state.
- `docs/pause-before-tools-plan.md`
  - This plan; update if implementation choices change.
- Maybe `docs/terminal.md`
  - Only if key/help/rendering changes affect terminal rules. Probably not needed.

## Code comments to add

Add comments at the trust boundaries, not everywhere:

1. `agent-loop.ts`, before pending branch:
   - why pause happens only after full provider tool-call batch is received;
   - why no local tool may start before marker is written;
   - why crash before this point cannot be resumed exactly.
2. `server/runtime.ts`, before continue-pending preflight:
   - must execute pending tools before provider-message rebuild to avoid `repairToolPairing()` injecting `[interrupted]`.
3. `api-messages.ts`, near `repairToolPairing()`:
   - unmatched tool calls mean interrupted/corrupt history **unless** a pending-tools marker is active;
   - normal callers must not replay unresolved pending markers.
4. `sessions.ts`, near pending marker helper:
   - marker is explicit durable state, not inferred from missing tool results.
5. Tests names should encode the invariants: "pending tools execute before provider replay", "pause before all tools in batch", "unmatched non-pending tool calls still repair".

## Restart and crash matrix

| Point of failure | Durable result | Resume behavior |
| --- | --- | --- |
| Before user requests soft pause | Existing behavior | No special resume |
| After request, before provider reaches local tool calls | No durable pending marker | Exact resume impossible; restart sees last committed history/live only |
| While appending assistant/tool_call/pending marker | ASONL append may contain complete prefix only | If marker missing, treat as interruption; if marker present, continue pending tools |
| After pending marker, before any local tool starts | Clean pending-tools state | Continue executes full batch |
| During pending tool execution after resume | Some tool_result entries may exist | This is no longer a clean pause; normal repair/interruption rules apply unless we add batch transaction handling |
| After all tool results append, before next model call | Normal tool-result history | Continue/restart asks model next iteration |

Optional future hardening: add a second marker `running_pending_tools` during resume if we need to distinguish crash-mid-resume from older corruption. Not required for the first version unless tests reveal ambiguity.

## Rollout recommendation

1. First add `docs/session-files.md` and pending marker tests.
2. Implement marker type/helpers in `sessions.ts`.
3. Add `api-messages.ts` guard so wrong replay fails fast.
4. Add agent-loop soft-pause branch.
5. Add runtime continue-pending path.
6. Add a slash command `/pause` before changing arrow-up behavior.
7. Once durable semantics are proven, revisit arrow-up/down UX.

This keeps the feature contained and avoids changing the existing prompt-edit contract while the hard restart-safety invariants are being built.
