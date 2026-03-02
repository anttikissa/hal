# Unified message log

Replace `session.asonl` + `conversation.asonl` with a single `messages.asonl`.

## Current state

Two append-only files per session:

- **`session.asonl`** — lean API messages (`role: 'user'|'assistant'`), refs to blocks for tool calls/results/thinking+signature. Used to reconstruct API context on restart.
- **`conversation.asonl`** — display events (`type: 'user'|'assistant'|'tool'|'model'|'fork'|'topic'|'handoff'|'reset'|'cd'|'start'`). Used for TUI replay.

Both are append-only. The overlap is user prompts and assistant text — duplicated in both files.

## New format: `messages.asonl`

One append-only log. Each line is an ASON object. Two kinds of entries: **messages** (have `role`) and **events** (have `type`).

### Messages (for API context)

```
{ role: 'user', content: 'hello', ts: '...' }
{ role: 'assistant', text: 'world', thinking: { ref: 'xxx', words: 42 }, ts: '...' }
{ role: 'assistant', text: 'Let me check.', tools: [{ id: 'toolu_xxx', name: 'grep', ref: 'xxx' }], ts: '...' }
{ role: 'tool_result', tool_use_id: 'toolu_xxx', ref: 'xxx', ts: '...' }
```

Key differences from current `session.asonl`:
- Assistant text is always a plain `text` field (never wrapped in content blocks array).
- Tool uses are in a `tools` array (just id, name, ref — input lives in block file).
- Tool results are top-level entries (not nested in a user message with content array).
- Thinking has `ref` + `words` summary (same as now). Full text + signature in block file.
- User messages with images: `content` is an array with text + `{ type: 'image', ref: 'xxx' }`.

### Events (for display + bookkeeping)

Same as current conversation events, unchanged:

```
{ type: 'start', workingDir: '/path', ts: '...' }
{ type: 'topic', to: 'Fix the bug', auto: true, ts: '...' }
{ type: 'model', from: 'anthropic/claude-opus-4-6', to: 'anthropic/claude-sonnet-4-20250514', ts: '...' }
{ type: 'fork', parent: '00-abc', child: '00-def', ts: '...' }
{ type: 'handoff', ts: '...' }
{ type: 'reset', ts: '...' }
{ type: 'cd', from: '/old', to: '/new', ts: '...' }
```

### Block files (`blocks/`)

Unchanged. Store large content:
- Thinking: `{ thinking: '...', signature: '...' }`
- Tool call + result: `{ call: { name, input }, result: { content } }`
- Images: `{ media_type: '...', data: '...' }`

## What changes

### Write path (agent-loop.ts, handle-command.ts, process-prompt.ts, sessions.ts)

- `persistMessages` + `appendConversation` → single `appendMessages` function that appends lean entries to `messages.asonl`.
- The dual-write disappears. One function, one file.
- Tool results get their own top-level entries instead of being nested in user content arrays.

### Read path — API context (loadSession)

- Parse `messages.asonl`, skip events (entries with `type` instead of `role`).
- Reconstruct API messages from lean format (same as `fromLeanMessage` but simpler since text is already a plain field).
- Group consecutive tool_result entries back into a single user message for the API.

### Read path — TUI replay (renderConversationHistory)

- Parse `messages.asonl`, render messages and events.
- User messages → `<prompt>` tag
- Assistant messages → `<thinking>` (from block ref) + `<assistant>` tag
- Tool use messages → tool name summary lines
- Events → same rendering as now (topic changes, model changes, etc.)
- Skip `tool_result` entries (tool output was already shown during execution via publishLine).

### Removed code

- `conversationPath()`, `appendConversation()`, `loadConversation()`, `ConversationEvent` type
- `replayConversationEvents()` — replaced by iterating unified log
- Duplicate text extraction in agent-loop.ts (currently extracts text blocks to build conversation event)
- The `thinking` field I just added to ConversationEvent

### Migration

- `loadSession` falls back to `session.asonl` if `messages.asonl` doesn't exist.
- Old sessions keep working; new messages append to `messages.asonl`.
- `conversation.asonl` is no longer written to or read.
