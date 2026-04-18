# LOC reduction plan for `src/runtime/commands.ts`

## 1. Current measured size

Measured on the current live branch, not from old notes:

- `bun cloc src/runtime/commands.ts`: **656 LOC**
- `bun cloc` repo total: **12,782 LOC**

Current files still above 500 LOC:

- `src/client.ts` — 954
- `src/runtime/commands.ts` — 656
- `src/server/runtime.ts` — 580
- `src/cli/prompt.ts` — 515

So this pass needs about **157 LOC out of `commands.ts`** while keeping total repo LOC flat or down.

## 2. What is actually making this file big today

On the current file, the biggest buckets are:

- **Help/catalog text**: `277-389` — large hand-written `/help` tree and command list
- **`/tabs` rendering**: `142-263` plus the handler wrapper at `440-443`
- **`/config` subsystem**: `585-733` — path traversal, parsing, temp writes, persistent writes
- **Command dispatch plumbing**: handler table, aliases, vestigial `emitInfo`, repeated `{ handled: true }`

This file is still acting as both:

- a command router, and
- a mini config tool, help generator, tab renderer, and some session-resolution utilities.

That mixed ownership is the real reason it is stuck at 656.

## 3. Why the earlier round missed or drifted for this file

The existing round-1 plan in this doc is now partly stale.

Main drift points from current code:

1. **It over-counted already-spent wins.**
	- The old plan proposed deduplicating closed-session resume lookup with `server/runtime.ts`.
	- That is **already done** on the live branch: `commands.ts` uses `sessionStore.resolveResumeTarget(...)`, and `server/runtime.ts` also points at the sessions helper.
	- So that idea no longer buys much or anything for `commands.ts`.

2. **It included repo-cleanup ideas that barely shrink `commands.ts`.**
	- Example: deleting dead `rename` IPC support from `protocol.ts` / `client.ts` / `server/runtime.ts` may be worth doing repo-wide.
	- But it does **almost nothing** for the target file itself.
	- Good side cleanup, weak primary path for getting `commands.ts` under 500.

3. **It treated `/tabs` simplification as optional late cleanup.**
	- On the current file, `/tabs` is still one of the biggest self-contained chunks.
	- If config/help reductions come in smaller than hoped, `/tabs` is the most reliable remaining lever.
	- So on the current branch it should be in the main path, not only a last-ditch fallback.

4. **It assumed metadata-sharing would automatically pay off enough.**
	- A command metadata table is still good.
	- But by itself it is unlikely to save the full 157 LOC needed.
	- It needs to be paired with either `/config` dedupe or `/tabs` scope trimming.

5. **Its repo-total context is outdated.**
	- Old neighboring plans reference totals around **13,500 LOC**.
	- Current repo total is **12,782 LOC**.
	- The pass should be judged against the live branch, not older totals.

Bottom line: round 1 drifted because the branch moved under it, one major dedupe already landed elsewhere, and the old ordering was too architecture-first and not aggressive enough about the remaining biggest local buckets.

## 4. Plausible LOC reductions from current state

Impacts below are rough **`commands.ts` deltas first**, with repo-wide notes where they matter.

### A. Move generic `/config` tree logic into `src/config.ts`

Current `commands.ts` owns:

- snapshot building
- path splitting
- nested reads
- nested writes
- parent-object creation
- value parsing
- temp-vs-persistent write branching

That is command-agnostic config logic and also overlaps with `src/cli/completion.ts`, which still walks config trees itself.

**Likely impact**

- `commands.ts`: **-60 to -95 LOC**
- repo total: **flat to -30 LOC** if `completion.ts` switches to shared config helpers and the new `config.ts` API stays lean

**Best shape**

- `config.snapshot()`
- `config.listPaths()`
- `config.readPath(path)`
- `config.parseValue(path, raw)`
- `config.writePath(path, value, { temp })`

**Why this is real reduction**

This is not fake file splitting if the logic becomes shared and deletes duplicate traversal from completion.

### B. Replace hand-written `/help` branches with one command spec table

Today help is duplicated across:

- handler names
- top-level `/help` list strings
- `detailedHelp()` special cases
- `src/cli/completion.ts` command-argument classification

A single command spec can hold:

- `name`
- `usage`
- `summary`
- `detail?`
- `argKind?`
- `hiddenFromHelp?`
- `handler`
- `aliases?`

**Likely impact**

- `commands.ts`: **-30 to -50 LOC**
- repo total: **-10 to -35 LOC** if completion consumes the same metadata

**Important current nuance**

The big savings come only if most help text becomes generated. If the detailed prose is copied almost verbatim into metadata blobs, the win will be much smaller.

### C. Simplify `/tabs`

Current `/tabs` does all of this:

- loads history for every displayed session
- scans backward for timestamps
- extracts recent user prompt previews
- formats relative age
- formats start/end stamps
- sorts by newest activity

This is both a LOC hotspot and a runtime-cost hotspot.

Three plausible trims:

#### C1. Drop prompt previews, keep timestamps/order

Delete:

- `userEntryText()`
- `previewText()`
- `recentPromptPreviews()`
- related render lines

**Likely impact**

- `commands.ts`: **-25 to -40 LOC**
- repo total: **down**

#### C2. Use cheaper timestamps instead of scanning full history

Prefer:

- `loadLive(...).updatedAt` for open sessions when available
- `closedAt ?? createdAt` for closed sessions

Then stop walking every history file just to sort rows.

**Likely impact**

- `commands.ts`: **-20 to -35 LOC**
- runtime behavior: faster and less I/O heavy

#### C3. Show open-tab order instead of newest-activity order

This is the biggest cut, but most behavior-changing.

**Likely impact**

- `commands.ts`: **-40 to -60 LOC**

**Recommendation**

For one-pass under-500 odds, **C1 or C1+C2** is the sweet spot.

### D. Remove vestigial `emitInfo` plumbing

`CommandHandler` still receives `emitInfo`, `executeCommand()` still threads it through, and `server/runtime.ts` still passes it in.

In current `commands.ts`, it is not doing real work. The `/usage` alias only forwards it.

**Likely impact**

- `commands.ts`: **-8 to -15 LOC**
- repo total: **-10 to -20 LOC**

This is a good easy win and also helps `server/runtime.ts`, which is another >500 file.

### E. Collapse trivial IPC command handlers

The following are mostly “append command + return handled result”:

- `/clear`
- `/fork`
- `/compact`
- `/resume`
- parts of `/open`
- `/move`

A tiny helper can remove repeated object literals and repeated `handled: true` scaffolding.

**Likely impact**

- `commands.ts`: **-8 to -15 LOC**

Do this only if the helper is smaller than the repetition.

### F. Trim optional command surface if still needed

These are real cuts, but each has UX cost.

#### F1. Delete `/usage` alias

- `commands.ts`: **-4 to -8 LOC**

#### F2. Delete `/eval` slash command

There is already a first-class eval tool.

- `commands.ts`: **-15 to -25 LOC**

#### F3. Fold `/mem` into `/status`

- `commands.ts`: **-10 to -18 LOC**

#### F4. Drop rich `/cd` reporting and only print the new cwd

- `commands.ts`: **-6 to -12 LOC**

These are backup levers, not the best first move.

### G. Tiny cleanups

- direct alias handlers instead of wrappers: **-3 to -8 LOC**
- inline one-use helpers: **-3 to -8 LOC**
- `ok()` / `fail()` helpers if genuinely smaller: **-3 to -8 LOC**

Useful only after larger cuts.

## 5. Strongest execution path, ordered by net LOC reduction

This ordering is based on **expected net size reduction**, not just safety.

### Step 1 — Pull generic config tree operations into `src/config.ts`, then reuse them from completion

Why first:

- biggest remaining local chunk
- real cross-file dedupe
- likely repo-flat or repo-down, not wrapper churn

Expected result:

- `commands.ts`: roughly **656 → 560-595**

Execution notes:

- keep the `/config` command as a thin adapter
- immediately delete `completion.ts`’s local config tree walker in the same pass
- avoid moving command-specific parsing like `parseConfigArgs()` unless it truly shrinks

### Step 2 — Replace `/help` text branches with one command spec table used by completion too

Why second:

- second-largest structural duplication
- lets `commandNames()` and completion stop rebuilding parallel command catalogs

Expected result:

- `commands.ts`: roughly **another -30 to -50 LOC**
- running total target: about **510-565**

Execution notes:

- keep only the few genuinely special long help entries, probably `config`, `send`, and maybe `move`
- generate the rest from compact specs

### Step 3 — Simplify `/tabs` enough to remove the expensive preview/history machinery

Why third, not last:

- it is the cleanest remaining guaranteed lever
- it improves both LOC and runtime behavior
- it is more reliable than hoping micro-cleanups add up

Expected result:

- `commands.ts`: **another -25 to -40 LOC**
- likely lands safely around **470-535** depending on Step 1 and 2 results

Preferred trim order:

1. drop prompt previews
2. stop scanning full history for timestamps
3. only if still necessary, simplify ordering semantics

### Step 4 — Remove `emitInfo` plumbing and other small wrappers

Why fourth:

- easy cleanup
- helps both `commands.ts` and `server/runtime.ts`
- nice finishing margin if the file is hovering near 500

Expected result:

- `commands.ts`: **another -10-ish LOC**

### Step 5 — Only if still above 500, cut optional command surface

Best fallback order by deletion efficiency:

1. `/eval`
2. `/mem` folded into `/status`
3. `/usage`
4. `/cd` rich reporting

## 6. Overlap and conflict risks with other remaining >500 files

### `src/server/runtime.ts` — high overlap

This is the biggest adjacent risk.

Shared-touch areas:

- `commands.executeCommand(...)` signature if `emitInfo` is removed
- dead IPC command cleanup such as `rename`
- any command metadata export shape if runtime imports it later

Important current fact:

- do **not** budget more savings for resume-target dedupe here; that win already moved into `src/server/sessions.ts`

Best coordination rule:

- if both files are being reduced around the same time, do the shared API changes once, then measure both again

### `src/client.ts` — moderate overlap

Mostly via repo-wide cleanup, not direct command logic.

Potential shared touch:

- dead `rename` IPC path cleanup

This can reduce repo total, but it should not be mistaken for a primary `commands.ts` reduction lever.

### `src/cli/prompt.ts` — low overlap

Almost no direct conflict with this pass.

### `src/cli/completion.ts` — not >500, but directly coupled

This file is small, but it is the most important neighbor for a clean pass because:

- it duplicates command argument knowledge
- it duplicates config-path walking

If the pass changes `/help` or `/config` ownership without updating completion at the same time, the reduction will be weaker and drift will remain.

## 7. Exact tests to watch

Primary unit tests:

- `src/runtime/commands.test.ts`
- `src/cli/completion.test.ts`
- `src/config.test.ts`
- `src/server/runtime.test.ts`

Important integration tests from the nearby set the user named:

- `tests/tabs.test.ts`
	- especially tab placement and move behavior
	- especially:
		- `fork inserts the new tab next to its parent`
		- `open after inserts a plain new tab next to the target tab`
		- `move reorders tabs to the requested position`

Behavior-sensitive assertions likely to need special attention:

- `/tabs` ordering and preview output in `src/runtime/commands.test.ts`
- `/config` temp writes and bare-string parsing
- `/help config` and `/help model` exact content
- `/send` target resolution by number, id, and case-insensitive name
- `/move` message text and clamping behavior
- `/system` output if command metadata/help refactors accidentally touch command registration order

## 8. Explicit verdict

**Yes — under 500 is reachable in one pass from the current state.**

But on the current branch, the realistic one-pass path is:

1. **config helper dedupe**
2. **metadata-driven help/catalog**
3. **some `/tabs` simplification**
4. **emitInfo/wrapper cleanup for margin**

I would **not** bet on getting from 656 to under 500 by config + help cleanup alone unless those changes are unusually lean.

So the honest verdict is:

- **reachable in one pass:** yes
- **reachable without touching `/tabs` at all:** maybe, but not the strongest bet from current code
- **best practical path:** thin `/config`, generated `/help`, then trim `/tabs` prompt-preview/history machinery
