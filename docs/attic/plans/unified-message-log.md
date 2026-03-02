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
{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', ref: 'a3-k8mq2' }], ts: '...' }
{ role: 'assistant', text: "Here's a program...", thinking: { ref: 'a2-p7xnq', words: 42 }, ts: '...' }
{ role: 'assistant', text: 'Let me check.', tools: [{ id: 'toolu_xxx', name: 'grep', ref: 'b1-r3kw9' }], ts: '...' }
{ role: 'tool_result', tool_use_id: 'toolu_xxx', ref: 'b1-r3kw9', ts: '...' }
```

Rules:
- `role: 'user'` — `content` is a string (plain text) or array (with images: `[{ type: 'text', text }, { type: 'image', ref }]`). Images always go to block files.
- `role: 'assistant'` — `text` is always a plain string. Optional `thinking: { ref, words }`. Optional `tools: [{ id, name, ref }]`.
- `role: 'tool_result'` — one per tool call. `ref` points to block file with input+output. `tool_use_id` links back.
- Internal user markers (model change, pause) stay as `role: 'user'` with bracket-prefixed content like `[model changed ...]`.

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

`tool_log` replaces the current `tool` conversation event — stores the tool output lines the user saw. Display-only; not sent to the API.

### Block files (`blocks/`)

Store large content:
- Thinking: `{ thinking: '...', signature: '...' }`
- Tool call + result: `{ call: { name, input }, result: { content } }`
- Images: `{ media_type: '...', data: '...' }`

**Block filename format:** `{offset}-{random5}` where offset is milliseconds since session creation, and random5 is 5 chars from `a-z0-9`. Example: `a2-p7xnq` (162ms), `3f2c1-k8mq2` (259009ms ≈ 4.3min). The offset is hex to keep it short. This replaces the current `{unix_ms}-{hex6}` format (e.g. `1772459253778-12f7ef`).

## Forking by reference

When a session is forked, the child's `messages.asonl` starts with a **fork reference** instead of copying the parent's entire history:

```ason
{ type: 'forked_from', parent: '00-abc', ts: '2026-03-02T16:30:59.663Z' }
```

This means: "all messages in parent `00-abc` before this timestamp are part of my history."

### Loading a forked session

1. Read child's `messages.asonl`. See `forked_from` as first entry.
2. Recursively load parent's message history (parent may itself be a fork).
3. Take parent messages up to the fork timestamp.
4. Append child's own messages (everything after the `forked_from` entry).

### Block resolution for forked sessions

When resolving a block ref, check:
1. Child's `blocks/` directory first
2. Then parent's `blocks/` directory (recursively up the fork chain)

This avoids copying block files on fork. New blocks created in the child go to the child's `blocks/`.

### What the model sees

The fork marker becomes a user message in the API context:

```
[This session was forked from session 00-abc at 2026-03-02T16:30. Everything above happened in the parent session; this session continues independently from that point.]
```

This replaces the current `[forked from 00-abc]` marker and makes the relationship explicit, so models don't get confused about shared history.

### Parent safety

Parent's `messages.asonl` and `blocks/` are never modified or deleted by the child. Rotation renames the parent's log file but the child can still find it (see Rotation section).

## Rotation (compaction)

When `/handoff` triggers rotation:

1. `info.ason` gains a `currentLog` field (default: `messages.asonl`).
2. On rotation, `info.ason.currentLog` is updated to `messages2.asonl` (then `messages3.asonl`, etc.).
3. The old file stays exactly where it is — no renaming.

This way files are naturally ordered: `messages.asonl` (first), `messages2.asonl`, `messages3.asonl`.

Forked sessions reference the parent by session ID + timestamp. When loading parent history, read all `messages*.asonl` files in order and filter by timestamp.

## Context trimming

### Tool call results (config: `recentToolResults`)

Old tool call results can be huge (file contents, grep output). Only the most recent N tool results are sent to the API with full content. Older ones are replaced with a placeholder:

```
[tool result omitted — run the tool again if needed]
```

Config in `config.ason`:
```ason
{
  // Number of recent tool call results to include in full.
  // Older results are replaced with a short placeholder.
  // Set to Infinity to include all. Default: 3.
  recentToolResults: 3
}
```

The tool call itself (name + input) is always sent — only the result content is trimmed. This lets the model see what was called and re-run it if needed.

### Images

Images are large (base64-encoded). Old images are dropped from the API context, replaced with a placeholder:

```
[image omitted — use the read tool to view {path} if needed]
```

Only images in the most recent user message are sent in full. The block file always retains the original image data, so the model can re-read it via a tool call if needed.

Currently images are stored inline in messages (base64 in the content array). The new format moves them to block files with refs, which also makes `messages.asonl` human-readable.

## Async startup reconstruction

When the app starts:

1. TUI renders immediately (responsive UI, input area visible).
2. Startup perf line (`[perf] startup: Xms`) prints before reconstruction.
3. Session reconstruction starts async in the background.
4. While reconstructing, prompts are blocked (boolean flag; user sees the input area but can't submit).
5. When done, print reconstruction perf: `[perf] session restored: Xms (N messages, M blocks read)`.
6. Unblock prompt submission.

This is a UX improvement — currently the app blocks until session load completes.

## Use cases

### 1. API message reconstruction (loadSession)

Parse `messages.asonl` (following fork references recursively). Filter to `role`-based entries. For each:
- `role: 'user'` → pass through (resolve image refs from blocks; drop old images per trimming rules)
- `role: 'assistant'` → reconstruct content blocks: thinking from ref (with signature), text block, tool_use blocks from tools[].ref
- `role: 'tool_result'` → group consecutive results into a single `role: 'user'` message. Trim old results per `recentToolResults` config.

Skip events (`type`-based entries).

### 2. TUI replay (exact visual reconstruction)

Parse `messages.asonl` (following fork references). Iterate all entries:
- `type: 'start'` → render session start line
- `type: 'forked_from'` → render fork indicator
- `type: 'handoff'|'reset'` → truncate replay to this point
- `role: 'user'` → skip internal markers (`[model changed ...]`, `[forked ...]`). Render as `<prompt>`.
- `role: 'assistant'` → if `thinking.ref`, read thinking text from block, render `<thinking>...<thinking-end>`. Render `text` as `<assistant>`. If `tools`, render tool name summary.
- `type: 'tool_log'` → render each line as `<tool>`
- `role: 'tool_result'` → skip (output already shown via tool_log)
- `type: 'topic'|'model'|'cd'|'fork'` → skip (not rendered in current TUI either)

**Warranted discrepancies from live view:**
- Ephemeral status lines (`Running: grep`, `Thinking...`) are not stored or replayed.
- `[debug:loop]` lines are not replayed.
- Streaming chunk boundaries are lost — text appears as a single block.

### 3. Compaction (/handoff rotation)

`buildRotationContext` uses in-memory messages array — unchanged. Path references in the handoff text change to `messages*.asonl`.

## Implementation

### Write path

One function replaces both `persistMessages` and `appendConversation`:

```ts
async function appendToLog(sessionId: string, entries: LogEntry[]): Promise<void>
```

Call sites:
- **agent-loop.ts**: After each API response, append assistant message + tool_result messages + tool_log event.
- **process-prompt.ts**: Append user message (images → block files + refs).
- **handle-command.ts**: Append events (fork, handoff, reset, topic, model, cd).
- **sessions.ts**: Append start event.

`persistedCount` tracking goes away — we append as we go.

### Read path

`loadSession` reads `messages.asonl` (follows fork refs), filters to `role` entries, resolves blocks → API messages. Applies context trimming (tool results, images).

`renderConversationHistory` reads `messages.asonl` (follows fork refs), iterates all entries → TUI output. Reads thinking blocks for display.

### Migration

- `loadSession` falls back to `session.asonl` if `messages.asonl` doesn't exist.
- Old sessions work read-only; new messages go to `messages.asonl`.
- `forkSession` on old sessions: copy `session.asonl` → `messages.asonl` in child, then prepend fork reference. (One-time migration per fork.)

### Removed code

- `conversationPath()`, `appendConversation()`, `loadConversation()`
- `ConversationEvent` type, `ReplayConversationEvent` type, `replayConversationEvents()`
- `persistMessages()` (replaced by `appendToLog`)
- `persistedCount` tracking in runtime
- `toLeanMessages()` / `fromLeanMessage()` — replaced by simpler per-entry serialization
- Dual text extraction in agent-loop.ts
- Block file copying in `forkSession`

### Changed code

- `loadSession` — follows fork references, reads new format, applies trimming
- `renderConversationHistory` — reads unified log, follows fork refs
- `forkSession` — creates fork reference instead of copying
- `rotateSession` → creates new `messagesN.asonl`, updates `info.ason.currentLog`
- `makeBlockRef` — uses offset-from-session-start + 5 random base36 chars
- `parseInputContent` — writes images to block files, returns refs
- `buildRotationContext` — path reference text changes
- Startup sequence — async reconstruction with perf reporting
