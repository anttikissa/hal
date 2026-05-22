# /rebase plan

<!-- delete this file once session 27-n07 has finished implementing this -->

## Scope and semantics

- `/rebase` rewrites the active context log, not reality.
- The session must be idle before rebase can start.
- Entries are shown in chronological order, like git interactive rebase.
- The user can reorder lines freely. Server-side validation decides whether the result is structurally usable.
- Editable entries:
  - text-only `user` entries
  - `assistant` text entries
- Pick/drop/reorder only:
  - tool batches
  - `thinking` blocks
  - cwd/model/info/meta entries
  - warnings/errors
  - multimodal `user` entries
- MVP should rebase the current session log only. Fork parent history can be handled later.

## Tool batch findings

Checked the 10 most recent session logs before updating this plan:

- `27-n07`: `CCRR`, many `CR`; one incomplete active call because the check itself was still running.
- `27-nbl`: no tools.
- `27-dj2`: `CCRR`, `CCCRRR`, many `CR`.
- `27-9td`: only `CR`.
- `27-xud`: no tools.
- `27-mjt`: no tools.
- `27-55e`: `CCRR`, many `CR`.
- `27-c3t`: `CCRR`, many `CR`.
- `27-svx`: only `CR`.
- `27-01b`: `CCRR`, `CCCRRR`, `CCCCRRRR`, `CCCCCRRRRR`, many `CR`.

No completed batch had result-before-call, result-without-call, or result order different from call order. The important surprise is common and expected: providers can emit multiple tool calls before any results, so the rebase unit cannot be a single `tool_call` plus the next `tool_result`.

## Tool batch model

A tool line in the rebase todo represents a **tool batch**, not a single history entry.

Batch construction:

1. Start a batch at a `tool_call` or stray `tool_result`.
2. Keep consuming contiguous tool entries.
3. Track outstanding `tool_call.toolId`s.
4. End the batch at the first point where every call in the batch has a matching result.
5. If a new `tool_call` appears before earlier calls are complete, keep it in the same batch.
6. If a non-tool entry or EOF appears while calls are still outstanding, keep the incomplete batch as one protected line and mark it as interrupted in the comment.

Examples:

```text
tool_call A, tool_result A                         -> one tool batch
tool_call A, tool_call B, tool_result A, result B  -> one tool batch
tool_call A, result A, tool_call B, result B       -> two tool batches
tool_call A, tool_call B, result A, call C, ...    -> one batch until A/B/C settle
```

Dropping or moving a tool batch preserves the exact internal order of all its original `tool_call` and `tool_result` entries. Tool batch content is display-only; it is not editable.

## IDs

- Every rebase todo line has an id.
- Use an existing entry/blob id when available.
- Otherwise generate ids in the existing timestamp-plus-random format.
- A tool batch gets one row id and maps to multiple underlying history entries.
- Server apply uses `{ baseLog, baseHash, row id -> original entries }`; it never trusts the displayed content to identify entries.
- When writing the new log, preserve existing ids and write generated ids for entries that did not previously have one if the history type supports it. If adding ids to all entry types is part of implementation, update `HistoryEntry` accordingly.

## Storage

- Keep `history.asonl` unchanged except append a marker:

```ason
{ type: 'rebased_to', log: 'history2.asonl', ts: '...' }
```

- Write the chosen result to `history2.asonl`.
- Set `session.ason.currentLog = 'history2.asonl'`.
- The new log may start with a marker:

```ason
{ type: 'rebased_from', log: 'history.asonl', ts: '...' }
```

- IPC event should use hyphen style: `history-rebased`.
- History entries should stay snake_case: `rebased_to`, `rebased_from`.

## Todo file format

Use a plumbing-first, git-like line format:

```text
<cmd> <id> <type> <content>                         # <time>; <notes>
```

Rules:

- Chronological order.
- Keep history terminology exactly: `thinking`, `tool_call`, `tool_result`, `assistant`, `user`, `info`, etc.
- Prefer 80 columns, but allow longer lines when useful, especially image paths.
- Align `#` comments to the same column when possible.
- Text before `#` is the editable/programmatic part.
- Text after `#` is an ignored comment, familiar from scripts and config files.
- `<content>` is `ason.stringify(..., 'short')`, truncated if needed so the comment can align.
- For editable `user` and `assistant` entries, `<content>` is simply an ASON string.
- For protected entries, `<content>` is the shortest useful ASON representation of the state.
- No `=`/`~` markers.

Example:

```text
# Rebase 04-xur history.asonl -> history2.asonl
# Commands: pick, edit, drop. Delete a line to drop it. Reorder freely.
# Abort: empty file, or any non-comment line whose command is abort.
# Comments after # are ignored.

pick 0007n5-0z3 user 'hello world'                  # 11:10; 11 chars
pick 0007n5-x0z thinking { signed: true, chars: 482 } # 11:11; blob 0007n5-x0z
pick 000823-xx8 assistant "What's up?"              # 11:12; 10 chars
pick 001912-fj2 info { cwd: ['~', '~/.hal'] }        # 11:13; next-user
pick 002123-xux user 'check file.txt'                # 11:13; 14 chars
pick 003031-xiz tool_batch { read: { path: './file.txt' } } # 11:14; result 5 chars
pick 003403-xyx assistant 'I read file.txt.\n\nCon...' # 11:14; truncated; use edit
```

## Content rendering

Renderer should show as much useful information as possible without making the todo noisy:

- `user` text-only: ASON string of the text.
- `assistant`: ASON string of the text.
- Long `user`/`assistant`: truncated ASON string; comment says `truncated; use edit`.
- `thinking`: `{ signed: true, chars: N }`, plus blob id/signature info in comment if useful.
- `tool_batch`: object keyed by tool names when compact, or `{ calls: [...], results: N }` when multiple calls would be clearer.
- `info`/`log`/`warning`/`error`: shortest ASON string or object. Detect common cwd/model/fork/rebase/reset/compact messages and render compact objects when possible.
- Multimodal `user`: compact object such as `{ text: '...', images: 2 }`; put original image paths/blob ids in the comment even if the line exceeds 80 columns.

Time formatting:

- Use local timezone.
- Same local day: `12:34`.
- Other day: date plus time, e.g. `22 May 12:34`.
- Reuse `src/utils/time.ts` formatting logic; do not add one-off date formatting in rebase code. If the exact needed helper is missing, add it there.

## Parsing and editing flow

- Parser reads only non-comment text before `#`.
- Parser reads `cmd`, `id`, `type`, and `<content>`.
- `pick`: keep the line.
- `drop` or deleted line: omit the line.
- `edit`: open a second editor with raw editable content for that entry.
- `abort`: cancel when used as the first token of any non-comment line, or when the file is empty.
- For editable `user`/`assistant`, in-place edits to the ASON string change the future model context.
- For long/truncated editable entries, require `edit`; reject in-place edits to truncated content.
- For protected entries, reject `edit` and reject content changes. They can only be picked, dropped, or reordered.
- If validation fails, reopen the todo with an explanatory comment at the top.

## Client/server protocol

1. Client sends `rebase-start { sessionId, requestId }`.
2. Server checks the session is idle.
3. Server snapshots `{ baseLog, baseHash, rows }` and sends the rebase payload to the initiating client.
4. Client runs `$EDITOR` locally in `/tmp/hal-rebase-<session>-<request>.txt`.
5. Client runs any per-entry edit files locally.
6. Client sends final plan/edits:

```ason
{ type: 'rebase-apply', baseLog: 'history.asonl', baseHash: '...', rows: [...], order: [...], edits: {...} }
```

7. Server rejects if the log/hash changed.
8. Server validates IDs/actions/content edit permissions.
9. Server writes `history2.asonl`, updates session meta, emits `history-rebased`.

## Validation

- Session must still be idle at apply time.
- Base log/hash must still match.
- Unknown id: reject.
- Duplicate id: reject.
- Unknown command: reject.
- Edited protected entry: reject.
- `edit` on protected entry: reject.
- In-place edit of truncated content: reject; use `edit`.
- Tool batch must stay whole internally.
- Resulting history must parse.
- `toProviderMessages(..., { prune: false })` must not throw.

## Design notes

- This is intentionally sharp: the user gets maximum power and responsibility.
- We are editing future model context, not replaying events.
- Filesystem state, cwd reality, tool effects, and old logs are not rewritten.
- Auditability is not the goal, but old history remains naturally because the new context moves to a new log file.
