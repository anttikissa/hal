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

### Session file format (`session.asonl`)

Stays append-only ASONL, one message per line. Large content replaced with refs, small content stays inline.

**User text message:**
```
{ role: 'user', ts: '18:41', content: 'How much LOC does handoff take?' }
```

**Assistant with thinking + multiple tool calls:**
```
{ role: 'assistant', ts: '18:41', thinking: { ref: '4231-x3z', duration: 283, words: 14604 }, content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_01YK', name: 'grep', ref: '4231-b7k' }, { type: 'tool_use', id: 'toolu_01ZZ', name: 'read', ref: '4231-c9m' }] }
```

Tool use blocks keep `id` and `name` inline (so you can see *what* was called without opening the file). The `input` field moves into the block file, replaced by `ref`.

**Tool results (user message with results):**
```
{ role: 'user', ts: '18:41', content: [{ type: 'tool_result', tool_use_id: 'toolu_01YK', ref: '4231-b7k' }, { type: 'tool_result', tool_use_id: 'toolu_01ZZ', ref: '4231-c9m' }] }
```

The `tool_use_id` stays inline for pairing. The result content moves into the block file. A tool_use and its tool_result share the same ref/file.

**Assistant text-only response:**
```
{ role: 'assistant', ts: '18:45', content: 'About 180 lines of production code.' }
```

Short text stays inline — no ref needed.

**Interrupted/paused turn:**
```
{ role: 'user', ts: '18:42', content: [{ type: 'tool_result', tool_use_id: 'toolu_01YK', ref: '4231-b7k' }] }
{ role: 'user', ts: '18:42', content: '[User paused generation. Waiting for next direction.]' }
```

Same format — the tool result file just has `interrupted: true` or a truncated result.

### Block files (`blocks/`)

Per-session directory: `state/sessions/<sessionId>/blocks/`

Filename: `<ms-since-session-start>-<random-alphanum>.<ext>`

- `.txt` for thinking blocks (plain text, human-readable)
- `.ason` for tool calls (structured, call + result together)

Session start time (`createdAt`) is already in `info.ason`. The ms offset is `Date.now() - Date.parse(info.createdAt)`.

**Thinking block file** (`4231-x3z.txt`):
```
Plain text of the model's thinking. No escaping, no structure.
Just the raw thinking content, readable in any editor.
```

The signature is NOT stored in the block file — it lives only in the in-memory cache (see below). It's only needed for API requests, not for storage or display.

**Tool call block file** (`4231-b7k.ason`):
```
{
  call: { name: 'read', input: { path: '/foo/bar.ts', start: 1, end: 50 } }
  result: { content: '  1:abc first line\n  2:def second line\n...' }
}
```

Both call input and result in one file — you see the full picture of one tool invocation. The `id` is not stored here (it's in the session line and only matters for API message pairing).

### Size threshold

Not every block needs external storage:

- **Thinking blocks**: always external (even short ones — keeps the format consistent and the session file clean)
- **Tool calls**: always external (the result is unpredictable in size)

No threshold logic. Simple rule: thinking and tool calls go to files, text stays inline.

### In-memory cache

The runtime keeps the full message array in memory for the active session, identical to today's format:

```typescript
runtime.messages = [
  { role: 'user', content: 'How much LOC...' },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: '...full text...', signature: '...base64...' },
    { type: 'tool_use', id: 'toolu_01YK', name: 'grep', input: { pattern: 'handoff', ... } },
  ]},
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_01YK', content: '...' },
  ]},
  ...
]
```

This is exactly what the API receives. No behavior change in the agent loop or provider layer.

The cache is populated from:
- **Streaming responses** — normal operation. Blocks are written to disk AND kept in memory.
- **Block files on disk** — session restore after restart, fork, tab switch. `loadSession()` reads `session.asonl`, resolves refs from `blocks/`, and reconstructs the full in-memory format.

### Writing flow (agent-loop.ts)

When a turn completes:

1. For each thinking block: write `blocks/<ref>.txt` with the thinking text. Keep full block (with signature) in `runtime.messages`.
2. For each tool_use + tool_result pair: write `blocks/<ref>.ason` with call input + result content. Keep full blocks in `runtime.messages`.
3. Append lean message lines to `session.asonl` (refs instead of content).

Currently `saveSession()` rewrites the entire `session.asonl` on every turn. With v2, it should append only the new messages from the current turn. This is cheaper and matches the append-only nature of the file.

### Loading flow (session.ts)

`loadSession()` changes:

1. Parse `session.asonl` lines as today.
2. For each message with refs, resolve them:
   - Thinking ref → read `blocks/<ref>.txt`, reconstruct `{ type: 'thinking', thinking: text }` (signature is lost — see below)
   - Tool use ref → read `blocks/<ref>.ason`, extract `call.input`, reconstruct full `tool_use` block
   - Tool result ref → read same `blocks/<ref>.ason`, extract `result.content`, reconstruct full `tool_result` block
3. Return full in-memory message array.

**Signature loss on reload**: When restoring from disk, thinking blocks won't have signatures. This means:
- The API cache prefix won't match for restored sessions (signatures are part of the cached prefix)
- The API may reject thinking blocks without signatures

Options:
  - **Store signatures in the block file** (adds ~300 bytes per thinking block to the .txt file, or use .ason instead of .txt)
  - **Strip thinking blocks from restored sessions** (lose thinking context but avoid API errors)
  - **Store signatures separately** (e.g. a `signatures.ason` map file)

**Decision needed**: Which approach for signatures? Storing them in the block file (making it `.ason` with `{ thinking: '...', signature: '...' }`) is simplest but makes the file less human-readable. A pragmatic middle ground: use `.ason` format for thinking blocks too, but the thinking text is still the primary content.

### Thinking display in TUI

Thinking blocks render as a collapsed summary line in the output:

```
💭 Thought for 4.7 min (14,604 words)
```

- Clickable (OSC 8 link to the block file) — opens full thinking text
- Not expanded by default — saves screen space, output buffer stays small
- Duration and word count come from the session line metadata (`thinking: { ref, duration, words }`)
- During streaming, thinking still streams live as today. The collapsed summary replaces it when the block completes.

### Timestamps

Every message in `session.asonl` gets a `ts` field with local time (e.g. `'18:45'`).

Thinking blocks record start time (the message `ts`) and duration (in the `thinking.duration` field, seconds). End time = start + duration.

The TUI renders timestamps in the left margin:

```
18:41  > How much LOC does handoff take?

18:41  💭 Thought for 4.7 min (14,604 words)
18:45  About 180 lines of production code...
```

`conversation.asonl` already has `ts` fields (ISO format). No change needed there.

### Handoff (revised)

Replace the current LLM-summarization handoff with a deterministic approach:

1. Keep current `session.asonl` and `blocks/` as-is (they're already lean)
2. Rotate: `session.asonl` → `session-previous.asonl`
3. Clear `runtime.messages`
4. Inject a first message with context:

```
Context was cleared. Here is what happened before:

First 10 user messages:
1. <text of first user prompt>
2. <text of second user prompt>
...

Last 10 user messages:
...
11. <text of recent user prompt>
...
20. <text of most recent user prompt>

If you need to refer to the full session before clearing, see:
  state/sessions/<id>/session-previous.asonl
  state/sessions/<id>/blocks/
```

Only user messages (prompts) are included — they're short and tell the story of what was asked. Assistant messages with tool use would be enormous. If first and last overlap (≤20 total user messages), deduplicate.

Properties:
- **Instant** — no LLM call, no waiting
- **Lossless** — model sees actual prompts, not a lossy summary
- **Free** — no extra API cost
- **Deterministic** — same input always produces same handoff

### conversation.asonl

Unchanged. Remains an append-only event log for TUI replay and input history. Already has timestamps. The `handoff` event type changes meaning (no longer implies LLM summarization, just context rotation).

### Fork

`/fork` copies `session.asonl` and `blocks/` directory to the new session. Since blocks are immutable after creation, this could use hardlinks instead of copies to save disk space. The in-memory cache for the forked session is populated by loading from disk (same as restart restore).

### Migration

- Detect format by checking for `ref` fields in parsed messages
- Old format (inline content): load as today, keep working
- New format (refs): resolve from `blocks/` directory
- `loadSession()` handles both transparently
- No migration script needed — old sessions just stay in old format

## File structure

```
state/sessions/<sessionId>/
  session.asonl            # lean conversation spine with refs
  session-previous.asonl   # rotated on handoff (optional, from previous handoff)
  conversation.asonl       # unchanged — append-only event log for TUI replay
  info.ason                # unchanged — metadata (includes createdAt for block timestamps)
  draft.txt                # unchanged — unsent prompt text
  blocks/                  # external content blocks
    4231-x3z.ason          # thinking block
    4231-b7k.ason          # tool call + result
    8902-m2p.ason          # another thinking block
    ...
```

## What this deletes

- `handoff.md` / `handoff-previous.md` — no longer generated
- `performHandoff()` / `loadHandoff()` in `session.ts`
- `handoffPath()` / `sessionPreviousPath()` helpers
- `formatMessagesForHandoff()` / `windowConversationText()` in `handle-command.ts`
- `runHandoff()` LLM summarization logic + system prompt
- `handoff-format.test.ts`
- ~180 LOC of handoff production code + ~140 LOC of handoff tests

## What changes

- `saveSession()` in `session.ts` — append new messages + write block files instead of rewriting entire session
- `loadSession()` in `session.ts` — resolve refs from block files when loading
- `agent-loop.ts` — write block files during streaming, pass refs to save
- `handle-command.ts` — `runHandoff()` replaced with deterministic rotation + injection
- `sessions.ts` — `getOrLoadSessionRuntime()` no longer checks for `handoff.md`
- TUI output rendering — collapsed thinking lines, timestamps
- `forkSession()` — copy `blocks/` directory

## Open questions

1. **Signature storage**: Store in thinking block `.ason` file (simple but less readable), strip on reload (loses cache), or separate file? See "Signature loss on reload" section above.

2. **Block file cleanup**: When a session is deleted (`/close`), should `blocks/` be deleted too? Probably yes. What about `session-previous.asonl` — keep for one rotation or delete?

3. **Timestamp format**: `'18:45'` (local, short, human-friendly) or ISO `'2026-02-28T18:45:12.345Z'` (precise, sortable, timezone-aware)? Could store ISO and display short. The `conversation.asonl` already uses ISO.

4. **Append-only saveSession**: Currently `saveSession()` rewrites the full file every turn. Switching to append-only requires tracking which messages are already persisted. Worth the complexity, or keep rewriting the (now much smaller) file?

5. **Hardlinks for fork**: Worth the complexity vs simple copy? Blocks are small individually but may accumulate. Depends on typical session size.
