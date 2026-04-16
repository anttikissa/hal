# LOC-reduction plan for `src/cli/blocks.ts`

## Current size

- `bun cloc src/cli/blocks.ts`: **689 LOC**
- Target: **under 500 LOC**
- Required reduction in this file: **at least 190 LOC**

## Review verdict

The original plan had the right diagnosis, but it mixed two different goals:

1. **real LOC reduction**, and
2. **ownership cleanup / moving code elsewhere**.

For this file, those are not the same thing.

After reviewing the current code and nearby usages, the under-500 path should prioritize:

- deletes,
- dedupe that removes code from **multiple** files at once, and
- simplifications that stay mostly inside `src/cli/blocks.ts`.

Several original ideas were boundary moves that are likely **flat or up** in repo cloc on the first pass:

- moving grouped rendering to `src/client/render-history.ts`
- moving blob hydration to another module
- adding a higher-level `md.render(...)` API just so this file gets smaller
- moving fork-parent ownership logic out of `historyToBlocks()` without also deleting equivalent logic elsewhere
- introducing a broad shared projector layer

Those may still be good architecture work later, but they are **not** the best first move if the goal is “get this file under 500 with flat-or-down repo cloc”.

## What is actually mixed together today

`src/cli/blocks.ts` currently owns several real responsibilities:

- block type definitions for persisted-history blocks and live UI blocks
- history projection (`HistoryEntry[] -> Block[]`)
- fork-parent dimming and parent-blob ownership during projection
- async blob hydration for `tool` and `thinking` blocks
- terminal text sanitizing / ANSI stripping
- tool-specific presentation policy
	- titles
	- inline command extraction
	- extra detail bodies
	- output summarizers / diff rendering
- low-level rendering primitives
	- headers
	- background fill
	- clipping
	- brick wrapping for grouped notices
- markdown/plain-text/tool-body rendering
- grouped notice rendering

That is why it is large.

## Nearby usages/tests reviewed

Reviewed before tightening this plan:

- `src/cli/blocks.ts`
- `src/cli/blocks.test.ts`
- `src/client/render-history.ts`
- `src/client.ts`
- `src/session/replay.ts`
- `src/session/entry.ts`
- `src/server/sessions.ts`
- `src/cli/md.ts`
- `src/utils/strings.ts`

Grounded findings from current code:

- `spinnerChar()` and `formatElapsed()` currently have **no callers** outside `src/cli/blocks.ts`.
- `perf` is imported in `src/cli/blocks.ts` and currently appears **unused**.
- `renderBlockGroup()` has exactly **one** caller: `src/client/render-history.ts`.
- That caller groups only **single-line `info` blocks** via `infoGroupKey()`.
	- So `renderBlockGroup()` being typed for `info | warning | error` is broader than current behavior.
- `historyToBlocks()` is only called from `src/client.ts` and `src/cli/blocks.test.ts`.
- `src/session/entry.ts::userText()` currently keeps only text parts.
	- `src/cli/blocks.ts` and `src/session/replay.ts` each carry their own richer image-placeholder logic.
- `src/cli/blocks.ts::applyToolBlob()` and `src/session/replay.ts::extractToolOutput()` both know the tool-blob shape.

## Current test baseline

`./test` was run before review. The repo is **not currently green**.

Current unrelated failures observed:

- `src/utils/tail-file.test.ts`
- `src/tools/search-caps.test.ts`
- `tests/ipc.test.ts`
- `tests/main.test.ts`
- `tests/tabs.test.ts`

That matters for execution: the reducer should still run `./test` after each step, but should judge success against the existing baseline unless the change actually touches those areas.

## Best reduction opportunities

Below, estimates are primarily for **`src/cli/blocks.ts` LOC** and secondarily for repo-total direction.

### 1) Cheap deletes and simplifications first

These are the best opening moves because they are real deletions, not code relocation.

#### 1.1 Delete dead exports and dead imports

Delete if grep still confirms zero callers:

- `SPINNER_CHARS`
- `spinnerChar()`
- `formatElapsed()`
- export entries for those helpers
- unused `perf` import

Why this is grounded:

- repo grep shows no external call sites for the spinner helpers
- `perf` is imported but not referenced in this file

Estimated impact:

- **-15 to -20 LOC**

Risk / tests:

- very low
- rerun grep before deletion
- run `./test`

#### 1.2 Remove tiny helpers and aliases only when they produce a real net delete

Good candidates:

- fold `capitalize()` into `humanizeName()`
- inline `parseTs()` at call sites if it reads shorter
- replace `countLines()` with `toLines()` from `src/utils/strings.ts`
- remove trivial local aliases like `const cw = cols` / `const indent = ''` if that shortens the function instead of just rewriting it sideways

This should stay disciplined: only do the change if the file actually gets shorter.

Estimated impact:

- **-6 to -15 LOC**

Risk / tests:

- low
- watch trailing-newline semantics when replacing `countLines()`

#### 1.3 Simplify grouped-info wrapping, but do not over-generalize it

Current facts:

- `render-history.ts` only groups one-line `info` blocks
- `renderBlockGroup()` currently pretends to support `warning` and `error` too
- `wrapBricks()` is custom logic only for this grouped-info path

Best simplification path:

- first try replacing `wrapBricks()` with `wordWrap(bricks.join(' '), cols)`
- narrow grouped rendering to what the caller actually uses today: grouped **info** notices
- avoid spending time on a broader “notice framework” here

Estimated impact:

- **-15 to -30 LOC**

Risk / tests:

- moderate
- grouped rendering may shift slightly
- watch render tests plus any grouped-info snapshots/expectations

---

### 2) Cross-file dedupe that should reduce repo cloc, not just move it

These are good because they can delete code from `blocks.ts` **and** another file.

#### 2.1 Unify rich user-entry text extraction in `sessionEntry`

Today there are three variants:

- `src/session/entry.ts::userText()` — text parts only
- local `userText()` in `src/cli/blocks.ts` — preserves image placeholders / original path
- `userContentText()` in `src/session/replay.ts` — similar but not identical placeholder policy

Best shape:

- extend `sessionEntry.userText()` with an explicit mode/options object for image placeholders
- default behavior must preserve the current callers that want **text-only** behavior
- replace both local helper copies in:
	- `src/cli/blocks.ts`
	- `src/session/replay.ts`

Important nuance:

- `buildCompactionContext()` and `inputHistoryFromEntries()` already use `sessionEntry.userText()` and likely want the old text-centric default
- so this should be a true replacement, not a behavior change hidden behind the same default

Estimated impact:

- in `blocks.ts`: **-8 to -12 LOC**
- repo total: **down** if replay-local duplication is removed too

Risk / tests:

- moderate
- watch image-path preservation test in `src/cli/blocks.test.ts`
- watch `src/session/replay.test.ts`
- watch `src/session/entry` callers that rely on current default behavior

#### 2.2 Share tool/thinking blob extraction with replay

Today the codebase duplicates blob-shape knowledge:

- `applyToolBlob()` in `blocks.ts`
- `applyThinkingBlob()` in `blocks.ts`
- `extractToolOutput()` in `src/session/replay.ts`

Best shape:

- add a small helper in session/blob-ish code for:
	- thinking text extraction
	- tool input extraction
	- tool output extraction/status
- then delete duplicate parsing branches in both files

Important constraint:

- do this only if it truly **replaces** the current duplicated parsing logic
- not if it adds a wrapper layer while leaving most of the old code in place

Estimated impact:

- in `blocks.ts`: **-8 to -15 LOC**
- repo total: **down** if replay also shrinks

Risk / tests:

- moderate
- watch blob-loading behavior and malformed-blob soft-failure behavior

---

### 3) Strongest local win: collapse scattered tool presentation dispatch into one table

This is the highest-confidence big reduction still grounded in current code.

#### 3.1 Replace multiple dispatch points with one `toolSpecs` table

Today tool-specific behavior is split across:

- `toolTitle()`
- `toolCommand()`
- `toolDetails()`
- `toolFormatters`
- `formatToolOutput()`
- edit-specific helpers used by those dispatch points

That means the same tool name gets re-dispatched several times.

Better shape:

```ts
const toolSpecs = {
	bash: {
		title(input) { ... },
		command(input) { ... },
	},
	edit: {
		title(input) { ... },
		details(input) { ... },
		summarize(output) { ... },
	},
	read: {
		title(input) { ... },
		summarize(output) { ... },
	},
	spawn_agent: {
		title(input) { ... },
		details(input) { ... },
	},
}
```

Then `blockContent()` and `blockLabel()` do one lookup, not several separate dispatches.

Estimated impact:

- **-45 to -70 LOC**

Risk / tests:

- moderate
- watch all tool-rendering tests, especially:
	- `edit`
	- `spawn_agent`
	- `bash`
	- `read`
	- `grep`
	- `glob`

#### 3.2 Use generic helpers for boring tools inside that table

Most tools are simple templates:

- `Read ${path}`
- `Write ${path}`
- `Read URL ${url}`
- `Google ${query}`
- `Glob ${pattern} in ${path}`
- `Grep ${pattern} in ${path}`
- `Ls ${path}`

Keep special cases only where the code actually differs:

- `bash`
- `edit`
- `spawn_agent`
- maybe `analyze_history`

Estimated impact:

- usually included in 3.1
- extra standalone gain: **-5 to -10 LOC**

#### 3.3 Keep edit diff parsing local on the first pass

`blocks.ts` does know a lot about edit output shape, but moving that logic into the edit tool is **not** the best first LOC move.

Reason:

- it spreads work into production code outside this file
- it could easily become “split and add glue” rather than a net deletion

So for the one-pass reducer:

- keep the diff parser local unless a concrete edit-side change clearly deletes more code than it adds

This is a deliberate constraint to keep the reduction honest.

---

### 4) Type/model cleanup that stays local

#### 4.1 Add shared base types for repeated fields

This is grounded: the union repeats the same fields across many arms.

Best shape:

```ts
interface BlockBase {
	ts?: number
	dimmed?: boolean
	renderVersion?: number
}

interface BlobRef {
	blobId?: string
	sessionId?: string
	blobLoaded?: boolean
}
```

Then compose block arms from intersections instead of repeating the same field list.

Estimated impact:

- **-20 to -35 LOC**

Risk / tests:

- low to moderate
- mostly type churn
- watch inline block creation in `client.ts` / `server/sessions.ts`

#### 4.2 Prefer static maps for label/color lookups before attempting a full notice collapse

`blockColors()` and parts of `blockLabel()` repeat simple static cases.

A good low-risk reduction is:

- use tables for fixed label/color cases
- keep special logic only for:
	- `user`
	- `assistant`
	- `thinking`
	- `tool`

This is a better first move than collapsing all notice variants into a single `notice` union arm.

Estimated impact:

- **-8 to -15 LOC**

Risk / tests:

- low

#### 4.3 Defer full `notice`-type collapse unless still above target

The original plan pushed hard on turning:

- `info`
- `warning`
- `error`
- `startup`
- `fork`

into something like:

```ts
{ type: 'notice', tone: 'info' | 'warning' | 'error' | 'startup' | 'fork', text: string }
```

That can reduce `blocks.ts`, but it also touches:

- `client.ts`
- `server/sessions.ts`
- tests
- any inline block construction

So it is **not** the best first bet.

Recommendation:

- try base types + static lookup tables first
- keep full notice collapse as a last-resort step only if the cheaper wins still leave the file above 500

Estimated impact if needed:

- in `blocks.ts`: **-25 to -45 LOC**
- repo total: uncertain, likely still down but much less cleanly than the local-first wins

Risk / tests:

- moderate
- broader type churn than it first appears

---

### 5) Things to avoid in the first reduction pass

These are the main ideas from the original plan that are currently more about ownership than net deletion.

#### 5.1 Do not move grouped rendering to `render-history.ts` just to shrink this file

Current reality:

- `renderBlockGroup()` is only used from `render-history.ts`
- but moving it there mostly just relocates lines

That is fine architecture work later, but it is not a strong one-pass LOC reduction strategy.

#### 5.2 Do not move blob hydration out of `blocks.ts` unless replay shares the new helper and old code disappears

A pure move from `blocks.ts` to `session/blob.ts` is roughly repo-flat.

Only do it if the new home also replaces duplicate replay parsing/hydration logic.

#### 5.3 Do not introduce a broad shared “history projector” layer on the first pass

That is too easy to turn into abstraction glue.

The focused shared helpers are enough for now:

- richer `sessionEntry.userText(...)`
- shared tool/thinking blob extraction

#### 5.4 Do not add `md.render(...)` unless cloc proves a net win

A markdown helper may still be worth doing, but only if the repo actually gets smaller.

For the first reduction pass, the safer assumption is:

- new API surface in `md.ts` is probably a boundary improvement, not an automatic cloc win

---

## Recommended execution sequence

Aim: get `src/cli/blocks.ts` under 500 while keeping repo cloc flat or down.

### Pass 1: obvious deletions

1. Delete dead spinner helpers and exports.
2. Delete unused `perf` import.
3. Trim tiny wrappers/aliases only where they produce a real line-count drop.
4. Run `./test`.
5. Run `bun cloc src/cli/blocks.ts`.

Expected impact:

- roughly **-20 to -35 LOC**

### Pass 2: grouped-info simplification

6. Replace `wrapBricks()` with simpler `wordWrap` logic if tests stay acceptable.
7. Narrow grouped rendering to actual current usage: grouped one-line `info` blocks.
8. Run `./test`.
9. Run `bun cloc src/cli/blocks.ts`.

Expected cumulative impact:

- roughly **-35 to -60 LOC** total

### Pass 3: real cross-file dedupe

10. Extend `sessionEntry.userText()` to cover rich placeholder modes.
11. Delete local user-text helper(s) from `blocks.ts` and `replay.ts`.
12. Add shared tool/thinking blob extraction helper.
13. Delete duplicate blob parsing branches from `blocks.ts` and `replay.ts`.
14. Run `./test`.
15. Run `bun cloc src/cli/blocks.ts`.

Expected cumulative impact:

- `blocks.ts`: roughly **-50 to -85 LOC** total
- repo total: should also move **down** a bit

### Pass 4: take the big local win

16. Replace scattered tool dispatch with one `toolSpecs` table.
17. Keep edit diff parsing local unless a measured alternative is smaller.
18. Run `./test`.
19. Run `bun cloc src/cli/blocks.ts`.

Expected cumulative impact:

- `blocks.ts`: roughly **-95 to -155 LOC** total

### Pass 5: type cleanup to close the gap

20. Add shared base types.
21. Replace static label/color switches with maps where possible.
22. Run `./test`.
23. Run `bun cloc src/cli/blocks.ts`.

Expected cumulative impact:

- `blocks.ts`: roughly **-125 to -190 LOC** total

### Pass 6: only if still above 500

24. Choose **one** of these, not several architectural moves at once:
	- full notice collapse, **or**
	- a measured markdown-helper extraction that is provably net-down in repo cloc
25. Run `./test`.
26. Run `bun cloc src/cli/blocks.ts`.

## Is under 500 reachable in one pass?

**Yes, but not from cheap wins alone.**

Grounded expectation:

- deletes + tiny simplifications are not enough
- deletes + grouped-info simplification + shared helpers are still probably not enough by themselves
- the file likely needs **both**:
	- the `toolSpecs` consolidation, and
	- one meaningful structural cleanup (`BlockBase`/`BlobRef` and/or a last-resort notice collapse)

So the most believable one-pass path is:

1. dead code/import cleanup
2. grouped-info simplification
3. shared user/blob helpers that delete duplicate logic in replay too
4. one-table tool presentation
5. base block types + static maps
6. only if still short of target, full notice collapse

That sequence is much more likely to produce a **real** under-500 result than starting with ownership moves.

## Strongest execution path

If I were executing this reduction now, I would do exactly this order:

1. delete dead spinner helpers + dead import
2. simplify grouped-info rendering (`wrapBricks`, info-only generality)
3. unify rich user text helper and shared blob extraction with replay
4. collapse tool title/command/details/output dispatch into one `toolSpecs` table
5. add `BlockBase` / `BlobRef`
6. replace static label/color switches with maps
7. only if still needed, do a full notice collapse

That path keeps the early steps cheap, keeps repo cloc honest, and postpones the highest-churn type changes until the remaining gap is known.

## Risks / tests to watch

### Highest-risk behavior

- edit diff preview formatting
- grouped info rendering
- fork-parent dimming and parent-session blob ownership
- tool-output sanitization of ANSI/control bytes
- markdown tables / code fences / blank-line trimming
- header width safety near the terminal last column

### Tests to watch first

- `src/cli/blocks.test.ts`
- `tests/render.test.ts`
- `tests/render-single-pass.test.ts`
- `tests/render-width.test.ts`
- `tests/render-fullscreen.test.ts`
- `src/client-startup.test.ts`
- `src/session/replay.test.ts`

### Greps to rerun while reducing

- `spinnerChar(`
- `formatElapsed(`
- `renderBlockGroup(`
- `historyToBlocks(`
- `type: 'startup'`
- `type: 'fork'`
- `type: 'warning'`
- `type: 'error'`

## Final verdict

The plan is now tightened toward **real LOC reduction**.

It is ready for execution **if** the implementer follows the local-first order above and treats architectural moves as optional last steps, not primary reducers.