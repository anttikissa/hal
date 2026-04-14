# /rebase plan

Date: 2026-04-14

## Goal

Add `/rebase`: a git-interactive-rebase-like way to rewrite a session's logical history so we can:

- reorder or drop past items
- replay from an earlier point with a different history shape
- run experiments without hand-editing `history.asonl`

Plan 1.0 is **order editing + deletion only**. No payload editing yet.

## Ground truth today

The current code already gives us a good base, but it also exposes a few gaps:

- History is already flat and append-only in `history.asonl`.
	- Types include `user`, `thinking`, `assistant`, `tool_call`, `tool_result`, `info`, `session`, `reset`, `compact`, `forked_from`, `input_history`.
- Fork replay is logical, not copied.
	- `sessions.loadAllHistory()` follows `forked_from` and prepends the parent prefix before the fork timestamp.
- Blob lookup is ancestry-based.
	- `blob.readBlobFromChain()` follows the `forked_from` chain to find inherited blobs.
- Provider message reconstruction is semantic, not line-by-line.
	- `apiMessages.toProviderMessages()` groups flat history back into assistant/user turns.
	- `info` entries are only sent to the model when `visibility === 'next-user'`.
- `/model` and `/cd` are **not** persisted as history entries today.
	- They mutate session meta and emit UI info, but replaying history alone does not reconstruct them.

That last point matters a lot: if `/rebase` is meant for "what if I replay from here?", then model/cwd changes must become part of durable history semantics, not just live session state.

## Recommended UX for 1.0

Do **not** expose raw `history.asonl` for editing.

Instead, `/rebase` should generate a temporary **todo file** plus a machine-readable sidecar manifest:

- The user edits a small, git-like todo file.
- The manifest stores the real payload for each item.
- The todo file is descriptive and safe.
- Reordering/deleting is easy.
- Multiline message editing can be added later without redesigning the storage format.

Example sketch:

```txt
# Hal /rebase
# Reorder with cut/paste. Delete by removing a line or changing pick -> drop.
# Items are immutable in v1. Full payload lives in the sidecar manifest.

pick T01 user-turn   [14 Apr 06:00] "Hi"
pick T02 user-turn   [14 Apr 06:10] "Make and add plan to docs/..."
pick N03 info        [14 Apr 06:10] "cwd: /old -> /new"
drop N04 info        [14 Apr 06:10] "Model set to Claude ..."
```

Optional richer comments after each line are fine, for example:

```txt
pick T07 tool-turn   [14 Apr 06:12] read src/server/runtime.ts
# tool_call read { path: 'src/server/runtime.ts', ... }
# tool_result blob 00ab12-xyz
```

This is close to git interactive rebase, but descriptive enough that the user does not need to read raw ASON.

## What is reorderable in 1.0

Raw ASONL lines are too low-level. They have invariants:

- `tool_call` and `tool_result` must stay paired
- signed `thinking` blocks should not be split from their assistant turn
- `forked_from` is structural, not a normal message
- `next-user` info is semantically attached to a later user turn

So 1.0 should reorder **units**, not arbitrary lines.

Recommended units:

- `user-turn`
	- One user message
	- Any model-facing `session`/`info(next-user)` events that should apply to that user message
	- All following assistant/thinking/tool activity up to the next user message or structural boundary
- `info`
	- Pure UI-only notices that are not sent to the model
- `fork`
	- The fork marker / inherited-prefix boundary
- `reset` / `compact`
	- Structural boundaries; probably pinned, not freely movable

This keeps tool pairs intact and makes signed thinking blocks a non-issue in v1.

## What should stay immutable in 1.0

The todo file should allow only:

- reorder
- drop

It should not allow:

- editing signed thinking blocks
- splitting tool calls from tool results
- editing tool payload JSON
- editing blob references
- editing `forked_from`
- editing timestamps

If a line is syntactically present but changed beyond command/order, apply should fail with a clear error.

## `/model` and `/cd` need durable history semantics first

This feature is much better if `/model` and `/cd` become real history events.

Recommended rule:

- Persist a `session` entry for semantic state changes.
- Keep an `info` entry for UI display if useful.
- When converting history to provider messages, inject a short model-facing note into the next user turn.

Examples:

```ason
{ type: 'session', action: 'model-change', old: 'openai/gpt-5.4', new: 'anthropic/claude-sonnet-4.5', ts: '...' }
{ type: 'session', action: 'cwd-change', old: '/a', new: '/b', ts: '...' }
```

Then `apiMessages.toProviderMessages()` can turn those into something like:

```txt
[model changed: openai/gpt-5.4 -> anthropic/claude-sonnet-4.5]
[cwd changed: /a -> /b]
```

at the next user message.

For `/rebase`, this means:

- pure UI info messages can be reordered or dropped as standalone notes
- model/cwd changes are **not** just loose notes; they belong to the following `user-turn`

That is the safest answer to "can we reorder info messages too?"

## Fork handling

We must never mutate the parent session.

There are two cases:

### 1. Rebase only child-local history

If the edited units all live after the fork boundary, we can keep using the existing `forked_from` model.

### 2. Rebase touches inherited parent history

Current fork storage cannot express "same parent, but reordered/deleted inherited prefix".

Recommended plan:

- Materialize the inherited prefix into the child session directory.
- Write a child-local snapshot log for the rebased history.
- Preserve blob lookup ancestry explicitly so old blobs still resolve.

This likely needs a small lineage sidecar, because today blob lookup only knows how to follow `forked_from`.

Example direction:

```ason
{
	blobSources: ['04-child', '04-parent']
	materializedFrom: { sessionId: '04-parent', beforeTs: '2026-04-14T06:10:00.000Z' }
}
```

Then history ancestry and blob ancestry are no longer forced to be the same thing.

That decoupling is probably the key enabling change for rebasing forked tabs safely.

## Apply model

Recommended apply flow:

1. Load the logical history for the current session.
2. Build safe reorderable units.
3. Write:
	- editable todo file
	- sidecar manifest with exact payloads, hashes, and unit boundaries
4. Open `$EDITOR`.
5. On save, parse todo commands.
6. Validate:
	- no unknown unit IDs
	- no duplicated required units
	- structural units still valid
	- no forbidden edits
	- current session history still matches the manifest base hash
7. Write the rewritten history.
8. Reload replay/live state and show a summary.

## Tail-only edits and prompt cache reuse

Yes, **tail-only rebases should preserve the best chance of cheap cached prefix tokens**, but we should describe this carefully.

What we know from current code:

- Anthropic prompt caching is used.
- Cache breakpoints are placed near the tail, not on every message.

So the practical rule should be:

- if the prefix before the first changed unit is byte-for-byte identical in provider message form, keep it identical
- only rewrite from the first changed unit onward
- expect the unchanged prefix to remain as cache-friendly as the provider allows
- do not promise exact savings, because provider cache behavior is provider-specific

So the docs/UI should say something like:

> Tail-only rebase preserves the unchanged prefix exactly. This usually keeps prompt-cache benefits for that prefix, but exact savings depend on provider cache semantics.

That is honest and still useful.

## Where to write the rewritten history

There are two product choices.

### Option A: rewrite current session in place

Pros:

- closest to git interactive rebase
- tab identity stays the same

Cons:

- easier to surprise the user
- harder to compare old vs new result

### Option B: create a rebased fork by default

Pros:

- safer for experiments
- perfect for "what if I replay from here?"
- original tab stays untouched

Cons:

- slightly less like git
- more tabs/session dirs

**Recommendation:**

- `/rebase` defaults to creating a rebased fork/tab
- `/rebase --in-place` is explicit and guarded by confirmation

That matches the user's first stated use case: testing alternate histories.

## Future editing of message text

Not for 1.0, but the todo format should leave room for it.

Recommended future rule set:

- editable:
	- `user`
	- plain `assistant`
	- maybe UI-only `info`
- not editable:
	- signed `thinking`
	- tool calls/results
	- structural entries (`forked_from`, `reset`, `compact`)

For multiline editing, do not cram payload editing into one todo line.

Better future options:

- `edit <id>` opens a separate scratch file for that item
- or the rebase file references external payload files
- or a TUI inspector/editor for one selected item

The important point is: **v1 should not choose a format that makes multiline edits painful later**.

## Suggested command surface

Possible minimal surface:

- `/rebase`
	- open interactive editor for full logical history
- `/rebase --from <unit-id>`
	- preselect only the suffix from a point onward
- `/rebase --in-place`
	- rewrite the current session instead of creating a rebased fork
- `/rebase --abort`
	- discard pending todo/manifest

Nice later additions:

- `/replay-from <unit-id>`
- `/rebase --continue`
- `/rebase --onto <session-id>`
- `/rebase --autosquash-info`

## Implementation phases

### Phase 0: semantic prerequisites

- Persist `/model` and `/cd` as `session` history entries.
- Define which history events are model-facing vs UI-only.
- Make blob ancestry explicit enough for materialized fork rebases.

### Phase 1: safe unit builder

- Convert logical history into reorderable units.
- Add validation for tool pairing, structural boundaries, and signed thinking containment.

### Phase 2: todo + apply

- Generate todo file + sidecar manifest.
- Parse reordered/dropped units.
- Apply rewritten history to a new rebased session by default.

### Phase 3: in-place rewrite mode

- Add guarded in-place rewrite.
- Add backup/rollback metadata for the old history.

### Phase 4: replay workflows

- Add fast "replay from here" flows.
- Add better UX for comparing original vs rebased result.

## Testing

Need tests for at least:

- unit building from flat history
- rejecting a todo that edits immutable payload text
- tool pair preservation
- signed thinking staying attached to its turn
- `/model` and `/cd` becoming durable history semantics
- info visibility rules after rebase
- tail-only rebase preserving identical prefix message encoding
- rebasing a fork without mutating the parent
- rebasing inherited fork history via materialization
- creating a rebased fork tab vs in-place mode

## Bottom line

Recommended 1.0:

- `/rebase` edits a descriptive todo file, not raw `history.asonl`
- reorder/drop only
- operate on safe units, not arbitrary lines
- persist `/model` and `/cd` as real history semantics first
- default to creating a rebased fork/tab
- materialize inherited prefix only when a fork rebase touches parent history

That gives a safe first version that is already useful for replay experiments, while leaving room for real message editing later.
