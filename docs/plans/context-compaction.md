# Context compaction — strip old heavy content

## Problem

`loadApiMessages()` sends everything since the last reset/handoff to the API.
Tool results, tool call inputs (`write`/`edit` file contents), and images from
20 turns ago eat the same tokens as the latest ones. This fills context fast.

## Design

Post-process the message array returned by `loadApiMessages()` before sending
it to the provider. Walk backwards, find the "keep zone", replace everything
older with short placeholders.

### What counts as heavy

1. **Tool results** — `{ role: 'user', content: [{ type: 'tool_result', ... }] }`
2. **Tool call inputs** — `{ type: 'tool_use', input: { ... } }` inside assistant messages
3. **Images** — `{ type: 'image', source: { ... } }` inside user messages

### Keep zone

Walk backwards through the message array. Find the last assistant message that
contains `tool_use` blocks. That assistant message and all its corresponding
`tool_result` messages form the "last batch" — keep those in full.

BUT: if there are more than N (5) user-turn messages *after* that last batch,
the tools are stale — clear even those.

A "user turn" = a user message whose content is a plain string (not a
`tool_result` wrapper). This matches the natural conversation flow.

### What to replace with

- Tool results: `"[cleared — ref: <block-ref>]"` where `<block-ref>` is the
  block ID (e.g. `0lpnsy-7ts`). This lets the model read the old result from
  `blocks/<ref>.ason` if needed.
- Tool call inputs: `{}` (empty object — the API requires the field to exist)
- Images: `{ type: 'text', text: '[image cleared]' }` (replace the image block)

To make this work, `loadApiMessages()` needs to thread the block ref through
to the API-level tool_result messages. Currently it doesn't — the ref is only
in the log entry, not in the API message. Two options:

1. **Stash ref in a non-API field** on the tool_result block during load, e.g.
   `tool_result._ref = entry.ref`. compactApiMessages reads it.
2. **Build a toolUseId→ref map** during loadApiMessages and pass it to compact.

Option 1 is simpler — the extra field is harmless (providers ignore unknown fields).

### Where

New function `compactApiMessages(messages: any[]): any[]` in
`src/session/messages.ts` (or a new file — but messages.ts already has
`loadApiMessages`, so co-locating makes sense).

Called from `runtime.ts` right after `loadApiMessages()`, before passing to
`startGeneration()`. Also called in the agent loop's in-memory `messages` array
on each tool-use round (the loop pushes raw messages and re-invokes — those
accumulate too).

Actually — simplest: just call it once in `loadApiMessages()` at the end,
before returning. The agent loop's in-memory additions within a single
generation are fine (that's just the current turn's tools).

### Algorithm sketch

```
function compactApiMessages(msgs):
  // 1. Find last tool batch
  lastToolAssistantIdx = -1
  for i = msgs.length-1 down to 0:
    if msgs[i] has tool_use blocks:
      lastToolAssistantIdx = i
      break

  // 2. Collect tool_use IDs from that assistant message
  keepToolIds = set of tool IDs from msgs[lastToolAssistantIdx]

  // 3. Count user turns after lastToolAssistantIdx
  userTurns = 0
  for i = lastToolAssistantIdx+1 to msgs.length-1:
    if msgs[i].role == 'user' and content is string (not tool_result):
      userTurns++

  // 4. If userTurns > 5, don't keep even the last batch
  if userTurns > 5:
    keepToolIds = empty set

  // 5. Walk all messages, clear heavy content not in keep set
  for each msg:
    - tool_result not in keepToolIds → replace content with "[cleared — ref: <_ref>]"
    - tool_use not in keepToolIds → replace input with {}
    - image blocks in user messages: keep only if within last 2 user turns
```

## Part 2: Log rotation on reset/compact/fork

### Problem

Currently `/reset` appends a `{ type: 'reset' }` event inline, and
`loadApiMessages` skips everything before it. But the old messages stay in the
same `messages.asonl` file forever. The old code rotated the log file on
reset/compact/fork so old conversation stays intact in its own file.

### Design

Bring back log rotation from old code:

1. **`meta.ason` gets a `log` field** — points to the current messages file.
   Default: `'messages.asonl'`. Set at session creation time.

2. **`rotateLog(sessionId)`** — reads current `log` from meta, computes next
   name (`messages2.asonl`, `messages3.asonl`, ...), updates meta.log, returns
   the new name.

3. **On `/reset`**: rotate log. Write to new log:
   - `{ role: 'user', content: 'Session was reset. Previous log: messages.asonl', ts }`
   - `{ role: 'assistant', text: 'OK, conversation reset.', ts }`
   This gives the LLM a visible breadcrumb. `loadApiMessages` already skips
   non-role entries, so `type: 'info'` would be invisible.

4. **On `/compact`**: rotate log. Write to new log:
   - `{ role: 'user', content: '<buildCompactionContext output>', ts }`
   (Same as today, but into a fresh log file instead of after an inline handoff.)

5. **On `/fork`**: parent session is unaffected. Child session gets a fresh
   `messages.asonl` with `{ type: 'forked_from', parent, ts }` as before.
   (Fork already creates a new session dir, so no rotation needed — but the
   parent's meta.log must be read to know which file to follow the fork chain.)

6. **Auto-compact at 80%**: not in this PR, but the rotation mechanism enables
   it later.

### `[system] ` prefix convention

`loadApiMessages()` skips entries without a `role` field (`if (!msg.role) continue`).
`type: 'info'` entries are only for TUI display — the LLM never sees them.
So synthetic breadcrumbs must be `role: 'user'` messages.

Convention: messages starting with `[system] ` are system-generated. This prefix
controls both API and TUI behavior:

- **LLM sees** the full text including `[system] ...` — that's fine, it's context.
- **TUI (replayToBlocks)**: detects `[system] ` prefix → strips it, sets
  `source: 'System'` on the input block → header shows `── System ──`.
- **renderInput**: when `source` is not `'user'`, use a distinct color scheme
  (muted, info-like) so it doesn't look like user input.
- **No assistant reply needed**: the LLM doesn't require strict alternation when
  it's about to generate anyway. The `[system]` user message is always the first
  entry after rotation, and the next real user prompt follows it. Two consecutive
  user messages are fine (the API merges them).

No extra fields on the message type, no separate block type.

### appendMessages must use current log

`appendMessages` currently hardcodes `messages.asonl` via the Log helper.
It needs to read `meta.log` (or accept it as param) to write to the right file.

The `messagesLog()` helper needs the current log name. Options:
- Read meta.ason each time (wasteful)
- Cache it in memory — the liveFile proxy already does this

Since meta is a liveFile, we can just read `meta.log` from the proxy.
But messages.ts doesn't have access to the meta proxy. Options:
- Pass log name into appendMessages
- Have a module-level cache that `rotateLog` updates

Simplest: `messagesLog(sessionId)` reads meta.ason once and caches.
`rotateLog` invalidates the cache.

## Files to change

- `src/session/session.ts` — add `log` to createSession defaults, add `rotateLog()`
- `src/session/messages.ts` — add `compactApiMessages()`, thread `_ref` in loadApiMessages,
  make `messagesLog()` respect current log name, call compact at end of `loadApiMessages()`
- `src/runtime/runtime.ts` — update reset/compact/fork handlers to call rotateLog
- `src/protocol.ts` — add `log` to SessionInfo (if needed)
- Tests for both features

## Not doing

- Thinking blocks — already not sent on replay (confirmed)
- Summarization — that's the `/compact` context builder, already exists
- Prompt caching optimization — separate concern
- Auto-compact at 80% — future work, but rotation enables it
