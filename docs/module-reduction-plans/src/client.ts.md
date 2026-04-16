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

Today `client.state.promptText` / `promptCursor` are written by `setPrompt()` / `clearPrompt()`, but grep only found reads/writes inside `src/client.ts` and test reset code.

Proposal:
- delete `state.promptText`
- delete `state.promptCursor`
- delete `setPrompt()`
- delete `clearPrompt()`
- move `openaiUsage.noteActivity()` to the real prompt-owner path in `src/client/cli.ts`

Estimated impact:
- `src/client.ts`: **-18 to -30 LOC**
- repo total: **down**

Risk / tests:
- verify no hidden eval usage expects these fields
- run `src/client/cli.test.ts`
- run `src/client-startup.test.ts`
- run render tests, since prompt redraw timing changes slightly when `setPrompt()` disappears

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

`state.model` is loaded/saved in `client.ason`, but current code seems to prefer `currentTab()?.model`, and grep did not find a real writer outside startup restore/tests.

Proposal:
- verify whether any live path still needs a client-global fallback model
- if not, remove `state.model` and remove `model` from `client.ason`
- if a fallback is still needed for the model picker, use `models.defaultModel()` instead

Estimated impact:
- `src/client.ts`: **-10 to -18 LOC**
- small extra savings in tests/docs

Risk / tests:
- `src/client/cli.ts` model picker path
- startup tests that touch `client.ason`
- any future no-tab state

Comment:
- this is a good candidate, but I would verify before deleting because it crosses startup UX.

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
- worthwhile only if startup order can be made obviously simpler; do not force this if it complicates host/client bootstrap.

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
- good medium-value reduction, especially if we want `client.ts` to stop knowing so much about session disk layout.

## 4. Extract cohesive domains only after slimming them

These are still worth doing, but only after the true reductions above. Otherwise this becomes a cosmetic split.

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

## Recommended execution sequence for a one-pass push under 500 LOC

Goal: get `src/client.ts` under **500 LOC** while keeping total repo `bun cloc` flat or down.

### Step 1: take the cheap real deletions first

Do only the things that should disappear, not move:
- remove prompt mirroring if verified dead
- remove unused wrappers/exports
- remove global saved model if verified dead
- remove fork-only draft-copy special case if runtime can own it

Expected `src/client.ts` after step 1:
- roughly **900 to 920 LOC**

Why first:
- these are true reductions, not reshuffles
- they buy room so later extractions do not increase total repo LOC

### Step 2: simplify the startup path in place

Do these before extracting modules:
- unify initial shared-state bootstrap vs disk fallback
- eliminate the duplicate `applySessionList()` startup path
- skip duplicate active-tab blob loading
- factor repeated timestamp/usage helpers

Expected `src/client.ts` after step 2:
- roughly **830 to 880 LOC**

This should also improve startup clarity and perf.

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

### Step 4: extract startup/persistence/watchers as one coherent module

Once the noisy duplication is gone, move the remaining startup-specific chunk into a dedicated client startup module.

Expected `src/client.ts` after step 4:
- roughly **520 to 600 LOC**

Important:
- do not extract before step 1-3, or this will mostly be a file shuffle.

### Step 5: if still above 500, extract the smallest remaining cohesive slice

Best candidates:
- `client/commands.ts` if command/continue heuristics still occupy ~70+ LOC
- or `client/tabs.ts` if switch/load/focus logic is still the largest remaining chunk

Expected final size:
- **450 to 500 LOC**

## Best opportunities that also reduce other large files

### Best cross-file reduction wins

1. **Shared live-block mutation helper**
- reduces `src/client.ts`
- reduces `src/server/sessions.ts`
- removes the most fragile duplication in the repo

2. **Shared ASON file / fs-error helper**
- reduces `src/client.ts`
- reduces `src/cli/draft.ts`
- likely also helps `src/ipc.ts` and other file-backed modules

3. **Move fork draft copying to runtime/session ownership**
- reduces `src/client.ts`
- simplifies multi-client behavior
- may slightly simplify tab/fork tests and future runtime code

4. **Push tab snapshot assembly into `replay`/`sessions`**
- reduces `src/client.ts`
- may make session-loading responsibilities cleaner in future work on startup/runtime modules

## Bottom line

Under **500 LOC** looks **reachable in one pass**, but not by split-only refactors.

My recommended recipe is:
- first delete dead state/API
- then simplify the duplicated startup path
- then remove the big live-event duplication with `src/server/sessions.ts`
- only after that extract startup and one remaining cohesive slice

If done in that order, `src/client.ts` should be able to land around **450-500 LOC** with total repo `bun cloc` flat or down, instead of just moving the same complexity into more files.
