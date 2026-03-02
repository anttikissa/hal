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

Unchanged. Store large content:
- Thinking: `{ thinking: '...', signature: '...' }`
- Tool call + result: `{ call: { name, input }, result: { content } }`
- Images: `{ media_type: '...', data: '...' }`

## Use cases

### 1. API message reconstruction (loadSession)

Parse `messages.asonl`. Filter to entries with `role`. For each:
- `role: 'user'` → pass through as-is (resolve image refs from blocks if array content)
- `role: 'assistant'` → reconstruct content blocks array: thinking block from `thinking.ref` (with signature), text block from `text`, tool_use blocks from `tools[].ref`
- `role: 'tool_result'` → group consecutive tool_results into a single `role: 'user'` message with `type: 'tool_result'` content blocks (this is the API format)

Skip events (`type`-based entries) — they're display-only.

### 2. TUI replay (exact visual reconstruction)

Parse `messages.asonl`. Iterate all entries in order:
- `type: 'start'` → render session start line
- `type: 'handoff'|'reset'` → truncate replay to this point (same as now)
- `role: 'user'` → skip internal markers (`[model changed ...]`). Render user text as `<prompt>`.
- `role: 'assistant'` → if `thinking.ref`, read thinking text from block file, render as `<thinking>...<thinking-end>`. Render `text` as `<assistant>`. If `tools`, render tool names as summary.
- `type: 'tool_log'` → render each line as `<tool>` (same as now)
- `role: 'tool_result'` → skip (tool output already shown via tool_log)
- `type: 'topic'|'model'|'cd'|'fork'` → not currently rendered in TUI replay, skip

**Discrepancies from live view (warranted):**
- Tool activity/status lines (`Running: grep`, `Thinking...`) are ephemeral — not stored, not replayed. These are transient status indicators.
- `[debug:loop]` and other debug-level lines are not replayed.
- Streaming chunk boundaries are lost — text appears as a single block instead of character-by-character.

### 3. Compaction (/handoff rotation)

`buildRotationContext` operates on the in-memory `messages` array (unchanged). It extracts first-line summaries of user prompts. The file format doesn't affect this — the in-memory array is populated from `messages.asonl` on load.

`rotateSession` renames `messages.asonl` → `messages.N.asonl` (instead of `session.N.asonl`).

## Implementation

### Write path

One function replaces both `persistMessages` and `appendConversation`:

```ts
// Append entries (messages or events) to messages.asonl
async function appendToLog(sessionId: string, entries: LogEntry[]): Promise<void>
```

Call sites:
- **agent-loop.ts**: After each API response, append assistant message. After tool execution, append tool_result messages + tool_log event. After full loop, update meta.
- **process-prompt.ts**: Append user message.
- **handle-command.ts**: Append events (fork, handoff, reset, topic, model, cd).
- **sessions.ts**: Append start event.

The `persistedCount` tracking for incremental appends goes away — we just append as we go, like `appendConversation` does now.

### Read path

`loadSession` reads `messages.asonl`, filters to `role`-based entries, resolves block refs → API messages array.

`renderConversationHistory` reads `messages.asonl`, iterates all entries → TUI output.

### Migration

- `loadSession` falls back to `session.asonl` if `messages.asonl` doesn't exist.
- Old sessions keep working read-only.
- `forkSession` copies `messages.asonl` (falls back to `session.asonl`).

### Removed code

- `conversationPath()`, `appendConversation()`, `loadConversation()`
- `ConversationEvent` type, `ReplayConversationEvent` type, `replayConversationEvents()`
- `persistMessages()` (replaced by `appendToLog`)
- `persistedCount` tracking in runtime
- `toLeanMessages()` / `fromLeanMessage()` — replaced by simpler per-entry serialization
- Dual text extraction in agent-loop.ts

### Changed code

- `loadSession` — reads new format, skips events
- `renderConversationHistory` — reads unified log instead of conversation events
- `forkSession` — copies `messages.asonl` instead of two files
- `rotateSession` — renames `messages.asonl`
- `buildRotationContext` — path reference in text changes from `session.*.asonl` to `messages.*.asonl`
