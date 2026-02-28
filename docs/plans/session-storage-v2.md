# Session Storage v2 — Lean Sessions with External Blocks

## Problem

`session.asonl` is bloated. In a typical session:

- **Thinking blocks**: ~50% of file size (walls of text + signatures)
- **Tool results**: ~25% (full file contents, command output)
- **Tool use inputs**: ~9%
- **Signatures**: ~15% (opaque base64 for thinking verification)
- **Actual conversation text**: ~1%

This makes the session file unreadable, expensive to store, and complicates handoff/fork. The full thinking+signature payloads are also resent to the API on every turn for cache prefix matching, but that's an in-memory concern — no reason to duplicate it on disk.

## Design

### Core idea

Split session storage into a lean conversation spine and external block files. The runtime keeps full message history in memory (for API calls and cache hits). Disk is for durability and cross-session access.

### Session file (`session.asonl`)

Stays append-only ASONL. Each line is a message, but large content is replaced with refs:

```
{ role: 'user', ts: '18:41', content: 'How much LOC does handoff take?' }
{ role: 'assistant', ts: '18:41', thinking: { ref: '4231-x3z', duration: 283, words: 14604 }, content: [{ type: 'tool_use', ref: '4231-b7k' }] }
{ role: 'user', ts: '18:41', content: [{ type: 'tool_result', ref: '4231-b7k' }] }
{ role: 'assistant', ts: '18:45', content: 'About 180 lines of production code...' }
```

Properties:
- **Timestamps** on every message (`ts` — local time like `18:45`)
- **Thinking** stored as metadata (ref, duration in seconds, word count) — not inline text
- **Tool calls** stored as refs — both the `tool_use` (call + input) and `tool_result` (output) live in the same block file
- **Short text content** stays inline
- File is human-readable — you can `cat` it and follow the conversation

### Block files (`blocks/`)

Per-session directory: `state/sessions/<sessionId>/blocks/`

Filename: `<ms-since-session-start>-<random-alphanum>.ason`

Examples:
- `4231-x3z.txt` — thinking block (plain text, not ASON)
- `4231-b7k.ason` — tool call (ASON with both the call and the result)

Tool call block format:
```
{
  call: { id: 'toolu_01YK...', name: 'read', input: { path: '/foo/bar.ts' } }
  result: { content: '...' }
}
```

This lets the user inspect one tool call at a time — the request and response together in one file.

### In-memory cache

The runtime keeps the full message array in memory for the active session:
- Thinking blocks with full text + signatures (needed for API cache prefix matching)
- Tool results inlined (needed for API context)
- On each turn, the API gets exactly the same payload it gets today — no behavior change

The cache is populated from:
- Streaming responses (normal operation — blocks are written to disk and kept in memory)
- Block files on disk (session restore after restart, fork, tab switch)

### Thinking display in TUI

Thinking blocks render as a collapsed summary line in the output:

```
💭 Thought for 4.7 min (14,604 words)
```

- Clickable (OSC 8 link to the block file) — opens full thinking text
- Not expanded by default — saves screen space, output buffer stays small
- Duration and word count come from the session file metadata

### Timestamps in TUI

Messages show local timestamps:

```
18:41  > How much LOC does handoff take?

18:41  💭 Thought for 4.7 min (14,604 words)
18:45  About 180 lines of production code...
```

Timestamps are stored in session events. Thinking blocks record both start and end time (for duration calculation).

### Handoff (revised)

Replace the current LLM-summarization handoff with a deterministic approach:

1. Save current `session.asonl` (already lean) and block files as-is
2. Reset the session
3. Inject a first message with context:

```
Context was cleared. Here is what happened before:

First 10 messages:
[...]

Last 10 messages:
[...]

If you need to refer to the full session before clearing, see:
  state/sessions/<id>/session-previous.asonl
  state/sessions/<id>/blocks/
```

Properties:
- **Instant** — no LLM call, no waiting
- **Lossless** — model sees actual messages, not a lossy summary
- **Free** — no extra API cost
- **Deterministic** — same input always produces same handoff
- First/last N should be *user messages* (prompts), which are short. Assistant messages with tool use can be huge.

### Migration

- New sessions use v2 format by default
- Old `session.asonl` files (with inline thinking/tool content) continue to work — the runtime detects the format by presence/absence of `ref` fields
- No need to migrate existing sessions

## File structure

```
state/sessions/<sessionId>/
  session.asonl          # lean conversation spine with refs
  conversation.asonl     # unchanged — append-only event log for TUI replay
  info.ason              # unchanged — metadata
  blocks/                # new — external content blocks
    4231-x3z.txt         # thinking block (plain text)
    4231-b7k.ason        # tool call + result (ASON)
    8902-m2p.txt         # another thinking block
    ...
```

## What this deletes

- `handoff.md` / `handoff-previous.md` — no longer needed
- `session-previous.asonl` — replaced by keeping the old session in place
- `performHandoff()` / `loadHandoff()` in `session.ts`
- `formatMessagesForHandoff()` / `windowConversationText()` in `handle-command.ts`
- `runHandoff()` LLM summarization logic
- ~180 LOC of handoff production code + ~140 LOC of handoff tests
