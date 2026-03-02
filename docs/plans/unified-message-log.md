# Unified message log

Replace `session.asonl` + `conversation.asonl` with a single `messages.asonl`.

## Current state

Two append-only files per session:

- **`session.asonl`** — lean API messages (`role: 'user'|'assistant'`), refs to blocks for tool calls/results/thinking+signature. Used to reconstruct API context on restart.
- **`conversation.asonl`** — display events (`type: 'user'|'assistant'|'tool'|'model'|'fork'|'topic'|'handoff'|'reset'|'cd'|'start'`). Used for TUI replay.

Both are append-only. The overlap is user prompts and assistant text — duplicated in both files.

## New format: `messages.asonl`

One append-only log. Each line is an ASON object. Two kinds of entries: **messages** (have `role`) and **events** (have `type`).

### Messages

```ason
{ role: 'user', content: 'Can you write me a C64 BASIC program?', ts: '...' }
{ role: 'assistant', text: "Here's a program...", thinking: { ref: 'xxx', words: 42 }, ts: '...' }
{ role: 'assistant', text: 'Let me check.', tools: [{ id: 'toolu_xxx', name: 'grep', ref: 'xxx' }], ts: '...' }
{ role: 'tool_result', tool_use_id: 'toolu_xxx', ref: 'xxx', ts: '...' }
```

Rules:
- `role: 'user'` — `content` is a string (plain text) or array (with images: `[{ type: 'text', text: '...' }, { type: 'image', ref: 'xxx' }]`).
- `role: 'assistant'` — `text` is always a plain string (the response text). Optional `thinking: { ref, words }`. Optional `tools: [{ id, name, ref }]`.
- `role: 'tool_result'` — one per tool call. `ref` points to block file containing input+output. `tool_use_id` links back to the tool call.
- Internal user markers (model change, pause) stay as `role: 'user'` with bracket-prefixed content like `[model changed ...]`, same as current session.asonl.

### Events

```ason
{ type: 'start', workingDir: '/path', ts: '...' }
{ type: 'topic', to: 'Fix the bug', auto: true, ts: '...' }
{ type: 'model', from: 'anthropic/claude-opus-4-6', to: 'anthropic/claude-sonnet-4-20250514', ts: '...' }
{ type: 'fork', parent: '00-abc', child: '00-def', ts: '...' }
{ type: 'handoff', ts: '...' }
{ type: 'reset', ts: '...' }
{ type: 'cd', from: '/old', to: '/new', ts: '...' }
{ type: 'tool_log', text: '[grep] found 3 matches\n/src/foo.ts:12: ...', ts: '...' }
```

`tool_log` replaces the current `tool` conversation event — it stores the tool output lines the user saw during execution. These are display-only; not sent to the API.

### Block files (`blocks/`)

Store large content:
- Thinking: `{ thinking: '...', signature: '...' }`
- Tool call + result: `{ call: { name, input }, result: { content } }`
- Images: `{ media_type: '...', data: '...' }`

**Block ref format change:** Currently `${Date.now()}-${3 random hex bytes}` (e.g. `1772459253778-12f7ef`). New format: `${msOffset}-${5 random base36 chars}` where msOffset is milliseconds since session creation. Example: `3241-k7m2p`. Uses the full `0-9a-z` alphabet (already defined as `ID_CHARS`).

## Forking by reference

Currently forkSession copies both .asonl files + all block files. This is wasteful and confuses models — they see shared history as if it happened in their own session.

### New approach

The child's `messages.asonl` starts with a fork reference instead of copied content:

```ason
{ type: 'fork_from', parent: '00-abc', ts: '2026-03-02T16:30:59.663Z' }
```

No files or blocks are copied. The child session's blocks/ only contains blocks created after the fork.

### Loading a forked session

1. Read child's `messages.asonl`. If the first entry is `fork_from`, follow the reference.
2. Read parent's message log up to the fork timestamp. If the parent itself starts with a `fork_from`, recurse.
3. Concatenate: parent messages (up to fork ts) + child messages (after fork entry).

For block resolution: look in child's `blocks/` first, then walk up the parent chain. This is a simple directory-ordered search.

### What the model sees

Instead of the current `[forked from 00-abc]` user marker, inject a clearer context message:

```
[This session was forked from session 00-abc at 2026-03-02T16:30:59.
Everything above this point happened in the parent session, not in this session.
From this point on, this is session 00-def.]
```

### Parent compaction safety

Parent's message log files and blocks/ are never deleted by compaction. Rotation renames `messages.asonl` → `messages2.asonl` etc., but the old file stays on disk. When loading a forked session, search all of the parent's message files to find entries up to the fork timestamp.

## Rotation (compaction)

Current: `session.asonl` → `session.N.asonl` (N=1,2,3...)

New: `messages.asonl` → `messages2.asonl`, `messages3.asonl`, etc. Natural ordering: `messages.asonl` is always the current/active one. `info.ason` tracks which is active (though it's always just `messages.asonl`).

## Context window optimization

### Tool result trimming

Currently ALL past tool call results (which can be huge — full file contents, grep output) are sent to the model on every turn. This wastes context.

New behavior: only the last N tool-call-result pairs are sent with full content. Older ones are replaced with a short summary:

```
[tool result omitted — see blocks/xxx.ason]
```

Config (`config.ason`):
```ason
// Number of recent tool-call rounds to include with full results.
// Older tool results are replaced with a short placeholder.
// Set to Infinity to send all results (not recommended for long sessions).
recentToolResultLimit: 3
```

This is applied at API-call time (when building the messages array to send), not at storage time. The full results are always preserved in block files.

### Image trimming

Currently images are inlined as base64 in user messages and sent every turn — they're never stored in block files.

New behavior:
- Images are stored in block files (like tool calls and thinking blocks). The message log has `{ type: 'image', ref: 'xxx' }`.
- When building API messages, only images from the last N user messages are included inline. Older images are replaced with a placeholder:
  ```
  [image omitted — see blocks/xxx.ason]
  ```
- The model can request to see an old image by reading the block file via the `read` tool.

Config: `recentImageLimit: 3` (same pattern as tool results).

## Startup performance

### Async session reconstruction

Currently session loading blocks the UI. New behavior:

1. App starts, TUI renders immediately (prompt visible, status bar shows startup time).
2. Session reconstruction runs async in the background — reading messages.asonl + block files.
3. While reconstructing: prompts are blocked (boolean flag `sessionLoading`). User sees a status indicator.
4. When reconstruction finishes: log perf numbers — `[session] restored in Xms (Y messages, Z blocks read)`.
5. The `sessionLoading` flag is cleared, prompts are enabled.

The perf output should show:
- Total wall time for reconstruction
- Number of messages and block files read
- This goes to the `meta` log level (same as current `[session] restored N messages` line)

## Use cases

### 1. API message reconstruction (loadSession)

Parse message log (following fork_from references). Filter to entries with `role`. For each:
- `role: 'user'` → pass through (resolve image refs from blocks, applying image trimming)
- `role: 'assistant'` → reconstruct content blocks: thinking from ref (with signature), text, tool_use from refs
- `role: 'tool_result'` → group consecutive tool_results into a single user message (API format). Apply tool result trimming.

Skip events (`type`-based entries) — they're display-only.

### 2. TUI replay (exact visual reconstruction)

Parse message log (following fork_from references). Iterate all entries:
- `type: 'start'` → render session start line
- `type: 'fork_from'` → render fork indicator
- `type: 'handoff'|'reset'` → truncate replay to this point
- `role: 'user'` → skip internal markers (`[model changed ...]`). Render user text as `<prompt>`.
- `role: 'assistant'` → if `thinking.ref`, read thinking text from block, render as `<thinking>...<thinking-end>`. Render `text` as `<assistant>`. If `tools`, render tool name summaries.
- `type: 'tool_log'` → render each line as `<tool>`
- `role: 'tool_result'` → skip (output already shown via tool_log)
- `type: 'topic'|'model'|'cd'|'fork'` → not rendered in TUI replay, skip

**Discrepancies from live view (warranted):**
- Tool activity/status lines (`Running: grep`, `Thinking...`) are ephemeral — not stored, not replayed.
- `[debug:loop]` and other debug-level lines are not replayed.
- Streaming chunk boundaries are lost — text appears as a single block.

### 3. Compaction (/handoff rotation)

`buildRotationContext` operates on the in-memory `messages` array (unchanged). The file format doesn't affect this.

`rotateSession` renames `messages.asonl` → `messagesN.asonl`.

## Implementation

### Write path

Single function replaces both `persistMessages` and `appendConversation`:

```ts
async function appendToLog(sessionId: string, entries: LogEntry[]): Promise<void>
```

Call sites:
- **agent-loop.ts**: Append assistant message, tool_result messages, tool_log events.
- **process-prompt.ts**: Append user message (with image refs to blocks).
- **handle-command.ts**: Append events (fork, handoff, reset, topic, model, cd).
- **sessions.ts**: Append start event.

`persistedCount` tracking goes away — entries are appended as they happen.

### Read path

`loadSession` reads message log (following fork references), filters to `role` entries, resolves block refs, applies tool result + image trimming → API messages array.

`renderConversationHistory` reads message log (following fork references), iterates all entries → TUI output. Reads thinking blocks for display (async).

### Migration

- `loadSession` falls back to `session.asonl` if `messages.asonl` doesn't exist.
- Old sessions keep working read-only.
- `forkSession` from old-format sessions copies files (legacy behavior).

### Removed code

- `conversationPath()`, `appendConversation()`, `loadConversation()`
- `ConversationEvent` type, `ReplayConversationEvent` type, `replayConversationEvents()`
- `persistMessages()` (replaced by `appendToLog`)
- `persistedCount` tracking in runtime
- `toLeanMessages()` / `fromLeanMessage()` — replaced by simpler per-entry serialization
- Dual text extraction in agent-loop.ts
- Block file copying in `forkSession`

### New code

- Fork-reference resolution (follow parent chain, merge message logs)
- Block resolution with parent-chain fallback
- Tool result trimming at API-call time
- Image block storage + trimming
- Async session reconstruction with perf tracking
- `recentToolResultLimit` + `recentImageLimit` config
- Shorter block ref generation (ms-offset + base36)
