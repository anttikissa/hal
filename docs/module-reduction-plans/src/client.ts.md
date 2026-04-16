# `src/client.ts` LOC reduction plan

Reviewed before planning:
- `src/client.ts`
- `src/client-startup.test.ts`
- `src/client-streaming.test.ts`
- `src/client-tab-selection.test.ts`
- `src/client/cli.ts`
- `src/client/render-status.ts`
- `src/server/sessions.ts`
- `src/cli/draft.ts`

## Current size

- Current `bun cloc` for this file: **954 LOC**
- Current repo total from the same run: **13,500 LOC**

This is the biggest production file in the repo right now.

## Review verdict

This plan is **mostly pointed at real reduction**, not just file-splitting, but it needed two corrections after re-reading the code:

- `promptText` / `promptCursor`, `getActivity()`, `appendInputHistory()`, and persisted `state.model` are more strongly dead than the original wording suggested. These should be treated as **first-pass deletions**, not “maybe later” cleanups.
- extraction-only steps need a harder gate. Reaching under 500 with flat/down repo `cloc` is realistic only if the pass spends most of its budget on **deletes, in-place simplification, and cross-file dedupe** before any cosmetic module moves.

Also note the current repo baseline is already red in unrelated suites (`src/tools/read.test.ts`, `tests/ipc.test.ts`, `src/utils/tail-file.test.ts`, `tests/tabs.test.ts`, `tests/main.test.ts`, `src/tools/search-caps.test.ts`). For this work, the execution plan should still run `./test` after each step, but judge success as **no new client-facing regressions plus no worsening of the existing baseline**.

## Responsibilities currently mixed together

`src/client.ts` is doing all of these at once:

- client-owned mutable state for tabs, prompt, host pid, busy/activity, version info
- tab creation and tab selection policy
- lazy tab loading from session history
- startup bootstrap from IPC state and disk fallback
- background blob loading and startup perf reporting
- `client.ason` persistence
- per-tab draft and per-tab input history handling
- command construction and `pendingOpen` bookkeeping
- continue/interrupted-turn heuristics
- IPC event handling for prompt/stream/info/tool/draft events
- stream block mutation logic
- live-history merge / persisted-history overlap trimming
- file watchers for `host.lock` and `state.ason`
- test reset hooks

That is too many axes for one file. Even before splitting, there is real duplicate and dead logic to remove.

## Constraints and coupling to keep in mind

The file has more coupling than it first appears:

- `src/client/cli.ts` depends on command helpers, tab switching callbacks, draft accessors, and current-tab queries.
- `src/client/render-status.ts` and `src/client/render.ts` read `client.state` and `client.currentTab()` directly.
- many render tests manually construct `client.state.tabs` entries, so changing `Tab` shape carelessly creates wide churn.
- `src/client-startup.test.ts` covers bootstrap, disk fallback, open/resume/move focus behavior, done-unseen persistence, and startup merge.
- `src/client-streaming.test.ts` covers the most fragile event/stream behavior.
- `src/server/sessions.ts` duplicates part of the streaming/live-block state machine, which is the best cross-file reduction opportunity.

## Reduction ideas by type

### 1. Delete dead or likely-dead client surface

#### 1.1 Remove prompt mirroring from `client.state`

Today `client.state.promptText` / `promptCursor` are written by `setPrompt()` / `clearPrompt()`, but grep only found reads/writes inside `src/client.ts`, one call site in `src/client/cli.ts`, and startup test reset code. Current render code does **not** read them.

Proposal:
- delete `state.promptText`
- delete `state.promptCursor`
- delete `setPrompt()`
- delete `clearPrompt()`
- delete `syncPromptToClient()` in `src/client/cli.ts`
- move `openaiUsage.noteActivity()` to the real prompt-owner path in `src/client/cli.ts`

Estimated impact:
- `src/client.ts`: **-18 to -30 LOC**
- small extra savings in `src/client/cli.ts` and tests
- repo total: **down**

Risk / tests:
- very low product risk; this is mostly dead state removal
- run `src/client/cli.test.ts`
- run `src/client-startup.test.ts`
- run render tests only as a sanity check, not because the prompt mirror itself is used

#### 1.2 Remove unused exports / wrappers

Likely dead now:
- `getActivity()`
- exported `appendInputHistory()` if no external caller is needed
- possibly `clearPrompt()` as above

Proposal:
- confirm with grep, then drop unused API surface instead of keeping wrappers forever

Estimated impact:
- `src/client.ts`: **-6 to -14 LOC**

Risk / tests:
- mainly compile-time breakage
- run `./test`

#### 1.3 Delete persisted `state.model` if it is truly unused

`state.model` is loaded/saved in `client.ason`, but grep did not find a live writer outside startup restore/tests. The only remaining reads are fallback paths in `src/client/cli.ts` and `src/client/render-status.ts`, both of which can fall back to `models.defaultModel()` instead.

Proposal:
- treat this as a **first-pass deletion**, not a maybe
- remove `state.model`
- remove `model` from `ClientStateFile`, `defaultClientState()`, `loadClientState()`, and `saveClientState()`
- switch model picker / status fallback to `currentTab()?.model || models.defaultModel()`

Estimated impact:
- `src/client.ts`: **-10 to -18 LOC**
- small extra savings in startup tests / fixtures
- repo total: **down**

Risk / tests:
- `src/client/cli.ts` model picker path
- `src/client-startup.test.ts`
- `tests/render.test.ts` and friends, because status-line fallback text changes slightly in the no-tab / no-model case

Comment:
- verified enough to promote into step 1

#### 1.4 Delete `pendingEntries` if startup ordering can be tightened

`pendingEntries` exists only because local startup/info entries may be queued before tabs exist.

Proposal:
- reorder startup so tabs are bootstrapped before any local startup entries are appended
- then delete `pendingEntries` + `flushPendingEntries()` and simplify local append flow

Estimated impact:
- `src/client.ts`: **-12 to -22 LOC**
- possible tiny `main.ts` reshuffle

Risk / tests:
- startup summary ordering
- promote-to-server path in `src/main.ts`
- `src/client-startup.test.ts`
- `tests/main.test.ts`

Comment:
- real reduction, but **not required for the first pass**. Keep it conditional on the startup rewrite becoming simpler without new buffering glue.

#### 1.5 Move fork-draft copying out of the client

Today `pendingOpen === 'fork'` exists partly so `applySessionList()` can copy the parent tab draft into the new forked tab in memory.

Proposal:
- copy the draft when the runtime creates the forked session, or persist the child draft immediately via `draft.saveDraft()` there
- then remove the client-only fork special case in `applySessionList()`
- `pendingOpen` may shrink from `'open' | 'fork' | 'resume' | false` to `'open' | 'resume' | false`

Estimated impact:
- `src/client.ts`: **-10 to -18 LOC**
- repo total: likely **flat or slightly down**

Risk / tests:
- fork UX in `tests/tabs.test.ts`
- startup/open/fork interaction in `src/client-startup.test.ts`
- multi-client draft behavior becomes better if done in runtime

Comment:
- this is real, but it is **not** a top-three move for a one-pass under-500 push. It introduces cross-layer work, so take it only if steps 1-3 still leave obvious client-only fork glue behind.

## 2. Simplify local logic in place

#### 2.1 Collapse repeated “push / touch / maybe repaint” helpers

Right now the file has several variants:
- `queueLocalBlock()`
- `addBlockToTab()`
- `flushPendingEntries()`
- `repaintIfActive()`
- repeated `tab.history.push(...)` + `touchTab(tab)` + render logic

Proposal:
- introduce one small helper that appends to a tab and decides whether to repaint
- keep a separate explicit helper only for “queue until current tab exists” if that behavior survives

Estimated impact:
- `src/client.ts`: **-15 to -25 LOC**

Risk / tests:
- `src/client-streaming.test.ts` background-tab repaint behavior
- render tests relying on `historyVersion`

#### 2.2 Extract tiny helpers for repeated timestamp / usage updates

The file repeats these patterns many times:
- `event.createdAt ? Date.parse(event.createdAt) : undefined`
- `tab.usage.input += ...`, `output += ...`, `cacheRead += ...`, `cacheCreation += ...`
- `contextUsed` / `contextMax` updates

Proposal:
- add local helpers like `eventTs(event)` and `applyUsageAndContext(tab, event)`

Estimated impact:
- `src/client.ts`: **-15 to -25 LOC**

Risk / tests:
- `src/client-streaming.test.ts` usage/context paths
- render status token/context display tests

#### 2.3 Simplify backward scans over tab history

There are three related reverse scans:
- `lastInterruptedAssistantId()`
- `canContinueTab()`
- `trailingAssistantText()`

Proposal:
- introduce one shared helper for “find last meaningful non-tool block” and/or one helper that skips trailing status noise consistently
- keep `trailingAssistantText()` special, but base it on the same skip rules

Estimated impact:
- `src/client.ts`: **-10 to -20 LOC**

Risk / tests:
- `src/client-streaming.test.ts`
- `src/client/cli.test.ts`
- render indicator/status behavior, because paused/error detection depends on these rules

#### 2.4 Unify startup bootstrap paths

Right now startup has overlapping paths:
- `startWatchingIpcState()` immediately calls `applySharedState(ipcStateFile)`
- `bootstrapSessions()` then calls `applySessionList(items)` again from the same source
- `restoreStartupSelection()` is separate from the above

Proposal:
- make one bootstrap path that:
	1. reads shared state once
	2. falls back to disk only if needed
	3. applies the initial session list once
	4. restores selection/drafts once
- keep the watcher path only for subsequent updates

Estimated impact:
- `src/client.ts`: **-35 to -60 LOC**
- repo total: **same or down**
- perf: avoids duplicate startup work

Risk / tests:
- this is the highest-value in-place simplification after the streaming dedupe
- run all of `src/client-startup.test.ts`
- also run `tests/tabs.test.ts`, `tests/main.test.ts`, `tests/ipc.test.ts` because startup sequencing is fragile

#### 2.5 Stop loading active-tab blobs twice during background startup

`loadInBackground()` loads active tab blobs first, then loops all tabs and may load that same active tab again.

Proposal:
- skip the active tab in the second pass, or restructure so one helper handles “active first, then remaining tabs” without repeating the same call shape

Estimated impact:
- `src/client.ts`: **-8 to -15 LOC**
- perf improvement more important than LOC here

Risk / tests:
- startup perf summary tests / snapshots if any
- `src/client-startup.test.ts`

#### 2.6 Make command sending explicit instead of prefix-parsing strings

Current API:
- `sendCommand(type, text?)`
- `open` special-cases `fork:` and `after:` prefixes inside `makeCommand()`

Proposal:
- replace with a tiny typed helper surface, e.g. `sendOpen()`, `sendFork(sessionId)`, `sendOpenAfter(sessionId)`, `sendMove(position)`
- or accept a command-like object directly from `src/client/cli.ts`

Estimated impact:
- `src/client.ts`: **-10 to -20 LOC** if done cleanly
- `src/client/cli.ts`: likely also a little smaller / clearer

Risk / tests:
- `src/client-startup.test.ts` command assertions
- `src/client/cli.test.ts`

Comment:
- this is not the first cut I would do, but it is a real simplification opportunity.

## 3. Dedupe with existing or new shared helpers

### 3.1 Share the streaming/live-block mutation state machine with `src/server/sessions.ts`

This is the biggest real reduction opportunity.

Observed duplication between `src/client.ts` and `src/server/sessions.ts`:
- `assistantChainId()`
- `lastInterruptedAssistantId()`
- `closeStreamingBlock()`
- assistant/thinking stream-delta append-vs-start logic
- tool-call block creation
- tool-result block patching
- some info/error live-block handling

Proposal:
- create a shared helper module for mutating a block list from live events
- client keeps UI-specific pieces:
	- delayed `[paused]` suppression
	- response dedupe via `hasTrailingAssistantText()`
	- repaint decisions
	- blob reload after tool-result preview
- server/session layer keeps persistence-specific pieces

Estimated impact:
- `src/client.ts`: **-90 to -150 LOC**
- `src/server/sessions.ts`: **-40 to -80 LOC**
- new shared helper: **+60 to +90 LOC**
- repo total: usually **meaningfully down**

Risk / tests:
- highest-risk semantic refactor
- run `src/client-streaming.test.ts`
- run startup tests that merge persisted + live blocks
- run session replay tests if the helper touches block shapes
- run `tests/render.test.ts` because block order matters

This is the single best “reduce this file and also reduce another large file” move.

### 3.2 Introduce a small ASON file helper instead of custom load/save boilerplate

`client.ts`, `cli/draft.ts`, `ipc.ts`, and some other files repeat the same patterns:
- read file
- parse ASON
- treat `ENOENT` specially
- stringify and append newline on write
- log with a module prefix

Proposal:
- create a tiny `utils/ason-file.ts` or `utils/fs-errors.ts`
- use it for `client.ason` first
- optionally follow with `draft.ts` and `ipc.ts`

Estimated impact:
- `src/client.ts`: **-15 to -30 LOC**
- repo total: **down** once reused in 2+ files

Risk / tests:
- startup tests that expect explicit client-state error logging
- draft tests and IPC tests if reused there

Comment:
- this is a better candidate than merely moving `errorMessage()` / `isMissingFileError()` to another file, because it removes more call-site code.

### 3.3 Push “tab snapshot from disk” assembly into `replay` or `sessions`

`makeTabFromDisk()` currently does several jobs:
- load meta
- load full history with fork origin
- create a tab shell
- stash raw history
- load live blocks
- compute usage totals from history
- load context/fork metadata

Proposal:
- add one shared helper returning a prepared startup snapshot, something like:
	- `replay.loadTabSnapshot(info)` or
	- `sessions.loadClientTabData(info.id)`
- then `client.ts` only maps snapshot -> `Tab`

Estimated impact:
- `src/client.ts`: **-40 to -70 LOC**
- helper module growth: **+20 to +40 LOC**
- repo total: **slightly down or flat**

Risk / tests:
- `src/client-startup.test.ts`
- session replay tests if logic moves into `replay`

Comment:
- good medium-value reduction, especially if we want `client.ts` to stop knowing so much about session disk layout
- promote this **ahead of extraction-first moves** if the goal is flat/down repo `cloc`

## 4. Extract cohesive domains only after slimming them

These are still worth doing, but only after the true reductions above, and only if a fresh `bun cloc` check says `src/client.ts` is still above target. Otherwise this becomes a cosmetic split.

### 4.1 Extract startup/persistence/watchers to `src/client/startup.ts`

Natural contents:
- `CLIENT_STATE_PATH`
- `ClientStateFile`
- `loadClientState()` / `saveClientState()`
- startup restore logic
- host lock watcher
- IPC state watcher
- background load / startup perf summary
- maybe `startClient()` itself

Estimated impact:
- `src/client.ts`: **-140 to -190 LOC**
- repo total: **flat to slightly up** if done alone
- repo total: **flat or down** if paired with the earlier deletions/dedupes

Risk / tests:
- `src/client-startup.test.ts`
- `tests/main.test.ts`
- anything touching client role/host pid rendering

### 4.2 Extract event handling to `src/client/events.ts`

Natural contents:
- delayed paused-notice logic
- `handleEvent()`
- helper functions for tool-result blob reload and response dedupe

Estimated impact:
- `src/client.ts`: **-160 to -220 LOC**
- repo total: near **flat** if the module is a thin move

Risk / tests:
- `src/client-streaming.test.ts`
- render tests that assert event order or background repaint behavior

Comment:
- best done after the shared live-block helper lands, otherwise this extraction just moves duplicated complexity elsewhere.

### 4.3 Extract tab lifecycle / selection policy to `src/client/tabs.ts`

Natural contents:
- `makeTab()`
- `ensureTabLoaded()`
- `loadTabBlobs()`
- `switchTab()` / `nextTab()` / `prevTab()`
- recent-tab bookkeeping
- `applySessionList()`
- `pickActiveSessionAfterSessionListChange()` can stay pure and maybe move here too

Estimated impact:
- `src/client.ts`: **-120 to -170 LOC**
- repo total: roughly **flat**

Risk / tests:
- `src/client-tab-selection.test.ts`
- `src/client-startup.test.ts`
- tab-focused integration tests in `tests/tabs.test.ts`

### 4.4 Extract commands / continue heuristics to `src/client/commands.ts`

Natural contents:
- `sendCommand()`
- `makeCommand()`
- `pendingOpen`
- `isContinuableStatusBlock()`
- `canContinueTab()`
- `trailingAssistantText()`

Estimated impact:
- `src/client.ts`: **-60 to -95 LOC**
- repo total: near **flat**

Risk / tests:
- `src/client/cli.test.ts`
- `src/client-streaming.test.ts`
- `src/client-startup.test.ts`

## 5. Lower-priority or longer-horizon simplifications

These are plausible, but not first-pass moves.

### 5.1 Enrich `SharedSessionInfo` so the client stops re-reading some session meta

If shared IPC state carried more fields like `forkedFrom` and maybe context, the client would need fewer direct disk reads during startup.

Estimated impact:
- `src/client.ts`: **-5 to -15 LOC**
- perf win more important than LOC

Risk / tests:
- IPC/state compatibility and runtime state writer

### 5.2 Replace manual tab object literals in tests with one shared helper

Many tests construct full tab objects inline. That makes `Tab` hard to slim because any field change ripples widely.

Estimated impact:
- not much production LOC
- but it would make future `Tab` reductions cheaper and safer

Risk / tests:
- low risk

### 5.3 Consider whether `doneUnseen` persistence can move behind a dedicated helper

This is not big enough to justify a first-pass extraction, but it is part of the startup/persistence clutter.

Estimated impact:
- `src/client.ts`: **-5 to -10 LOC** at most

## Risks and test focus by change type

### Highest-risk areas

- stream delta / stream end / tool-result ordering
- paused-notice debounce and steering suppression
- startup bootstrap order
- focus selection when tabs are opened, resumed, moved, forked, or closed
- startup merge of persisted history with live blocks
- background-tab repaint suppression

### Test files to watch closely

Primary:
- `src/client-streaming.test.ts`
- `src/client-startup.test.ts`
- `src/client-tab-selection.test.ts`
- `src/client/cli.test.ts`

Secondary but important:
- `tests/render.test.ts`
- `tests/render-width.test.ts`
- `tests/render-fullscreen.test.ts`
- `tests/render-single-pass.test.ts`
- `tests/tabs.test.ts`
- `tests/main.test.ts`
- `tests/ipc.test.ts`

Operational note:
- because `./test` is currently red outside this area, use the client-focused suites above as the semantic guardrail after each reduction step, then run full `./test` to confirm the existing unrelated failures are unchanged

## Recommended execution sequence for a one-pass push under 500 LOC

Goal: get `src/client.ts` under **500 LOC** while keeping total repo `bun cloc` flat or down.

### Step 1: take the cheap real deletions first

Do only the things that should disappear, not move:
- remove prompt mirroring
- remove unused wrappers/exports
- remove persisted global model state
- inline/drop tiny one-off helpers that fall out naturally, such as `sessionInfoFromMeta()` if it becomes a single call-site map

Expected `src/client.ts` after step 1:
- roughly **890 to 920 LOC**

Why first:
- these are true reductions, not reshuffles
- they buy room so later helper modules can still leave repo `cloc` flat or down

### Step 2: simplify the local startup/update path in place

Do these before extracting modules:
- unify initial shared-state bootstrap vs disk fallback
- eliminate the duplicate `applySessionList()` startup path
- collapse repeated append/touch/repaint helpers where it actually removes code
- skip duplicate active-tab blob loading
- factor repeated timestamp / usage / context updates

Expected `src/client.ts` after step 2:
- roughly **820 to 870 LOC**

This should improve startup clarity and perf without creating new files yet.

### Step 3: land the shared live-block mutation helper

Create one shared helper used by both:
- `src/client.ts`
- `src/server/sessions.ts`

Expected effect:
- `src/client.ts` drops sharply
- repo total should go **down**, because this removes real duplication

Expected `src/client.ts` after step 3:
- roughly **680 to 760 LOC**

This is the key step that makes “under 500 with flat/down repo LOC” realistic.

### Step 4: take the next real cross-file reductions before any extraction-only move

Best candidates:
- push `makeTabFromDisk()` / startup snapshot assembly into `replay` or `sessions`
- add a tiny shared ASON file helper if it will be reused in `client.ts` plus at least one other module

Expected `src/client.ts` after step 4:
- roughly **580 to 690 LOC**

Important:
- if this step does not reduce total repo `cloc`, stop and reassess before extracting anything

### Step 5: only if still above target, extract one cohesive slice with a hard `cloc` gate

Best candidates:
- `client/commands.ts` if command/continue heuristics still occupy ~70+ LOC
- `client/startup.ts` only if the remaining startup code is already slimmed and obviously cohesive
- `client/tabs.ts` only if switch/load/focus logic is still the single biggest leftover chunk

Expected final size:
- **450 to 520 LOC**

Rule:
- do **one** extraction, rerun `bun cloc`, and stop if the repo total goes up without a compensating delete


## Best opportunities that also reduce other large files

### Best cross-file reduction wins

1. **Shared live-block mutation helper**
- reduces `src/client.ts`
- reduces `src/server/sessions.ts`
- removes the most fragile duplication in the repo

2. **Push tab snapshot assembly into `replay`/`sessions`**
- reduces `src/client.ts`
- may make session-loading responsibilities cleaner in future work on startup/runtime modules

3. **Shared ASON file / fs-error helper**
- reduces `src/client.ts`
- reduces `src/cli/draft.ts`
- likely also helps `src/ipc.ts` and other file-backed modules

4. **Move fork draft copying to runtime/session ownership**
- reduces `src/client.ts`
- simplifies multi-client behavior
- lower priority than the three items above because it adds cross-layer work

## Bottom line

Under **500 LOC** still looks **reachable in one pass**, but only if the pass stays biased toward deletion, in-place simplification, and shared-logic dedupe.

My recommended recipe is:
- first delete dead state/API
- then simplify the duplicated startup/update path in place
- then remove the big live-event duplication with `src/server/sessions.ts`
- then take one more real cross-file reduction (`makeTabFromDisk()` snapshot assembly and/or ASON helper reuse)
- only then consider a single extraction, gated by fresh `bun cloc`

If done in that order, `src/client.ts` should be able to land around **450-520 LOC** with total repo `bun cloc` flat or down, instead of just moving the same complexity into more files.
