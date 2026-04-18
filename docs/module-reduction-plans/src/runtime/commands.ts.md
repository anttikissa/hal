# LOC-reduction review for `src/runtime/commands.ts`

## Current measured size

Measured on the live branch during this review:

- `bun cloc src/runtime/commands.ts` → **656 LOC**
- `bun cloc` repo total → **12,782 LOC**

Current `src/` files still above 500 LOC from the same run:

- `src/client.ts` — 954
- `src/runtime/commands.ts` — 656
- `src/server/runtime.ts` — 580
- `src/cli/prompt.ts` — 515

So this file still needs about **157 LOC removed** to get under 500.

## What I reviewed

I checked the current branch state against:

- `docs/module-reduction-plans/src/runtime/commands.ts.md`
- `src/runtime/commands.ts`
- `src/runtime/commands.test.ts`
- `src/server/runtime.ts`
- `src/cli/completion.ts`
- `src/config.ts`
- `tests/tabs.test.ts`

## Review verdict

**Verdict: the old direction was partly right, but the strongest plan needed tightening.**

What still holds:

- `commands.ts` is too big because it still owns several unrelated subsystems:
	- slash-command dispatch
	- `/tabs` rendering
	- `/help` text/catalog generation
	- `/config` tree read/write/parse helpers
- there is still real duplication with `src/cli/completion.ts`
- under-500 is still reachable from current state

What was stale or too optimistic:

1. **Resume-target dedupe is already spent.**
	- `src/server/runtime.ts` already uses `sessionStore.resolveResumeTarget(...)`.
	- `commands.ts` still has its own closed-session lookup wrapper, but the big cross-file dedupe win described in older notes is no longer ahead of us.
	- Treat this as a small cleanup at most, not a main lever.

2. **The old `/tabs` timestamp shortcut was over-optimistic.**
	- The previous plan talked about using `loadLive(...).updatedAt`.
	- On the current branch, `SessionLive` in `src/server/sessions.ts` does **not** officially define `updatedAt`.
	- Tests stub it loosely, but it is not a clean current production contract to build the plan around.
	- So do **not** count a cheap “use live updatedAt everywhere” win unless execution first proves and formalizes that field.

3. **Config extraction is only a real win if duplication is deleted immediately.**
	- `commands.ts` has config tree walking/parsing/writing logic.
	- `completion.ts` separately walks config trees for path completion.
	- Moving code into `src/config.ts` is only worth doing if it deletes both copies in the same pass.
	- Splitting out helpers while leaving both old call sites mostly intact is fake progress.

4. **Metadata-driven help is good, but only if it replaces parallel lists.**
	- Today command knowledge is spread across:
		- handler registration in `commands.ts`
		- top-level `/help` list text
		- `detailedHelp()` branches
		- `COMMAND_ARGS` in `src/cli/completion.ts`
	- A command spec table is a real win only if those lists are actually deleted, not mirrored.

## What is still making the file big today

The biggest remaining local buckets are:

1. **`/tabs` rendering and helpers**
	- full-history loads per row
	- prompt-preview extraction
	- timestamp scanning
	- extra formatting helpers
	- this is both a LOC hotspot and a runtime-I/O hotspot

2. **Hand-written `/help` catalog + details**
	- large static list in `/help`
	- separate `detailedHelp()` branches
	- separate completion metadata elsewhere

3. **`/config` tree operations**
	- path splitting
	- nested reads
	- nested writes
	- object creation
	- value parsing
	- temp vs persistent write branching

4. **Small but real dispatch leftovers**
	- unused `emitInfo` threading
	- tiny alias wrappers
	- repeated IPC append + handled boilerplate

## Strongest execution path, ordered by net LOC reduction

This order is based on **real deletion first**. The goal is to reduce repo LOC, not just move code around.

### Step 1 — Simplify `/tabs` aggressively and honestly

This is the strongest first move on the current branch.

Preferred execution shape:

- delete prompt previews entirely
	- remove `userEntryText()`
	- remove `previewText()`
	- remove `recentPromptPreviews()`
	- remove the extra preview output lines
- stop loading full history for every displayed row
- stop scanning history just to compute a sort key
- simplify the command to something cheaper that matches data already available

**Best practical target behavior**

- `/tabs` shows **open-tab order** for open tabs
- `/tabs --all` shows open tabs first, then closed sessions by `closedAt ?? createdAt`
- keep:
	- current-tab marker
	- tab numbers for open tabs
	- `closed` marker for closed sessions
	- basic created/closed timestamps
- stop claiming “newest activity first” unless execution keeps a real activity source

**Likely impact**

- `commands.ts`: **-50 to -80 LOC**
- repo total: **down**
- runtime behavior: less disk I/O and less history parsing

**Why this should be first**

- biggest self-contained deletion available
- reduces both LOC and runtime cost
- avoids a risky helper-extraction pass as the first step

### Step 2 — Replace help/catalog duplication with one command spec table

Keep the specs in or next to `commands.ts`, but only if they replace existing parallel knowledge.

The spec should cover only what is genuinely shared, for example:

- `name`
- `summary`
- `usage`
- `detail?`
- `argKind?`
- `handler`
- `aliases?`
- `showInHelp?`

Then use that one source for:

- `commandNames()`
- top-level `/help` listing
- detailed `/help <cmd>` where possible
- completion argument classification in `src/cli/completion.ts`

**Important constraint**

- keep only the few long custom help entries that truly need bespoke prose, probably `config`, maybe `send`, maybe `move`
- do **not** replace one hand-written list with another equally large metadata blob

**Likely impact**

- `commands.ts`: **-25 to -45 LOC**
- repo total: **-10 to -30 LOC** if `completion.ts` deletes `COMMAND_ARGS` and stops rebuilding its own catalog

### Step 3 — Only then move shared config tree helpers into `src/config.ts`

This is still valuable, but it is **third**, not first, because it can become split-and-glue if done loosely.

Good target scope:

- `config.snapshot()`
- `config.listPaths()`
- `config.readPath(path)`
- `config.parseValue(path, raw)`
- `config.writePath(path, value, { temp })`

Keep in `commands.ts` only:

- `/config` argument parsing
- `/config` help text / user-facing messages
- command-specific usage handling

Delete in the same pass:

- `commands.ts` tree walkers and write helpers
- `completion.ts` local `listConfigPaths()` tree walker

**Likely impact**

- `commands.ts`: **-40 to -70 LOC**
- repo total: **flat to -20 LOC** if both duplicate walkers disappear immediately

**Why this is not step 1**

- it is easier to fool ourselves here with “shared helpers” that mostly just move lines into `src/config.ts`
- the earlier two steps are more obviously real deletion

### Step 4 — Remove `emitInfo` plumbing and tiny wrapper churn

Current reality:

- `executeCommand(..., emitInfo)` still threads an emitter through the whole runtime path
- real command logic does not use it in any meaningful way
- `/usage` just forwards it to `/status`

Do this only after the bigger cuts above.

Expected cleanup:

- remove `emitInfo` from the handler type
- remove it from `executeCommand()`
- simplify the `server/runtime.ts` call site
- collapse tiny alias wrappers only if the helper is actually smaller

**Likely impact**

- `commands.ts`: **-8 to -15 LOC**
- repo total: **-10 to -20 LOC**

### Step 5 — If still above 500, use command-surface cuts instead of more architecture churn

Fallback order should prefer **real deletion**, not more frameworking.

Best fallback order from current state:

1. delete `/usage` alias
2. delete `/eval` slash command if the tool is accepted as the canonical path
3. fold `/mem` into `/status` only if needed

Why this order:

- `/usage` is tiny but low-risk
- `/eval` is a bigger cut, but behavior-visible
- `/mem` changes user-facing command surface more than it saves

## What must NOT happen during execution

These are the key guardrails.

1. **Do not do pure split-and-glue.**
	- No new module whose only job is to hold almost the same `/tabs` or `/config` code.
	- A move only counts if duplicate logic is deleted in the same pass.

2. **Do not keep duplicate command catalogs alive.**
	- If command specs land, delete the old `/help` list, delete matching `detailedHelp()` branches where possible, and delete `COMMAND_ARGS` duplication in `completion.ts`.

3. **Do not preserve `/tabs` complexity by relocating it.**
	- The point is to delete prompt previews and history scanning, not to move them to another helper file.

4. **Do not assume `loadLive().updatedAt` is already a safe production contract.**
	- If execution wants that path, it must first prove it exists and is maintained consistently.
	- Do not spend LOC adding new timestamp plumbing just to protect old `/tabs` wording.

5. **Do not change tab lifecycle semantics covered by integration tests.**
	- `tests/tabs.test.ts` covers open/fork/move placement.
	- This reduction pass should not change tab creation or move behavior.
	- `/tabs` output semantics may change, but tab ordering operations must not.

6. **Do not spend time chasing already-landed resume dedupe as a headline win.**
	- That work is largely already in `src/server/sessions.ts`.
	- It is not the path that gets 656 under 500 now.

7. **Do not let `src/config.ts` become a second command router.**
	- Put only generic config-tree helpers there.
	- Leave slash-command parsing and user messaging in `commands.ts`.

## Overlap and conflict risks

### `src/cli/completion.ts` — direct overlap, high value

This is the most important adjacent file for making the reduction real.

Execution should treat these as one package:

- shared command catalog / arg kinds
- shared config path listing

If `commands.ts` shrinks but `completion.ts` keeps parallel knowledge, the pass leaves drift behind and wastes LOC.

### `src/server/runtime.ts` — moderate overlap

Main shared area:

- `executeCommand()` signature if `emitInfo` is removed

This is a good follow-on cleanup, but it is not the first lever.

### `tests/tabs.test.ts` — low code overlap, high behavior risk

The integration suite does not care about `/tabs` formatting, but it **does** care about:

- open-after placement
- fork placement
- move behavior

A `/tabs` simplification must stay away from those behaviors.

## Stop conditions for execution

Use explicit stop rules so the pass does not drift.

1. Run `./test` and `bun cloc src/runtime/commands.ts` after each completed step.
2. **Stop immediately if `commands.ts` drops below 500 LOC.**
3. If step 1 and step 2 together still leave the file above about **560 LOC**, go straight to step 3.
4. If step 3 would mostly add wrappers or leave old tree walkers in place, **do not do it**; switch to step 5 instead.
5. If keeping current `/tabs` “newest activity first” semantics requires adding fresh timestamp plumbing, **stop** and choose the simpler semantics instead.

## Is under 500 in one pass still realistic?

**Yes, but only with real simplification.**

Honest current answer:

- **still realistic in one pass:** yes
- **realistic without touching `/tabs`:** maybe, but no longer the strongest bet
- **realistic if `/tabs` keeps current preview + history-scan behavior:** much less likely

The strongest current one-pass path is:

1. **simplify `/tabs` by deleting preview/history machinery**
2. **share command metadata across help + completion**
3. **share config tree helpers only if both copies disappear immediately**
4. **take `emitInfo` / alias cleanup as finishing margin**

That path is still credible from **656 LOC**, and unlike the older draft, it does not rely on savings that are already spent or on a not-yet-real `updatedAt` contract.