# Flat History Rollover Plan

Date: 2026-04-13

## Decision

Do a **one-shot rollover**.

- Write the new flat history format directly in normal runtime code.
- Run one migration script over all existing sessions.
- Reload and test.
- **No backwards-compat runtime code.**

If the migration is complete, compat code would only add confusion and line count.

## Target on-disk model

Persist visible/history events directly:

- `user`
- `thinking`
- `assistant`
- `tool_call`
- `tool_result`
- `info`
- `session`
- `reset`
- `compact`
- `forked_from`
- `input_history`

Rule:

**One visible block = one history entry.**

No more overloaded assistant entries containing hidden:

- `thinkingBlobId`
- `tools[]`
- replay-time split logic

## Blob rule

Blobs stay, but become orthogonal.

Any large payload may live in a blob referenced by `blobId`.

Examples:

- `thinking.blobId`
- `tool_call.blobId`
- `tool_result.blobId`
- image parts in `user.parts`

## Implementation order

### 1. Define the new history schema

Update `src/server/sessions.ts`:

- replace the old mixed `role`/`type` history typing
- make flat `type` entries the canonical format
- keep helper comments very explicit

### 2. Write new-format history

Update `src/runtime/agent-loop.ts`:

- user prompt -> `type: 'user'`
- completed thinking -> `type: 'thinking'`
- assistant text -> `type: 'assistant'`
- tool call -> `type: 'tool_call'`
- tool result -> `type: 'tool_result'`

Do not persist partial streaming deltas into history.
Streaming stays in `live.ason`.

### 3. Read/render new-format history

Update `src/cli/blocks.ts`:

- map history entries directly to blocks
- remove assistant-entry splitting logic
- tool results attach to matching tool blocks directly

Goal: replay should become nearly trivial.

### 4. Build provider messages from flat history

Update `src/session/api-messages.ts`:

- read flat history entries
- group consecutive assistant-side entries into one provider assistant turn when needed
- group consecutive tool results into the user/tool-result message shape providers expect
- keep provider weirdness here, not in persistence

### 5. Migrate existing sessions

Add a one-shot script.

Suggested file:

- `scripts/rollover-flat-history.ts`

Script behavior:

- walk every session dir
- migrate every `history*.asonl`
- convert old assistant entries into flat entries
- preserve timestamps
- preserve `forked_from`
- preserve blobs as-is

### 6. Backup rule

Before rewriting each log, create a backup beside it:

- `history.asonl.pre-flat-2026-04-13`
- `history2.asonl.pre-flat-2026-04-13`

Do not rely on git for session data rollback.

### 7. Cutover

After code is switched to write/read the new format:

1. run migration script once
2. reload Hal
3. verify:
	- old sessions replay
	- forks replay
	- thinking loads
	- tool calls/results load
	- `/system` still works
4. if good, keep backups for now but no compat code

## Test plan

Add or update tests for:

- history write of each new entry type
- replay/render from flat entries
- provider message reconstruction from flat history
- fork replay with parent blobs
- migration of old assistant entries to flat entries

## Non-goals

- no long-lived backwards compatibility reader
- no dual-write mode
- no mixed-format runtime path

## Success condition

After migration and reload:

- all sessions load from the new flat format
- no runtime code needs to understand the old assistant-shaped history
- the old split/replay/blob-owner weirdness is gone
