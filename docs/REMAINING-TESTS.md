# Remaining Tests Plan (last 24h commit batch)

This is a carry-forward plan for tests that are still missing after the recent churn.

## Current baseline

Already verified in this session:

- `bun run test:quick` ✅
- `bun test` ✅ (`308 pass`, `2 todo`, `0 fail`)

Existing tests already cover:

- ASON parser/stringifier and stream behavior
- Hashline edit helpers
- Draft file persistence helpers (`saveDraft` / `loadDraft`)
- Command scheduler pause/resume internals
- Basic e2e flows: startup, `/model`, `/system`, `/cd`, `/reset`, `/queue`, `/drop`, `/handoff`(empty), `/fork`
- Keyboard fixture normalization + linkification behavior

## What still needs tests

## P0 — must add (highest risk)

### 1) Fork + session lifecycle regressions (e2e)

Changed code: `src/runtime/handle-command.ts`, `src/runtime/sessions.ts`, `src/protocol.ts`, `src/tests/fork.test.ts`

Add to `src/tests/fork.test.ts`:

- [ ] **Fork while busy marks child paused**
	- Start streaming (`/model mock`, prompt `song`), fork mid-stream.
	- Assert status event includes child ID in `pausedSessionIds`.
	- Assert child receives `[fork] forked from <parent> (paused)` (`level: fork`).

- [ ] **Fork inserts tab/session next to parent**
	- With >=2 sessions, fork middle session.
	- Assert child index is `parentIndex + 1` in `sessions` payload order.

- [ ] **Fork writes lineage events to conversation logs**
	- After fork, parse both sessions’ `conversation.ason`.
	- Assert both contain `{ type: 'fork', parent, child, ts }`.

- [ ] **Busy-parent fork snapshots partial assistant blocks**
	- Fork mid-stream.
	- Assert child `session.ason` contains assistant content (partial snapshot), not empty.

### 2) `/topic` + `/title` rename behavior (e2e)

Changed code: `src/cli/commands.ts`, `src/runtime/handle-command.ts`, `src/session.ts`, `src/protocol.ts`

Add to `src/tests/commands.test.ts` (or new `src/tests/topic.test.ts`):

- [ ] **`/topic <text>` persists and echoes**
	- Assert `[topic] <text>` meta line.
	- Assert later `/topic` returns that value.

- [ ] **`/topic` with no existing topic returns `(none)`**
	- Assert info line is `[topic] (none)`.

- [ ] **`/title` no longer a command**
	- Assert unknown-command warning path for `/title ...`.

### 3) Queue/pause edge cases introduced by busy-state changes (e2e)

Changed code: `src/runtime/process-command.ts`, `src/cli/client.ts`, `src/cli/tui.ts`

Add to `src/tests/queue.test.ts` (extend):

- [ ] **Paused session accumulates queue; `/queue` lists entries in order**
	- Pause session, send 2 prompts, assert numbered queue lines (`1.`, `2.`).

- [ ] **`/drop` fails queued commands + unpauses**
	- Assert `command phase=failed` for dropped IDs.
	- Assert status no longer contains session in paused IDs.

- [ ] **Prompt while paused auto-resumes**
	- Pause, send prompt, assert generation begins and pause cleared.

### 4) Tool safety + concurrency guarantees (unit)

Changed code: `src/tools.ts`, `src/runtime/agent-loop.ts`, `src/hashline.ts`

Create `src/tools.test.ts`:

- [ ] **`write` rejects directory path**
- [ ] **`read` rejects directory path**
- [ ] **Input validation happens before FS operations** (`path`/`content` checks)
- [ ] **`edit` strips trailing newline from `new_content`** (no extra blank line)
- [ ] **Per-file lock serializes concurrent writes**
	- Run two `runTool('write', ...)` concurrently to same file; assert final content is one full write, never interleaved/corrupt.
- [ ] **Write+edit on same file is serialized**
	- Concurrent write/edit should produce valid deterministic file state.

## P1 — important but not urgent

### 5) Session restore/replay regression coverage (e2e)

Changed code: `src/runtime/sessions.ts`, `src/cli/format/index.ts`, `src/session.ts`

Likely needs harness extension (restart without deleting temp HAL dir).

Add tests (new `src/tests/restore.test.ts`):

- [ ] **Conversation replay after restart**
	- Send prompt, stop process, restart with same `HAL_DIR`/`HAL_STATE_DIR`.
	- Assert replay emits past `prompt` and assistant `chunk` events.

- [ ] **Registry active session restoration**
	- Seed registry with non-first active session and verify startup uses it.

- [ ] **Draft persistence across restart (e2e)**
	- Save draft via session files, restart, verify loaded draft path through client/runtime seam.

### 6) Config/model regression tests (unit)

Changed code: `src/config.ts`

Create `src/config.test.ts`:

- [ ] `parseModel('codex...')` resolves provider `openai`
- [ ] `resolveModel('codex')` maps to alias full model
- [ ] `providerForModel` and `modelIdForModel` behavior for bare + full IDs

### 7) OpenAI provider parser regressions (unit)

Changed code: `src/providers/openai.ts`

Create `src/providers/openai.test.ts`:

- [ ] `parseSSE` emits activity on `response.in_progress`/`output_item.in_progress`
- [ ] function-call argument deltas map to `tool_input_delta`
- [ ] `response.completed` maps stop reason to `tool_use` when function calls exist
- [ ] error payload parsing picks best message path

## P2 — formatter/TUI unit tests (good to have, catches visual regressions)

### 8) New formatter modules currently untested

Changed code:

- `src/cli/tui/format/status-bar.ts`
- `src/cli/tui/format/prompt.ts`
- `src/cli/tui/format/horizontal-padding.ts`
- `src/cli/tui/format/chunk-stability.ts`
- `src/cli/tui/format/line-style.ts`
- `src/cli/tui/format/line-prefix.ts`
- `src/cli/format/index.ts`

Create `src/cli/tui-format.test.ts` + `src/cli/format/index.test.ts`:

- [ ] status bar right/left alignment and truncation
- [ ] reset code always appended in status bar output
- [ ] prompt block formatter applies side padding on every wrapped line
- [ ] chunk transition prefix logic (`RESET` vs `\n`) for channel changes
- [ ] style application per line (including wrapped/newline cases)
- [ ] prefix styling preserves remainder style correctly

### 9) Input wrapping math coverage (currently none)

Changed code: `src/cli/tui.ts` + `src/cli/tui-input-layout.ts`

Create `src/cli/tui-input-layout.test.ts`:

- [ ] `getWrappedInputLayout` start offsets for spaces/newlines
- [ ] `cursorToWrappedRowCol` visual-line mapping
- [ ] `wrappedRowColToCursor` inverse mapping
- [ ] regression for Shift+Up/Down in multiline wrapped input

### 10) Keyboard TODOs already in suite

File: `src/cli/tui-keyboard.test.ts`

- [ ] Implement and unskip existing todos:
	- Cmd-Z semantics when terminal forwards Cmd-Z key event
	- Cmd-V semantics when terminal forwards Cmd-V key event

## Suggested implementation order

1. P0 fork/session/queue e2e
2. P0 tools unit tests
3. P1 restore/replay e2e (with harness extension)
4. P1 config + OpenAI parser unit tests
5. P2 formatter/input-layout/keyboard todo conversions

## Done criteria for this plan

- [ ] All new tests committed
- [ ] `bun run test:quick` green
- [ ] `bun test` green
- [ ] No new `todo` tests for cases we decided to support now
