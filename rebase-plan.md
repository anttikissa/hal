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
  - `tool` rows
  - `thinking` blocks (content edits ignored)
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

## Tool pair model

A `tool` line in the rebase todo represents one matched `tool_call` / `tool_result` pair.

Providers can emit simultaneous tool calls in batches, so the implementation must first recover those pairings from history order.

Batch construction:

1. Start a batch at a `tool_call` or stray `tool_result`.
2. Keep reading contiguous tool entries.
3. Track outstanding `tool_call.toolId`s.
4. End the batch at the first point where every call in the batch has a matching result.
5. If a new `tool_call` appears before earlier calls are complete, keep it in the same batch.
6. If a non-tool entry or EOF appears while calls are still outstanding, keep the incomplete batch as protected rows and mark them as interrupted in the comment.

Within each batch, pair calls and results by `toolId`. Render one `tool` row per pair. If the original batch result order is unusual, normalize it by call order when writing the rebased log.

Incomplete calls render as protected `tool` rows with only the original `tool_call` and an `interrupted` comment.

Examples:

```text
tool_call A, tool_result A                         -> one tool row: A
tool_call A, tool_call B, tool_result A, result B  -> two adjacent tool rows: A, B
tool_call A, result A, tool_call B, result B       -> two adjacent tool rows: A, B
tool_call A, tool_call B, result B, result A       -> two adjacent tool rows: A, B
```

Dropping or moving a `tool` row preserves that row's original call and result content. A lone `tool` row writes back as `tool_call`, then `tool_result`. Contiguous `tool` rows write back as all calls first and then all matching results in the visible row order. For example:

```text
original history: C1 C2 R1 R2
visible rows:     T1 T2
rebased history:  C1 C2 R1 R2

original history: C1 C2 R1 R2
visible rows:     T2 T1
rebased history:  C2 C1 R2 R1
```

This is valid because provider context requires each tool result to correspond to an earlier tool call; it does not require preserving the old batch ordering when the user intentionally reorders tool rows. Tool content is display-only; it is not editable.

## IDs

- Every rebase todo line has an id.
- Use an existing entry/blob id when available.
- Otherwise generate ids in the existing timestamp-plus-random format.
- A `tool` row gets one row id and maps to one `tool_call` plus its matching `tool_result`, or to one interrupted `tool_call` when no result exists.
- Server apply uses `{ baseLog, baseHash, row id -> original entries }`; it never trusts the displayed content to identify entries.
- When writing the new log, preserve existing ids and write generated ids for entries that did not previously have one if the history type supports it. If adding ids to all entry types is part of implementation, update `HistoryEntry` accordingly.

## Storage

- Rebase the current log, not always `history.asonl`.
- Keep the current log unchanged except append a marker:

```ason
{ type: 'rebased_to', log: 'history3.asonl', ts: '...' }
```

- Write the chosen result to the next log name (`history2.asonl`, `history3.asonl`, etc.).
- Set `session.ason.currentLog` to the new log name.
- The new log may start with a marker:

```ason
{ type: 'rebased_from', log: 'history2.asonl', ts: '...' }
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
- Keep history terminology exactly: `thinking`, `assistant`, `user`, `cwd`, `model`, `info`, etc.
- `tool_call` + `tool_result` are consolidated into a single derived `tool` line with content summarizing the call and result.
- Prefer 80 columns, but allow longer lines when useful, especially image paths.
- Align `#` comments to the same screen column when possible, using `visLen()` for width.
- Parser reads `cmd`, `id`, and `type` first.
- For non-truncated rows, parser then parses exactly one ASON value for `<content>`; `#` inside a quoted string such as `'for example #1'` is ordinary content.
- Anything after the parsed ASON value may be treated as an ignored comment if it starts with `#` after optional whitespace.
- For truncated rows, the server snapshot says `truncated: true`; parser does not call `ason.parse()` on `<content>`, and only uses `cmd`, `id`, ordering, and the generated line prefix for validation.
- `<content>` is `ason.stringify(..., 'short')`, truncated if needed so the comment can align.
- For editable `user` and `assistant` entries, non-truncated `<content>` is simply an ASON string.
- For protected entries, `<content>` is the shortest useful ASON representation of the state.

Example:

```text
# Rebase 04-xur history2.asonl -> history3.asonl
# Commands: pick, edit, drop. Delete a line to drop it. Reorder freely.
# Abort: empty file, or any non-comment line whose command is abort.
# Comments after parsed content are ignored. Edits to thinking blocks are ignored.

pick 0002n5-123 user 'hi'                                        # 21 May 22:10
pick 0003n5-x1z assistant 'hello there'                          # 11:11
pick 0007n5-0z3 user 'hello world, heres a pic [/tmp/hal/imag... # 11:10; image /tmp/hal/images/94q8k6.png
pick 0007n5-x0z thinking 'I think I should respond with a sho... # 11:11; signed; xhigh; 59 lines, 5.9kB
pick 000823-xx8 assistant "What's up?"                           # 11:12
pick 000824-aa1 assistant 'for example #1'                        # 11:12
pick 00095x-129 input_history '/cd~/.hal'                        # 11:13
pick 001912-fj2 cwd ['~', '~/.hal']                              # 11:13; next-user
pick 002123-xux user "check file.txt;\n\nHere's my reasoning ... # 11:13; truncated; 14 lines, 1.5kB
pick 003031-xiz tool { read: { path: './file.txt' } }            # 11:14; 2.5kB
pick 003032-ab1 tool { edit: { path: './file2.txt' }, lines: ... # 11:14; lines 3-4 -> 3-6
pick 003403-xyx assistant 'I read file.txt and edited the oth... # 11:14; truncated
```


## Content rendering

Renderer should show as much useful information as possible without making the todo noisy.

All outputs are truncated to as many screen columns as are needed so that the `#` character starts at column 66 exactly when possible. Use `visLen()` for width and truncate with `...`.

- `user`: ASON string of the text, attachment images listed in comment if any.
- `assistant`: ASON string of the text.
- Long `user`/`assistant`: truncated display string; snapshot marks `truncated: true`; in comment: if more than 1 line, line count; if more than 1kB, show size in kB.
- `thinking`: ASON string of the text; in comment: `signed`; thinking level like `xhigh`; length info as in long user/assistant. Edits to this content are ignored on apply.
- `tool`: object keyed by tool name when compact. Each `tool_call`/`tool_result` pair renders as one `tool` line; simultaneous batches may render as multiple adjacent `tool` lines.
- `cwd`/`model`: render as compact ASON values from their real history entries.
- `info`/`log`/`warning`/`error`: shortest ASON string or object. Some older cwd/model/fork/rebase/reset/compact state may still appear as info-style entries; render those compactly when detected.
- Multimodal `user`: just include text and include image path in comment.

Time formatting:

- Use local timezone.
- Same local day: `12:34`.
- Other day: date plus time, e.g. `22 May 12:34`.
- Reuse `src/utils/time.ts` formatting logic, the same one that is used in all rendered tool/user/assistant blocks

## Parsing and editing flow

- Parser reads `cmd`, `id`, and `type` first.
- For non-truncated rows, parser parses exactly one ASON value after `type`; comments are recognized only after that value, so `#` inside strings is safe.
- For truncated rows, parser does not parse content. The server snapshot already knows the full original entry and that the rendered line was truncated.
- `p` or `pick`: keep the line. For editable, non-truncated `user`/`assistant` rows, if parsed content differs from the snapshot content, apply it as an in-place edit.
- For truncated `pick` rows, re-render the submitted row with the submitted command and compare the visible prefix through the comment column against the generated prefix. If it changed, return user to the editor and inject `# Instead of editing in-place, use 'edit' to edit truncated entry:` before the offending line.
- `d` or `drop` or deleted line: omit the line.
- `e` or `edit`: open a second editor with raw editable content for that entry. For truncated editable entries, this is the only way to change content.
- `a` or `abort`: cancel when used as the first token of any non-comment line, or when the file is empty.
- The shorthands are hidden features for git compatibility.
- Edits to `thinking` rows are ignored; always preserve the original thinking entry content.
- For other protected entries, reject `edit` and reject content changes. They can only be picked, dropped, or reordered.
- If validation fails, reopen the todo with an explanatory comment at the top.

## Client/server protocol

1. Client sends `rebase-start { sessionId, requestId }`.
2. Server checks the session is idle.
3. Server snapshots `{ baseLog, baseHash, rows }` and sends the rebase payload to the initiating client.
4. Client runs `$EDITOR` locally in `/tmp/hal-rebase-<session>-<request>.txt`.
5. Client runs any per-entry edit files locally.
6. Client sends final plan/edits:

```ason
{ type: 'rebase-apply', baseLog: 'history2.asonl', baseHash: '...', rows: [...], order: [...], edits: {...} }
```

7. Server rejects if the log/hash changed.
8. Server validates IDs/actions/content edit permissions.
9. Server writes the next history log, updates session meta, emits `history-rebased`.

## Validation

- Session must still be idle at apply time.
- Base log/hash must still match.
- Unknown id: reject.
- Duplicate id: reject.
- Unknown command: reject.
- Edited protected entry other than `thinking`: reject.
- `edit` on protected entry other than `thinking`: reject.
- In-place edit of truncated content: reject; use `edit`.
- Each `tool` row must keep its call/result pair whole; when contiguous tool rows are written back, emit calls first and then results in row order.
- Resulting history must parse.
- `toProviderMessages(..., { prune: false })` must not throw.

## Design notes

- This is intentionally sharp: the user gets maximum power and responsibility.
- We are editing future model context, not replaying events.
- Filesystem state, cwd reality, tool effects, and old logs are not rewritten.
- Auditability is not the goal, but old history remains naturally because the new context moves to a new log file.
