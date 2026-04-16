# LOC reduction plan for `src/runtime/commands.ts`

## Current size

- `bun cloc src/runtime/commands.ts`: **656 LOC**
- Target from this plan: **under 500 LOC** in `commands.ts`, with **flat or lower total repo cloc**

## What this file is doing today

`src/runtime/commands.ts` is not just a command dispatcher. It currently mixes several different responsibilities:

1. **Slash-command parsing and dispatch**
   - `parseCommand()`
   - `handlers[...]`
   - `executeCommand()`
   - `commandNames()`

2. **Open-tab / closed-session target resolution**
   - `/open`, `/send`, `/broadcast`, `/resume`, `/move`
   - name normalization and tab-number parsing

3. **Session-list rendering**
   - `/tabs`
   - history scanning, preview extraction, timestamps, relative-age formatting

4. **Help/catalog data**
   - `/help`
   - detailed usage text
   - top-level command list
   - command-name export used by completion

5. **Runtime/system/debug formatting**
   - `/status`, `/usage`, `/mem`, `/system`, `/eval`
   - runtime status assembly

6. **Mutable config inspection + editing**
   - `/config`
   - path parsing, nested reads, nested writes, temp overrides, ASON parsing, string fallback

7. **Filesystem-ish UX**
   - `/cd` with `~` expansion and AGENTS/SYSTEM reload reporting

8. **IPC command emission**
   - `/clear`, `/fork`, `/open`, `/move`, `/compact`, `/resume`

That is why the file is large: it owns command dispatch *and* a lot of feature-specific logic that belongs closer to other modules.

## Biggest size buckets inside this file

Approximate spans from the current file:

- `/config` support block: **~153 LOC** (`585-737`)
- help text + `/help`: **~113 LOC** (`278-390`)
- `/tabs` helpers + renderer: **~92 LOC** (`173-264`)
- command handlers themselves: spread across the rest, with several tiny wrappers
- command plumbing and one-off target helpers: the rest

Those three buckets are the main path under 500.

## Plausible reduction ideas

Below, “impact” is mostly **`commands.ts` LOC reduction**. When there is a likely repo-wide effect, I note that too.

---

## 1) Delete dead or low-value code

### 1.1 Remove the unused `emitInfo` plumbing from command handlers

**What to change**
- `CommandHandler` currently receives `emitInfo`, but handlers do not use it for real work.
- `handlers['usage']` only passes it through to `status`.
- `handlers['model']` and others accept unused params.
- `executeCommand()` and `server/runtime.ts` still thread it through.

**Impact**
- `commands.ts`: **-8 to -15 LOC**
- repo net: **-10 to -20 LOC** after updating `server/runtime.ts` and tests

**Why this is plausible**
- This argument is effectively vestigial today.

**Risks / tests**
- `src/runtime/commands.test.ts`
- `src/server/runtime.ts` compile path around `commands.executeCommand()`

---

### 1.2 Delete the dead IPC `rename` command type from protocol/client/runtime

**What to change**
- `protocol.ts` defines `RenameCommand`
- `client.ts` has `makeCommand('rename', ...)`
- `server/runtime.ts` has command-preview handling for `rename`
- But slash `/rename` does **not** emit an IPC rename command; it mutates `SessionState` directly and the server persists it after `executeCommand()` returns.
- Search found no actual `ipc.appendCommand({ type: 'rename', ... })` call.

**Impact**
- `commands.ts`: **0 LOC** directly
- repo net: **-10 to -20 LOC** in `protocol.ts`, `client.ts`, `server/runtime.ts`

**Why it matters for this plan**
- It is adjacent dead code revealed by reading this module.
- Good “free” repo-wide reduction while touching command architecture.

**Risks / tests**
- Full typecheck
- `src/client-startup.test.ts`
- `src/server/runtime.test.ts`

---

### 1.3 Consider deleting `/usage` and keeping `/status` only

**What to change**
- Remove alias handler and help references.

**Impact**
- `commands.ts`: **-4 to -8 LOC**
- repo net: **-5 to -10 LOC** including tests/help

**Risk**
- Minor user-facing compatibility break.

**Recommendation**
- Optional only. Not needed for under-500 if bigger wins land.

---

### 1.4 Consider deleting `/eval` slash command and rely on the eval tool

**What to change**
- Remove handler, help entry, detailed help text if any.

**Impact**
- `commands.ts`: **-30 to -40 LOC**
- repo net: **-30 to -45 LOC**

**Why plausible**
- There is already a first-class eval tool outside slash commands.
- `/eval` is dev/debug-only, not core user workflow.

**Risks / tests**
- Mostly user workflow risk; there are currently no dedicated `/eval` tests here.

**Recommendation**
- Keep as optional fallback if the file is still too large after structural cleanup.

---

### 1.5 Consider deleting or folding `/system` and `/mem` into other surfaces

**What to change**
- `/system`: replace with direct tool/eval workflow or move to context debug helpers
- `/mem`: fold into `/status` or remove if memory diagnostics are rarely used

**Impact**
- `/system`: **-8 to -12 LOC**
- `/mem`: **-12 to -18 LOC**
- combined repo net: roughly similar

**Risks / tests**
- `/system` has a real test in `src/runtime/commands.test.ts`
- `/mem` also has a test

**Recommendation**
- Optional, not first pass.

---

## 2) Simplify mixed responsibilities inside `commands.ts`

### 2.1 Replace hand-written help text with a single command metadata table

**What to change**
Create a single command catalog, e.g. each entry holding some mix of:
- `name`
- `summary`
- `usage`
- `detail?`
- `argKind?` for completion
- `handler`
- `aliases?`

Then generate:
- `commandNames()`
- `/help` top-level list
- `/help <topic>` detail lookup
- possibly completion metadata in `src/cli/completion.ts`

**Why this is a real reduction, not just file shuffling**
Today the same command catalog is duplicated in multiple forms:
- handler keys
- `/help` top-level list strings
- `detailedHelp()` branches
- `completion.ts` `COMMAND_ARGS`
- completion’s `commandNames()` wrapper

**Impact**
- `commands.ts`: **-35 to -60 LOC**
- repo net: **-45 to -75 LOC** if `completion.ts` also reads the same metadata

**Risks / tests**
- `src/runtime/commands.test.ts` `/help ...`
- `src/cli/completion.test.ts`
- Keep ordering stable if users rely on current `/help` order

**Recommendation**
- **High priority.** One of the best wins.

---

### 2.2 Remove tiny wrapper handlers and use aliases directly

**Examples**
- `handlers['tabs'] = renderTabs` instead of a wrapper
- `usage` can point to the same implementation as `status`
- other tiny wrappers can become shared helpers or direct assignments

**Impact**
- `commands.ts`: **-5 to -12 LOC**

**Risks / tests**
- Low; mostly formatting and handler signature consistency

---

### 2.3 Collapse the repeated “append simple IPC command” pattern

**What to change**
Several handlers are mostly:
- append `{ type, sessionId, ... }`
- return a short status string

Candidates:
- `/clear`
- `/fork`
- `/compact`
- parts of `/open`
- `/move`
- `/resume`

A small helper like `queueSessionCommand(session, type, extra?, output?)` would remove repeated object literals and repeated `handled: true` scaffolding.

**Impact**
- `commands.ts`: **-10 to -20 LOC**

**Risks / tests**
- `src/runtime/commands.test.ts` for all IPC-emitting commands

**Recommendation**
- Good secondary cleanup after the metadata table, but do not over-engineer it.

---

### 2.4 Simplify `/move` to stop duplicating runtime clamping rules

**What to change**
- The runtime already clamps in `moveSessionToIndex()` after translating from 1-based position.
- `commands.ts` currently computes `currentTabIndex()`, `clampMovePosition()`, and formats `x/max` output.
- Simplest version:
  - parse integer
  - reject non-number
  - queue move command
  - let runtime clamp
  - optionally just say `Moving tab...`

**Impact**
- `commands.ts`: **-8 to -15 LOC**

**Tradeoff**
- You lose the nice `Moving tab to X/Y...` and “already at X” message unless kept.

**Risks / tests**
- `/move` tests in `src/runtime/commands.test.ts`

**Recommendation**
- Worth doing if preserving exact UX is not mandatory.

---

### 2.5 Simplify `/cd` output

**What to change**
- `/cd` currently also reports loaded AGENTS/SYSTEM files with byte sizes.
- If the command only reports the new cwd, most of the extra assembly disappears.

**Impact**
- `commands.ts`: **-6 to -12 LOC**

**Tradeoff**
- Less visibility into prompt reloads.

**Risks / tests**
- No direct dedicated `/cd` test here, so add one if behavior changes significantly.

**Recommendation**
- Optional; good only if we want a stricter “commands should be thin” rule.

---

### 2.6 Relax `/rename` validation if strict filtering is not important

**What to change**
- Current regex only allows letters/digits/spaces/dot/dash/underscore.
- If the real rule only needs “non-empty single-line string”, validation can shrink.

**Impact**
- `commands.ts`: **-3 to -8 LOC**

**Tradeoff**
- Changes allowed names.

**Recommendation**
- Optional; not a first-pass item.

---

## 3) Dedupe logic with nearby modules instead of re-implementing it here

### 3.1 Extract closed-session resume resolution into shared code

**What to change**
There is duplicate logic between:
- `commands.ts` `lookupClosedResumeTarget()`
- `server/runtime.ts` `resolveResumeTarget()`

Both do closed-session lookup by id/name, with open-session filtering.

Best home:
- `src/server/sessions.ts` or a small shared helper under `src/session/`
- keep it pure
- export both “pick most recent closed” and “resolve closed selector” if needed

**Impact**
- `commands.ts`: **-12 to -20 LOC**
- repo net: **-10 to -20 LOC** after deleting duplicate runtime helper/tests move with it

**Extra benefit**
- Fixes behavior drift risk. Right now the two implementations are close, but not quite identical.

**Risks / tests**
- `src/runtime/commands.test.ts` `/resume`
- `src/server/runtime.test.ts` `resolveResumeTarget...`

**Recommendation**
- **High priority.** Clean, shared, and actually duplicated today.

---

### 3.2 Move generic config-path operations into `src/config.ts`

**What to change**
The largest non-command chunk here is generic config tree logic:
- snapshot building
- path split / traversal
- list paths for completion
- read nested value
- create parent objects
- set temp vs persistent value
- parse values, including bare-string fallback

This logic belongs closer to `src/config.ts`, not in the slash-command layer.

Good candidate API surface in `config.ts`:
- `snapshot()`
- `listPaths()`
- `readPath(path)`
- `writePath(path, value, { temp })`
- `parseValue(path, raw)`

Then:
- `/config` becomes a thin adapter
- `src/cli/completion.ts` can reuse `config.listPaths()` and delete its own tree walk

**Impact**
- `commands.ts`: **-70 to -110 LOC**
- repo net: **-20 to -60 LOC** if `completion.ts` shares it and the new config helpers are lean

**Why this is the single biggest lever**
- The `/config` command is currently a mini config subsystem embedded in the command router.

**Risks / tests**
- `src/runtime/commands.test.ts` all `/config ...` tests
- `src/config.test.ts`
- `src/cli/completion.test.ts`

**Recommendation**
- **Highest priority.** This is the cleanest path under 500.

---

### 3.3 Share command metadata with `src/cli/completion.ts`

**What to change**
Completion currently duplicates command classification in `COMMAND_ARGS` and builds its own command list from `commands.commandNames()` plus special handling for `/raw`.

Better options:
- command metadata exported from `commands.ts` or a tiny shared `command-specs.ts`
- completion reads `argKind` directly
- `/help` also reads the same data

**Impact**
- `commands.ts`: **-10 to -20 LOC**
- repo net: **-15 to -30 LOC**

**Risks / tests**
- `src/cli/completion.test.ts`
- `/help` and `commandNames()` tests/usages

**Recommendation**
- Do together with 2.1.

---

### 3.4 Reuse `sessionEntry` helpers where practical

**What to change**
- `src/session/entry.ts` already has helpers for user-entry text extraction.
- `commands.ts` `userEntryText()` partly overlaps, though it also formats image parts.
- If `/tabs` keeps previews, consider moving a single “history preview” helper into `session/entry.ts` or `session/replay.ts`.

**Impact**
- `commands.ts`: **-5 to -12 LOC** if done cleanly
- repo net: likely **flat to slightly down**

**Recommendation**
- Only worth doing if `/tabs` stays feature-rich.

---

## 4) Simplify or shrink feature scope where the current UX is expensive

### 4.1 Simplify `/tabs` so it stops loading full history for every row

**Current behavior**
`/tabs` currently:
- loads **all session metas**
- loads **all history** for each shown session
- scans backward for latest timestamps
- extracts preview text from recent user messages
- formats relative ages and date stamps

That is both a LOC problem and a runtime-cost problem.

**Simpler options, from least to most aggressive:**

#### Option A: keep `/tabs`, drop prompt previews
- keep name/id/open/closed/age
- remove `userEntryText()`, `previewText()`, `recentPromptPreviews()`
- maybe keep sort by timestamp

**Impact**
- `commands.ts`: **-25 to -40 LOC**

#### Option B: use metadata/live timestamps instead of scanning history
- use `sessionStore.loadLive(sessionId).updatedAt` for open sessions
- use `closedAt ?? createdAt` for closed ones
- if prompt previews are still desired, populate `meta.lastPrompt` elsewhere and read that

**Impact**
- `commands.ts`: **-30 to -50 LOC**
- may also reduce runtime I/O

#### Option C: simplify `/tabs` to current open order instead of “newest activity first”
- no timestamp sorting
- no age formatting helpers
- basically a concise tab list

**Impact**
- `commands.ts`: **-45 to -70 LOC**

**Risks / tests**
- `/tabs` tests are explicit today about ordering and previews
- this is the most user-visible behavior change in the file

**Recommendation**
- If we want the safest under-500 path, prefer **A or B**.
- If we want the biggest code drop and fastest command, use **C**.

---

### 4.2 Trim `/help <topic>` detail depth

**What to change**
The current `detailedHelp()` has many branchy, multi-line paragraphs.
Possible reductions:
- only keep details for the few complicated commands (`config`, `move`, maybe `send`)
- everything else uses generated `Usage: ...` + summary from metadata

**Impact**
- `commands.ts`: **-15 to -35 LOC**

**Risks / tests**
- `/help` tests will need updates if exact strings change

**Recommendation**
- Good companion to the metadata-table change.

---

### 4.3 Simplify `/config` syntax instead of supporting every spelling

**Current flexibility**
The command currently supports:
- `/config`
- `/config path`
- `/config path value`
- `--temp` before or after path/value
- `--help`
- bare unquoted strings when existing live value is a string

**Possible scope cuts**

#### Option A: only allow `--temp` in one position
- e.g. `/config --temp path value`
- delete bidirectional parsing logic

**Impact**
- `commands.ts`: **-8 to -15 LOC**

#### Option B: remove bare-string fallback
- require valid ASON for all values
- delete `liveConfigValue()` / `canUseBareStringValue()` fallback path

**Impact**
- `commands.ts`: **-15 to -25 LOC**

#### Option C: split write syntax away from read syntax more strictly
- e.g. require at least 2 tokens for write, 1 token for read, no magic

**Impact**
- `commands.ts`: **-10 to -20 LOC**

**Risks / tests**
- all `/config` tests
- user ergonomics

**Recommendation**
- If config helpers move to `src/config.ts`, do not also change syntax in the same pass unless still needed.

---

## 5) Micro-cleanups that are small individually but good in a reduction pass

### 5.1 Inline one-use helpers

Candidates:
- `normalizeHelpTopic()`
- `currentTabIndex()`
- `sendToSession()`

**Impact**
- `commands.ts`: **-5 to -10 LOC**

**Recommendation**
- Do only after bigger moves; these are cleanup scraps.

---

### 5.2 Normalize repeated success/error result creation

A helper like `ok(output)` / `fail(error)` can shrink repeated `{ ..., handled: true }` objects.

**Impact**
- `commands.ts`: **-5 to -12 LOC**

**Tradeoff**
- Can become abstract for little gain if overdone.

**Recommendation**
- Optional.

---

### 5.3 Merge `normalizeSessionName`, open-target resolution, and send-target resolution into one target helper

**What to change**
- `/open` and `/send` do related work with overlapping parsing rules.
- A small shared “resolve open session ref + remaining text” helper can replace some repeated branches.

**Impact**
- `commands.ts`: **-8 to -15 LOC**

**Risks**
- Easy to introduce targeting regressions; keep tests broad.

**Recommendation**
- Useful if already touching targeting behavior; otherwise optional.

---

## Recommended execution sequence

This sequence is aimed specifically at getting `commands.ts` under **500 LOC** while keeping total repo cloc flat or down.

### Step 1 — Move generic config tree logic into `src/config.ts`

**Do**
- add shared helpers in `src/config.ts` for snapshot/path traversal/path listing/read/write/value parse
- rewrite `/config` handler in `commands.ts` as a thin adapter
- switch `src/cli/completion.ts` to the shared path-list helper

**Expected result**
- `commands.ts`: roughly **656 → 545-585**
- repo net: likely **down**

**Why first**
- Biggest concrete win
- improves module ownership
- removes duplication with completion immediately

---

### Step 2 — Replace `detailedHelp()` + top-level `/help` list with command metadata

**Do**
- define one command catalog
- generate command names and help text from it
- expose arg-kind metadata for completion if possible

**Expected result**
- `commands.ts`: roughly **another -35 to -60 LOC**
- likely lands around **490-540**, depending on Step 1 size
- repo net: likely **down**

**Why second**
- large reduction, low risk, and naturally follows the config cleanup

---

### Step 3 — Deduplicate resume resolution and remove unused plumbing

**Do**
- share closed-session resolution with `server/runtime.ts`
- remove unused `emitInfo` parameter path
- delete dead `rename` IPC command support outside this file
- alias tiny handlers directly where obvious

**Expected result**
- `commands.ts`: **another -15 to -30 LOC**
- should put the file safely **below 500** if Steps 1 and 2 were lean
- repo net: **down**

---

### Step 4 — If still above 500, simplify `/tabs`

**Preferred fallback**
- stop rendering prompt previews, or
- use live/meta timestamps instead of full-history scans

**Expected result**
- `commands.ts`: **-25 to -50 LOC**

**Why fourth**
- bigger UX tradeoff than Steps 1-3
- but highest guaranteed remaining reduction if needed

---

### Step 5 — Only if necessary, cut optional commands or syntax

Use only if the file somehow still resists shrinking enough:
- remove `/usage`
- remove `/eval`
- remove `/system` or `/mem`
- reduce `/config` syntax variants

**Expected result**
- highly variable, but large

---

## Best specific ideas

If I had to pick the strongest practical wins:

1. **Move config-path logic into `src/config.ts` and share it with completion**
   - biggest reduction
   - best ownership fix
   - likely lowers total repo cloc too

2. **Replace hand-written help branches with one metadata table**
   - deletes duplication inside `commands.ts`
   - can also reduce `src/cli/completion.ts`

3. **Share resume resolution with `src/server/runtime.ts`**
   - clear duplication already exists
   - good repo-wide cleanup

4. **If needed, simplify `/tabs`**
   - most expensive command-specific logic in the file after `/config` and help
   - also removes unnecessary history loading

## Opportunities that also reduce other large files

### `src/cli/completion.ts`
- Can consume shared command metadata instead of its own `COMMAND_ARGS`
- Can consume shared config path listing from `src/config.ts`
- likely modest but real reduction

### `src/server/runtime.ts`
- Can share resume-target logic instead of duplicating it
- dead `rename` command support can go away

### `src/client.ts`
- dead `rename` IPC command creation can go away

### `src/protocol.ts`
- dead `RenameCommand` type can go away

### `src/config.ts`
- will likely grow, but this is the right place for generic config-tree code
- should still be repo-net down once completion and commands stop duplicating that logic

## Risk checklist / tests to watch

Primary tests:
- `src/runtime/commands.test.ts`
- `src/cli/completion.test.ts`
- `src/config.test.ts`
- `src/server/runtime.test.ts`

Behavior-sensitive areas:
- `/help` exact text
- `/config` parsing and temp writes
- `/tabs` ordering and previews
- `/resume` closed-session matching
- `/move` user-facing messages if simplifed
- `/cd` output if prompt-file reporting changes

## Reachability judgment

**Under 500 is reachable in one pass.**

Most likely path without resorting to major feature cuts:
- config extraction/shared helpers
- metadata-driven help/catalog
- resume dedupe + unused-plumbing cleanup

That should be enough, or very close. If not, a modest `/tabs` simplification will push it comfortably below the target.
