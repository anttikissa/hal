# Rebase: rewriting a session's history

The user's tool for taking control of a session's context: drop what
no longer matters, fix a prompt, replace a huge tool output with a
note. In the spirit of `git rebase -i` and the old Hal's /rebase (a
todo list of rows, one action each), but informative: every row says
what it is and what it costs.

## Rows

One row per prompt, assistant text, thinking block, tool call with
its result, command with its output, and compact/reset boundary
(task 01d). Columns: action, #n, time, kind, tokens, summary.
Rows carry what they hold: `2 images`, `blob 1.4 MB`, `output cut`,
`pruned`. A row inside a turn that the rules forbid dropping on its
own (e.g. a thinking block a provider must see with its signed
answer) is shown, but its drop applies to the whole group and says so.

## Actions

- keep (pick): unchanged. The default.
- drop: gone from provider input and the transcript. A tool call and
  its result drop together.
- edit: new text. Prompts, assistant text and tool results; a tool
  result's new text replaces its output (and any blob) for the model.
- queue: only last, only in the terminal file: prompts sent right after.
- abort, or an empty file: nothing happens.

## Durable form

Append-only: one `rebase` record { base, drop, edit }. Nothing on
disk is rewritten, so undo is cheap and the raw file stays the audit
trail. Record numbers stay stable; a link to a dropped #n says so.

## Terminal file

```
# Rebase 157-gut · 412 rows · 183.4k tokens → 61.2k after · cache rebuilds from #120
# keep/drop/edit/queue; delete a line = drop; empty file or 'abort' cancels
# edit opens the full text next; queue lines go last and are sent after
keep  #12   08:01  prompt     1.2k  Implement the night run tasks…
drop  #13   08:02  bash       41.0k $ ./test   (blob 160 kB)
edit  #57   09:14  prompt     0.3k  Fix the status table
```

Deleting a line drops it, as in git. Lines may be reordered only
among queue lines; reordering history is refused (the line says so).

## Web

An overlay with the same rows, a size bar per row, tap to expand,
keep/drop/edit per row, range selection and two quick actions (drop
tool output over N tokens; drop everything before a row). The footer
always shows now → after and where the cache rebuilds. Apply, Cancel.

## Cost of a rebase

A change at #n invalidates the provider cache from #n on: the next
request pays full input for everything after it. Both views say so
before applying.
