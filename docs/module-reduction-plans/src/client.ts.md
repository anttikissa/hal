# `src/client.ts` LOC reduction plan

Reviewed against the current branch by reading:
- `src/client.ts`
- `src/client-startup.test.ts`
- `src/client-streaming.test.ts`
- `src/client-tab-selection.test.ts`
- `src/client/cli.ts`
- `src/client/render-status.ts`
- `src/server/sessions.ts`
- `src/cli/draft.ts`

## 1. Current measured state

Measured now, not copied from an older round:
- `src/client.ts`: **954 LOC** (`bun cloc src/client.ts`)
- repo total: **12,782 LOC** (`bun cloc`)

Current production files still above 500:
- `src/client.ts`: 954
- `src/runtime/commands.ts`: 656
- `src/server/runtime.ts`: 580
- `src/cli/prompt.ts`: 515

Relevant coupled files on this branch:
- `src/server/sessions.ts`: 432
- `src/client/cli.ts`: 396
- `src/client/render-status.ts`: 267
- `src/cli/draft.ts`: 58

Test baseline is currently **green** on this branch.

## 2. Verified current-state facts that matter for this plan

These are the facts the execution plan must respect.

1. **The biggest real duplicate is still live-event mutation logic shared with `src/server/sessions.ts`.**
	Both files still carry near-parallel logic for:
	- `assistantChainId()`
	- `lastInterruptedAssistantId()`
	- `closeStreamingBlock()`
	- thinking / assistant stream append-vs-start
	- tool-call block creation
	- tool-result patching
	- info / response-error live block handling

2. **Startup still does overlapping work.**
	`startWatchingIpcState()` immediately calls `applySharedState(ipcStateFile)`, then `startClient()` calls `bootstrapSessions()`, which can call `applySessionList(items)` again from the same state source. `restoreStartupSelection()` is a separate follow-up pass.

3. **`makeTabFromDisk()` is still a fat mixed-responsibility loader.**
	It still pulls together:
	- session meta
	- fork-aware history
	- usage accumulation
	- context restore
	- live block restore
	- final `Tab` assembly

4. **Prompt mirroring is still real deletable code, not already-free savings.**
	Verified live uses:
	- `client.state.promptText` and `promptCursor` still exist in `src/client.ts`
	- `client.setPrompt()` is still called from `syncPromptToClient()` in `src/client/cli.ts`
	- render/status code reads prompt state from the prompt module, not from `client.state`

5. **Persisted global model fallback is still live behavior.**
	Verified live uses:
	- `state.model` is persisted in `client.ason`
	- reads remain in `src/client/cli.ts` and `src/client/render-status.ts`
	- there is no meaningful live writer other than startup restore / persist

6. **Fork-open glue is still client-specific state, and still overlaps command/runtime work.**
	`pendingOpen === 'fork'` still exists because `applySessionList()` copies the parent draft into the newly opened tab.

## 3. Review verdict

**Verdict: viable, but still too generous to extraction unless tightened.**

The file still has a real path down, but the strongest path is:
- real dedupe first
- real deletion second
- extraction only once the remaining slice is clearly cohesive

The previous version of this plan was directionally right, but it still gave too much credit to moves that can easily become **split-and-glue**:
- moving startup code without deleting overlap
- moving `makeTabFromDisk()` work into a helper that merely wraps the same calls elsewhere
- splitting event handling before the client/server duplication is actually unified

So the plan below is intentionally stricter: **if a step does not reduce total repo LOC or materially simplify ownership, it is not a win.**

## 4. Strongest execution path, ordered by net LOC reduction

This is the path most likely to reduce both `src/client.ts` and overall repo LOC from the current branch.

### Step 1 — Deduplicate live-event block mutation with `src/server/sessions.ts`

Create one shared mutation core for the duplicated block-level logic used by:
- `client.handleEvent()`
- `sessions.applyLiveEvent()`

What belongs in the shared core:
- assistant/thinking stream append-vs-start rules
- tool-call block creation
- tool-result patching
- response-error insertion
- info/error block insertion
- streaming close / continuation helpers

What must stay client-only in `src/client.ts`:
- delayed `[paused]` suppression
- repaint decisions
- active-tab vs background-tab behavior
- trailing assistant dedupe for final `response`
- blob reload after truncated IPC `tool-result`

Expected impact:
- `src/client.ts`: **-90 to -140 LOC**
- `src/server/sessions.ts`: **-30 to -60 LOC**
- shared helper: **+50 to +80 LOC**
- repo net: **down**

**Why first:** this is still the best true duplicate on the board.

**Execution stop point:** stop if the helper only adds a wrapper layer while leaving parallel condition trees in both callers.

### Step 2 — Collapse startup/bootstrap/update flow in place

Replace the current overlapping startup path with one clear ownership flow:
1. read initial shared state once
2. fall back to disk session metas only if shared state is empty
3. apply the initial tab list once
4. restore selection / draft / unseen markers once
5. keep watcher callbacks for later updates only

Expected impact:
- `src/client.ts`: **-35 to -60 LOC**
- repo net: **flat or down**

This is a real simplification, not a cosmetic move.

**Execution stop point:** stop if startup still performs two initial tab-application passes, just from different helper names.

### Step 3 — Delete prompt mirroring from client state

Delete:
- `state.promptText`
- `state.promptCursor`
- `setPrompt()`
- `clearPrompt()`
- `syncPromptToClient()` in `src/client/cli.ts`

Move the only meaningful side effect, `openaiUsage.noteActivity()`, to the prompt-owner path in `src/client/cli.ts`.

Expected impact:
- `src/client.ts`: **-18 to -28 LOC**
- `src/client/cli.ts` + tests: small extra reduction
- repo net: **down**

This is the cleanest pure delete in the file.

**Execution stop point:** stop if the change reintroduces a second prompt mirror somewhere else.

### Step 4 — Only then extract a real session snapshot loader for `makeTabFromDisk()`

This step is acceptable **only** if it creates one reusable snapshot loader that actually owns:
- meta load
- fork-aware history load
- usage accumulation
- context restore
- live block restore

`src/client.ts` should then only turn that snapshot into a `Tab`.

Expected impact if done as a real owner move:
- `src/client.ts`: **-35 to -60 LOC**
- helper growth: **+20 to +35 LOC**
- repo net: **slightly down or flat**

**Important:** this step is the easiest one to fake. If it merely moves `makeTabFromDisk()` into another file and keeps the same work split across modules, skip it.

**Execution stop point:** stop if the new helper is just “old code in a different file”.

### Step 5 — Optional small deletes only if product behavior is approved

#### 5a. Remove persisted global model fallback

If product behavior allows it, fallback becomes:
- `currentTab()?.model || models.defaultModel()`

Expected impact:
- `src/client.ts`: **-10 to -18 LOC**
- nearby files: **-3 to -8 LOC**
- repo net: **down**

#### 5b. Remove client-side fork draft-copy special case

Only if runtime/session creation becomes the owner of draft inheritance.

Expected impact:
- `src/client.ts`: **-10 to -18 LOC**
- repo net: **flat or slightly down**

These are real deletes, but they are **not** the core plan and should not block the main pass.

### Step 6 — If still above target, do exactly one cohesive extraction

If steps 1-4 land the file where expected, one final extraction can finish the job.

Best finisher from the current shape:
- **startup / watcher / persistence**
	- `loadClientState()` / `saveClientState()`
	- startup selection restore
	- background loading bootstrap
	- host lock / IPC state watcher setup

Why this slice is the best final extraction:
- already cohesive
- weakly coupled to command and stream mutation logic
- large enough to matter
- less risky than extracting event handling before dedupe

Expected impact:
- `src/client.ts`: **-150 to -220 LOC**
- repo net: **roughly flat** unless paired with earlier real deletions

**Hard gate:** do this only after the real reductions above. Extraction is the finisher, not the strategy.

## 5. What must NOT happen during execution

1. **Do not do an extraction-only pass first.**
	Splitting `events.ts`, `tabs.ts`, or `startup.ts` before deleting duplication is how this file gets smaller while the repo stays the same size.

2. **Do not move duplication into a new helper without deleting both old copies.**
	A third copy plus adapters is worse than the current state.

3. **Do not slim `src/client.ts` by growing other >500 problem files.**
	Especially avoid pushing client-specific complexity into:
	- `src/runtime/commands.ts`
	- `src/server/runtime.ts`
	- `src/cli/prompt.ts`

4. **Do not change user-visible behavior accidentally.**
	Especially:
	- global model fallback behavior
	- fork draft inheritance behavior
	- startup tab selection behavior
	- background-tab streaming / repaint behavior

5. **Do not split event handling before step 1 is complete.**
	That would freeze today’s duplicated condition tree into more files.

## 6. Overlap risks and safe stopping points

### Highest overlap: `src/server/sessions.ts`

Good overlap:
- one shared live-block mutation core replaces duplicated logic

Bad overlap:
- client gets a wrapper, server keeps bespoke mutation logic, or vice versa

**Safe stop after step 1:** if both files shrink and tests stay green, commit.

### Medium overlap: `src/runtime/commands.ts` and `src/server/runtime.ts`

Relevant only if execution touches:
- open / resume / fork command shape
- session creation ownership
- tab-open focus rules

**Safe stop before touching these:** steps 1-4 do not require command-shape changes.

### Medium overlap: `src/cli/prompt.ts`

Relevant for prompt-mirroring deletion.

**Safe stop after step 3:** if prompt mirroring is gone and no new mirror was introduced, commit.

### Snapshot-loader risk

This is the main “looks good on paper, loses in practice” step.

**Safe stop before step 4:** if steps 1-3 already produced a solid reduction and the snapshot-loader design is not obviously deleting code, do not force it.

## 7. Tests to watch

Run `./test` after every step. Main canaries for this pass:

Primary:
- `src/client-streaming.test.ts`
- `src/client-startup.test.ts`
- `src/client-tab-selection.test.ts`
- `src/client/cli.test.ts`
- `src/server/sessions.test.ts`

Secondary but important:
- `tests/render.test.ts`
- `tests/render-width.test.ts`
- `tests/render-fullscreen.test.ts`
- `tests/render-single-pass.test.ts`
- `tests/main.test.ts`
- `tests/tabs.test.ts`

What they catch:
- shared live-event helper regressions: streaming + sessions + render tests
- startup/bootstrap reorder regressions: startup + main + tabs tests
- prompt-mirroring deletion regressions: client CLI + render tests
- tab-open / close / focus regressions: startup + tab-selection + tabs tests

## 8. Under-500 in one pass: realistic or not?

**Yes, still realistic from the current branch — but not from real deletes alone.**

Best realistic path from today’s 954 LOC is:
1. shared live-event dedupe
2. startup/bootstrap simplification in place
3. prompt-mirroring deletion
4. optional real snapshot-loader ownership move if it actually deletes code
5. one final cohesive extraction of startup / watcher / persistence if still above 500

Reality check:
- steps 1-3 alone probably land around **730-810 LOC**
- adding a real step-4 ownership move can plausibly land around **680-760 LOC**
- so **strict under 500 is still unlikely without one final extraction**

So the answer is:
- **under 500 in one pass is still realistic**
- **but only if the pass ends with one cohesive extraction after the real reductions**
- **if step 4 turns into split-and-glue, stop and do not force the one-pass goal**
