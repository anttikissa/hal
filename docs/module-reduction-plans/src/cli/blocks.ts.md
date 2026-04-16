# LOC-reduction plan for `src/cli/blocks.ts`

## Current size

- `bun cloc src/cli/blocks.ts`: **689 LOC**
- Target: **under 500 LOC**
- Required reduction in this file: **at least 190 LOC**

## What is mixed together today

`src/cli/blocks.ts` is doing several jobs at once:

- block type definitions for both persisted history blocks and live UI blocks
- history-entry projection (`HistoryEntry[] -> Block[]`)
- fork-parent dimming / blob-owner selection during projection
- async blob hydration for tool + thinking blocks
- terminal-text sanitizing / ANSI stripping
- tool-specific presentation policy
	- titles
	- inline command extraction
	- extra detail bodies
	- output summarizers / diff rendering
- low-level rendering primitives
	- header construction
	- bg fill behavior
	- width clipping
	- brick wrapping for grouped notices
- markdown/plain-text/tool-body rendering
- grouped notice rendering (`renderBlockGroup`)
- two exported utility functions that currently look dead (`spinnerChar`, `formatElapsed`)

That responsibility pile is the real reason the file is large. It is not just “render a block”.

## Nearby usages/tests reviewed

Reviewed before planning:

- `src/cli/blocks.test.ts`
- `src/client/render-history.ts`
- `src/client.ts` (`historyToBlocks`, blob loading, tab load path)
- `src/client/cli.ts` (`blocks.config.tabWidth` only)
- `src/cli/md.ts`
- `src/utils/strings.ts`
- `src/session/replay.ts`
- `src/session/entry.ts`
- `src/server/sessions.ts` live block creation
- `src/cli/colors.ts`

## Plausible reduction ideas

Below, estimates are for **`src/cli/blocks.ts` bun cloc** impact unless noted otherwise.

### 1) Delete dead or near-dead code

#### 1.1 Remove unused exported spinner helpers

- `SPINNER_CHARS`
- `spinnerChar()`
- `formatElapsed()`
- export entries

Evidence:

- repo grep found no call sites outside `src/cli/blocks.ts`
- no tests reference them

Estimated impact:

- **-14 to -18 LOC**

Risk / tests:

- low risk
- run full suite; nothing targeted today covers these exports, so grep again before removal

#### 1.2 Delete tiny wrappers that no longer earn their keep

Candidates:

- `capitalize()` + fold into `humanizeName()`
- maybe `parseTs()` if call sites become clearer inline
- maybe `NoticeBlock` alias if replaced with `Extract<Block, ...>` or a shared base type

Estimated impact:

- **-4 to -8 LOC**

Risk / tests:

- trivial

#### 1.3 Replace `wrapBricks()` with plain `wordWrap(bricks.join(' '), cols)` if behavior matches

Current helper is a full custom wrapper for grouped `[info] [info] [info]` bricks.

Plausible simplification:

- build `const text = bricks.join(' ')`
- `wordWrap(text, cols)`
- keep special handling only if a failing test proves brick-boundary behavior matters

Estimated impact:

- **-18 to -25 LOC**

Risk / tests:

- moderate: grouped notice wrapping could shift slightly
- watch render-history tests and grouped info rendering manually via existing render tests

---

### 2) Dedupe with existing helpers / existing modules

#### 2.1 Stop re-implementing user-entry text extraction here

Today:

- `src/cli/blocks.ts` has local `userText()`
- `src/session/entry.ts` has `sessionEntry.userText()`
- `src/session/replay.ts` has another user-text flavor

Best shape:

- extend `sessionEntry` with one helper that can render user parts for UI/replay
- options could control image placeholders:
	- text-only
	- `[image]`
	- `[originalFile]`
	- blob fallback if needed

Then delete local `userText()` from `blocks.ts`, and likely also the replay-local version.

Estimated impact:

- in `blocks.ts`: **-8 to -12 LOC**
- repo-total opportunity: **-12 to -20 LOC** across `blocks.ts` + `session/replay.ts`

Risk / tests:

- watch `src/cli/blocks.test.ts` image-path preservation test
- watch `src/session/entry.test.ts`
- watch replay-related tests if helper semantics change

#### 2.2 Share tool-blob parsing with replay instead of parsing the same blob shape twice

Today there is duplicated knowledge of tool blob structure:

- `applyToolBlob()` in `blocks.ts`
- `extractToolOutput()` in `src/session/replay.ts`

Plausible shared home:

- `src/session/blob.ts` or `src/session/entry.ts`
- helpers like:
	- `toolBlobInput(blob)`
	- `toolBlobOutput(blob)`
	- `thinkingBlobText(blob)`

That lets `blocks.ts` stop knowing blob object shape in multiple places.

Estimated impact:

- in `blocks.ts`: **-8 to -15 LOC**
- repo-total opportunity: **-12 to -20 LOC** if replay also shrinks

Risk / tests:

- watch tool rendering tests, replay tests, blob-loading tests
- make sure malformed blobs still fail soft

#### 2.3 Merge duplicate line-splitting/counting helpers with existing string helpers

Candidates:

- `countLines()` could lean on `strings.toLines()`
- similar duplication already exists in `src/tools/hashline.ts`

This is not a huge blocks-only win, but it is a real cross-file cleanup.

Estimated impact:

- in `blocks.ts`: **-2 to -4 LOC**
- repo-total opportunity: **-5 to -10 LOC** if hashline duplication is cleaned too

Risk / tests:

- low
- only watch trailing-newline semantics

---

### 3) Simplify the block data model

#### 3.1 Introduce shared base types instead of repeating `ts`, `dimmed`, `renderVersion`, blob refs, etc.

The union currently repeats the same fields on nearly every arm.

Likely replacement:

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

Then build union arms from intersections.

Estimated impact:

- **-20 to -35 LOC**

Risk / tests:

- low to moderate
- mostly type-only, but touches many references
- watch `src/client.ts` and startup tests where live blocks are created inline

#### 3.2 Collapse notice-like block variants into one shape

Best single structural simplification in the file.

Today separate types exist for:

- `info`
- `warning`
- `error`
- `startup`
- `fork`

They differ mostly by:

- label
- colors
- whether errors may carry blob refs

Possible replacement:

```ts
{ type: 'notice', tone: 'info' | 'warning' | 'error' | 'startup' | 'fork', text: string, ... }
```

Why this helps:

- shrinks the block union
- removes repeated switch arms in `markdownSourceText`
- removes repeated switch arms in `blockColors`
- removes repeated switch arms in `blockLabel`
- simplifies `blockContent` type checks
- simplifies `renderBlockGroup` typing
- simplifies `historyToBlocks` mapping for info/fork/startup-ish events

Estimated impact:

- **-35 to -60 LOC** in `blocks.ts`

Risk / tests:

- moderate
- touches `src/client.ts`, `src/client/render-history.ts`, tests, and any inline block construction
- verify grouped info behavior still only groups plain info notices, not every tone

#### 3.3 Revisit whether `renderVersion` belongs on every block arm

If `renderVersion` is universal state, put it on one base interface only.

Estimated impact:

- mostly included in 3.1
- standalone additional gain: **-4 to -8 LOC**

Risk / tests:

- low

---

### 4) Simplify history projection (`historyToBlocks`)

#### 4.1 Replace the long `if/continue` ladder with a `switch`

Current flow is repetitive:

- compute `dimmed`
- compute `blobOwner`
- branch on entry type
- repeatedly `result.push({ ... })`
- repeatedly `continue`

A `switch (entry.type)` will be shorter and easier to scan.

Estimated impact:

- **-10 to -18 LOC**

Risk / tests:

- low

#### 4.2 Factor repeated block-construction boilerplate into small local helpers

Examples:

- `const ts = entry.ts ? Date.parse(entry.ts) : undefined`
- a small `push()` helper that merges common fields
- a model-resolving helper for assistant/thinking

This is only worth doing if it removes real repeated code, not if it adds abstraction glue.

Estimated impact:

- **-8 to -15 LOC**

Risk / tests:

- low

#### 4.3 Move fork-parent ownership concerns out of the renderer module

`historyToBlocks()` currently also decides:

- which entries are dimmed because they came from a fork parent
- which session owns blobs for parent history

That is session/history projection policy, not rendering policy.

Possible owner:

- `src/client.ts` when loading tab history
- or a shared session projection helper alongside replay

This mostly improves boundaries. LOC win inside `blocks.ts` is modest unless combined with 4.1/4.2.

Estimated impact:

- **-8 to -15 LOC** in `blocks.ts`
- repo total likely flat, not down, unless shared with replay logic

Risk / tests:

- moderate because forked history behavior is subtle
- watch fork rendering tests and blob-loading-from-parent behavior

---

### 5) Simplify tool-specific presentation logic

This is the biggest “real logic” reduction area.

#### 5.1 Replace the multiple dispatch systems with one `toolSpecs` table

Today tool-specific behavior is split across:

- `toolTitle()`
- `toolCommand()`
- `toolDetails()`
- `toolFormatters`
- `formatToolOutput()`
- special `editLineRange()` / `formatEditDetails()` helpers

That means the same tool name is dispatched in multiple places.

Better shape:

```ts
const toolSpecs = {
	bash: { title(input), command(input) },
	read: { title(input), summarize(output) },
	edit: { title(input), details(input), summarize(output) },
	spawn_agent: { title(input), details(input) },
	...
}
```

Benefits:

- one lookup instead of several switches/ifs
- easier to see per-tool policy in one place
- removes wrapper functions that only re-dispatch

Estimated impact:

- **-40 to -70 LOC**

Risk / tests:

- moderate
- watch all tool-rendering tests, especially `edit`, `spawn_agent`, `bash`, `read`, `grep`, `glob`

#### 5.2 Use generic title helpers for the boring tools

Several cases are simple templates:

- `Read ${path}`
- `Write ${path}`
- `Read URL ${url}`
- `Google ${query}`
- `Glob ${pattern} in ${path}`
- `Grep ${pattern} in ${path}`

A couple of tiny helpers can compress those without losing readability.

Estimated impact:

- **-8 to -15 LOC**

Risk / tests:

- low

#### 5.3 Shrink edit-specific logic by moving more responsibility to the edit tool layer

`blocks.ts` currently knows too much about edit output shape:

- `--- before` / `+++ after` parsing
- common-prefix/common-suffix trimming
- footer preservation
- header range presentation
- extra detail rendering for hashline refs

A better long-term split is:

- `tools/edit.ts` produces a more display-ready structured result or concise preview text
- `blocks.ts` renders it generically

This could be a major simplifier, but it spreads into production logic outside this module.

Estimated impact:

- in `blocks.ts`: **-25 to -45 LOC**
- repo total: **maybe flat**, maybe slightly down if edit-side code already computes similar data

Risk / tests:

- moderate to high
- edit tests + blocks edit-rendering tests are critical

#### 5.4 Generalize “show some input args in the body” instead of per-tool one-offs

Right now:

- `spawn_agent` dumps full ASON
- `edit` dumps a small selected subset
- most tools dump nothing

A generic helper such as `detailObjectForTool(name, input)` could centralize that policy and remove one-off wrapper code.

Estimated impact:

- **-8 to -15 LOC**

Risk / tests:

- low to moderate
- watch exact expected strings in tests

---

### 6) Simplify rendering by pushing existing markdown logic harder

#### 6.1 Add a higher-level markdown renderer in `src/cli/md.ts`

`blocks.ts` currently manually orchestrates:

- `md.mdSpans()`
- `md.mdInline()`
- `md.mdTable()`
- `hardWrap()` for code
- blank-line trimming
- `resolveMarkers()`

That is a lot of markdown rendering glue inside the block renderer.

Plausible extraction:

- add `md.render(text, cols, opts?)` or `md.renderBlocks(text, cols, opts?)`
- keep low-level span helpers for tests and specialized callers
- let `blocks.ts` call one function for markdown-capable blocks

Estimated impact:

- in `blocks.ts`: **-25 to -40 LOC**
- repo total likely: **-10 to -20 LOC net** depending on `md.ts` growth

Risk / tests:

- moderate
- watch `src/cli/md.test.ts`, `src/cli/blocks.test.ts`, render tests

#### 6.2 Move grouped-notice rendering next to history grouping code

`renderBlockGroup()` is only used from `src/client/render-history.ts`, and the grouping rules already live there.

That is a good ownership move:

- `render-history.ts` already decides when groups exist
- `blocks.ts` should ideally render one block, not history-specific group layouts

Estimated impact:

- **-20 to -30 LOC** in `blocks.ts`
- repo total roughly flat

Risk / tests:

- low to moderate
- grouped-info rendering tests need to stay green

#### 6.3 Replace the repeated static label/color switches with tables

`blockColors()` and `blockLabel()` each repeat the same static notice variants.

If notice variants stay separate, use tables for the static cases and only special-case:

- user
- assistant
- thinking
- tool

Estimated impact:

- **-8 to -15 LOC**

Risk / tests:

- low

---

### 7) Boundary/ownership changes that also help other large files

#### 7.1 Unify “history entry -> UI block” projection with replay/session logic

There is overlap between:

- `src/cli/blocks.ts::historyToBlocks()`
- `src/session/replay.ts::replayEntries()`
- `src/session/entry.ts` helpers
- live block creation in `src/server/sessions.ts` and `src/client.ts`

A small shared projector/helper layer could reduce repeated knowledge about:

- user text extraction
- current model carry-forward
- info/error/fork mapping
- blob-field population

Potential repo impact:

- reduces `src/cli/blocks.ts`
- may also reduce `src/session/replay.ts`
- may simplify parts of `src/client.ts`

Estimated impact:

- in `blocks.ts`: **-15 to -30 LOC**
- repo total: likely **down** if replay also shrinks

Risk / tests:

- moderate because this touches history semantics

#### 7.2 Consider whether blob hydration belongs in a session/blob module instead of the renderer

`loadBlobs()` is async I/O plus parsing policy, not rendering.

Possible destination:

- `src/session/blob.ts`
- or a small `src/session/block-blobs.ts`

This is mostly a responsibility fix. Good for `blocks.ts` size, but repo-total impact is neutral unless blob parsing gets deduped with replay.

Estimated impact:

- in `blocks.ts`: **-20 to -35 LOC** if moved out entirely
- repo total: flat unless dedupe also happens

Risk / tests:

- moderate
- watch startup blob load tests and fork-parent blob ownership behavior

## Recommended execution sequence

Aim: get `src/cli/blocks.ts` under 500 LOC while keeping total repo cloc flat or down.

### Pass 1: guaranteed cheap wins

1. Remove dead spinner helpers if grep still shows zero callers.
2. Fold tiny wrappers (`capitalize`, maybe `parseTs`, alias cleanup).
3. Try replacing `wrapBricks()` with `wordWrap(bricks.join(' '), cols)` if tests stay green.
4. Re-run `./test` and `bun cloc src/cli/blocks.ts`.

Expected cumulative impact:

- roughly **-20 to -45 LOC**

### Pass 2: dedupe with existing modules

5. Extend `sessionEntry` for richer user-text rendering; delete local user-text logic here.
6. Share tool-blob parsing with `session/replay.ts` / `session/blob.ts`.
7. Clean up any now-redundant line-count/splitting helpers.

Expected cumulative impact:

- roughly **-15 to -30 LOC** in `blocks.ts`
- repo total should also go down a bit

### Pass 3: attack the biggest logic duplication in this file

8. Replace the scattered tool title/command/details/output dispatch with one `toolSpecs` table.
9. Only after that, decide whether edit rendering can be simplified further or moved closer to the edit tool.

Expected cumulative impact:

- roughly **-40 to -70 LOC**

### Pass 4: simplify the block model / notice handling

10. First try shared base interfaces.
11. If still above target, collapse notice-like block variants into one `notice` shape.

Expected cumulative impact:

- base types only: **-20 to -35 LOC**
- full notice collapse: **-35 to -60 LOC**

### Pass 5: finish with boundary cleanup if still needed

12. Move grouped notice rendering next to `render-history.ts`.
13. If needed, move blob hydration out of the renderer module.
14. Optionally add `md.render(...)` to delete markdown glue code here.

Expected cumulative impact:

- **-20 to -40 LOC** in this file, depending on which pieces move

## Best path to under 500 in one pass

Yes, under 500 looks reachable in one practical pass.

Most believable bundle:

- remove dead spinner helpers: **-15**
- simplify `wrapBricks`: **-20**
- dedupe user/blob helpers with existing modules: **-20**
- unify tool presentation into one spec table: **-50**
- shared base block types: **-25**
- move grouped rendering to `render-history.ts` or collapse notice variants: **-30 to -45**

That totals about **-160 to -175 LOC** before counting smaller wrapper cleanups.

Add either:

- notice collapse, or
- markdown/rendering glue reduction, or
- edit-output simplification

and the file should cross **below 500 LOC**.

## Risks / tests to watch closely

### Highest-risk behavior

- edit diff preview formatting
- grouped info rendering (`renderBlockGroup` path)
- fork-parent dimming and parent-session blob ownership
- tool-output sanitization of ANSI/control bytes
- markdown tables / code fences / blank-line trimming
- header width safety near terminal last column

### Tests to watch first

- `src/cli/blocks.test.ts`
- `tests/render.test.ts`
- `tests/render-single-pass.test.ts`
- `tests/render-width.test.ts`
- `tests/render-fullscreen.test.ts`
- `src/client-startup.test.ts` (blob loading / startup rendering interactions)
- `src/session/replay.test.ts`

### Greps to re-run during reduction

- `spinnerChar(` and `formatElapsed(` before deleting
- `type: 'startup'`, `type: 'fork'`, `type: 'warning'`, `type: 'error'` if collapsing notices
- `historyToBlocks(` call sites before moving ownership
- `renderBlockGroup(` before relocating group rendering

## Opportunities that would also reduce other large files

- shared user-entry rendering helper: reduces `src/session/replay.ts` too
- shared tool-blob parsing helper: reduces `src/session/replay.ts` too
- shared history projection layer: could reduce both `src/cli/blocks.ts` and `src/session/replay.ts`, maybe also some inline block creation in `src/client.ts`
- moving grouped notice rendering to `src/client/render-history.ts` makes ownership cleaner there and trims `blocks.ts`
- higher-level markdown render helper in `src/cli/md.ts` could make that module more reusable and shrink future renderers

## Recommendation

If the goal is **under 500 with flat-or-down repo cloc**, I would do this order:

1. dead export removal
2. `wrapBricks` simplification
3. dedupe with `sessionEntry` / blob helpers
4. unify tool presentation into one spec table
5. shared base block types
6. if still needed, either collapse notice variants or move group rendering out of `blocks.ts`

That sequence keeps the early changes cheap and testable, and saves the more invasive type/ownership change for only if needed.