# Keep large modules under 500 LOC

Date: 2026-05-06

This is a planning document only. It suggests architecture and reduction options for review before implementation.

## Current measurements

Measured with `bun cloc src/client.ts src/server/runtime.ts src/cli/prompt.ts`:

- `src/client.ts` — **1008 LOC**
- `src/server/runtime.ts` — **690 LOC**
- `src/cli/prompt.ts` — **556 LOC**

Full `bun cloc` also currently shows these production files above 500:

- `src/runtime/agent-loop.ts` — **532 LOC**
- `src/runtime/commands.ts` — **530 LOC**
- `src/cli/blocks.ts` — **514 LOC**

The detailed plans below cover the three files requested. The other three are close enough to 500 that they should get follow-up cleanup after these, or a small guardrail pass.

## Current test baseline

I ran `./test` before planning. Most tests pass, but the suite currently fails in `src/tools/sensitive.test.ts`:

- read/write/edit/grep/glob/bash/eval sensitive-file protections are not behaving as the test expects
- the sensitive files are untracked in this worktree (`src/tools/sensitive.ts`, `src/tools/sensitive.test.ts`)

I did not touch those files. Treat this as current worktree baseline noise for the planning task.

## Why these files grew again

The pattern is the same as the last LOC campaign:

1. **Central orchestration files collect feature edges.**
	`client.ts` and `server/runtime.ts` are where new behavior naturally lands because they can see all relevant state.

2. **Earlier reductions solved old hot spots, not the new growth.**
	For example, old `client.ts` plans removed prompt mirroring and live-event duplication, but current growth includes startup subscription text, return-to-tab behavior, preferred-cwd startup, retry/continue distinctions, and richer event handling.

3. **The under-500 rule is not enforced automatically.**
	Once a file drops under 500, later feature work can push it back over without a guardrail.

4. **Some modules are still named too broadly.**
	`client.ts` means “everything client state related”; `runtime.ts` means “everything server runtime related”; `prompt.ts` means “editor, layout, keymap, rendering, history, clipboard”. Those names invite more code.

## Acceptance rules for implementation

For every implementation pass:

1. Run `./test` first and record baseline.
2. Re-measure with `bun cloc <target>` and `bun cloc` before editing.
3. Prefer deletion, simplification, and real dedupe.
4. Extraction is acceptable only when it creates a clear owner and does not grow repo LOC materially.
5. Stop after each chunk and re-measure.
6. Do not push lines into another file already near or above 500.
7. Commit only if the target file is below 500 or a reviewed plan explicitly approves an intermediate step.
8. If a target remains over 500 after execution, do another plan/review round based on the new current file.

## Guardrail recommendation

Add a test/script after these plans are implemented:

- production `.ts` files should stay below **500 bun-cloc LOC**
- allow a short explicit exception list only while actively paying down a module
- print the offender list and fail CI / `./test`

This would have caught the regression from the previous campaign.

---

# Plan 1: `src/client.ts`

Current size: **1008 LOC**.

## Why `client.ts` is the hardest file

`client.ts` is not just a client module. It currently owns all of these:

- tab/session state shape (`Tab`) and active-tab navigation
- recent-tab and return-to-tab policy
- input history and draft persistence glue
- client state persistence (`client.ason`)
- startup summary text and model/quota presentation
- session loading from disk, including fork-aware history, live blocks, usage, context
- history/liveness reconciliation
- live IPC event handling and repaint decisions
- delayed `[paused]` notice logic
- command construction and pending open/fork/resume focus hints
- shared-state watching (`ipc/state.ason`)
- host-lock watching
- background loading of histories/blobs
- startup selection from cwd/restart/saved tab
- test reset/export surface

That is why small deletions do not move it much. The remaining reduction needs ownership changes, but those changes must be real ownership changes, not split-and-glue.

## Best architectural alternatives

### Alternative A — Keep one state owner, extract pure reducers/loaders

`client.ts` remains the only owner of `state`, `onChange`, callbacks, and exported namespace. Extract pure or near-pure modules:

- `src/client/tabs.ts`
	- `pickActiveSessionAfterSessionListChange()`
	- `applySessionList()` selection computation
	- return-to-tab bookkeeping helpers
- `src/client/session-loader.ts`
	- `makeTabFromDisk()` dependencies
	- usage accumulation
	- context/live/fork origin snapshot assembly
- `src/client/startup-summary.ts`
	- model/quota/perf/startup card text
- `src/client/events.ts`
	- event-to-client mutations, with callbacks injected for repaint, delayed pause, blob reload

Pros:
- easiest to test incrementally
- keeps hot-patch friendliness if modules export mutable namespace objects
- likely gets `client.ts` under 500 quickly

Cons:
- repo LOC may go flat/up if extraction is too wrapper-heavy
- still leaves central state in `client.ts`

Verdict: safest first architecture if reviewed carefully.

### Alternative B — Client model object + reducers

Define a `ClientModel` object containing tabs, active index, busy/activity, recent tabs, pending actions, etc. Then make reducers operate on it:

- `clientTabs.applyList(model, items, opts)`
- `clientEvents.applyEvent(model, event, opts)`
- `clientStartup.initialize(model, shared, opts)`

`client.ts` becomes runtime wiring: load/watch/tail events/render callbacks.

Pros:
- cleaner long-term architecture
- enables direct unit tests without global reset gymnastics
- reduces future growth in `client.ts`

Cons:
- larger refactor
- may initially add types/glue
- riskier with current behavior around drafts, delayed paused notices, and background blob loading

Verdict: good long-term design, but probably too much for the first shrink pass unless split into careful steps.

### Alternative C — UI-session store module

Move almost all tab state and history hydration into `src/client/session-store.ts`; `client.ts` only starts watchers and forwards events/commands.

Pros:
- largest `client.ts` reduction
- strong owner boundary: UI session store vs process wiring

Cons:
- easy to create a second god module
- could just rename the problem
- harder to keep eval-friendly if state is hidden incorrectly

Verdict: only acceptable if the new module itself stays well below 500 and has a tight API.

## Recommended path

Use Alternative A first, with strict repo-LOC discipline.

### Step 1 — Extract startup summary text to `src/client/startup-summary.ts`

Move these presentation helpers out of `client.ts`:

- `formatHomePath()`
- `titleWords()`
- `providerDisplayName()`
- `chatGptSubscriptionText()`
- `quotaWindowText()`
- `startupQuotaLine()`
- `startupModelLine()`
- `startupPerfText()`
- `startupSummaryText()`

Keep in `client.ts`:

- `shouldShowStartupSummary()`
- `addStartupSummaryToTab()`
- `showStartupSummary()`

New module should export a mutable namespace:

```ts
export const startupSummary = { config?, text }
```

Inputs should be explicit: tab cwd/model, fallback model, role, pid, hostPid, perf snapshot helpers, usage data access. Do not import `client.ts`.

Expected impact:

- `client.ts`: -70 to -95 LOC
- repo net: roughly flat to slightly down if helpers simplify while moving

Why first:

- low behavior risk
- no tab-state mutation
- isolates recent growth caused by richer startup cards

Tests:

- add focused tests for startup text if behavior is not already covered
- run `src/client-startup.test.ts`, render tests, `./test`

### Step 2 — Extract session snapshot loading to `src/client/session-loader.ts`

Move the disk-to-tab snapshot work out of `makeTabFromDisk()`:

- load meta
- load fork-aware history and parent count
- load live blocks
- accumulate usage
- read context
- compute fork origin

Do **not** move `Tab` mutation policy blindly. Prefer returning a small snapshot:

```ts
interface LoadedSessionSnapshot {
	id: string
	name: string
	cwd: string
	model: string
	rawHistory: HistoryEntry[]
	parentEntryCount: number
	liveHistory: Block[]
	usage: TokenUsage
	contextUsed: number
	contextMax: number
	forkedFrom?: string
}
```

Then `client.ts` keeps `makeTab()` and assembles the `Tab`.

Expected impact:

- `client.ts`: -35 to -55 LOC
- repo net: flat/down if usage accumulation is cleaner than current inline loop

Tests:

- `src/client-startup.test.ts`
- `src/client-tab-selection.test.ts`
- any fork/session replay tests

### Step 3 — Extract tab-list reconciliation to `src/client/tabs.ts`

`applySessionList()` is 75 physical lines and owns several policies:

- preserve existing tab objects
- create tabs for new sessions
- prune recent tabs
- prune return-to-tab map
- choose active session
- lazy-load active/new tabs
- copy fork drafts
- startup summary for new open tabs
- fire tab-switch callback

This should be split into a pure planning function plus local side effects.

Good shape:

```ts
const plan = clientTabs.planSessionListUpdate({
	previousTabs,
	items,
	previousActiveIndex,
	recentTabs,
	returnToBySession,
	pendingOpen,
	preferredSession,
})
```

The plan returns:

- next tab order / created session ids
- target active session
- return-to-tab updates
- whether fork draft copy is needed
- which tabs should be background-loaded
- whether an open-tab startup summary is needed

`client.ts` applies the plan and still owns actual `Tab` objects and callbacks.

Expected impact:

- `client.ts`: -60 to -90 LOC
- new module: +45 to +70 LOC
- repo net: slight down or flat

Why after session-loader:

- a cleaner `makeTabFromDisk()` makes tab reconciliation smaller and less coupled

Tests:

- `src/client-tab-selection.test.ts`
- `tests/tabs.test.ts`
- `src/client-startup.test.ts`

### Step 4 — Extract client persistence/watch bootstrap to `src/client/startup.ts`

Move cohesive process-wiring pieces:

- `ClientStateFile`
- `defaultClientState()`
- `loadClientState()`
- `saveClientState()` helper logic, but keep `client.saveState()` API stable
- `startWatchingHostLock()`
- `startWatchingIpcState()`
- maybe `initializeSessions()` preferred-session selection helper

Do this only after steps 1–3, because otherwise it becomes the new junk drawer.

Expected impact:

- `client.ts`: -100 to -160 LOC
- new module: +80 to +130 LOC
- repo net: flat to slightly down

Tests:

- `src/client-startup.test.ts`
- `tests/main.test.ts`
- `tests/tabs.test.ts`

### Step 5 — Consider event reducer extraction only after the above

`handleEvent()` is 143 physical lines, but it is risky because it mixes:

- delayed pause scheduling/flushing
- live-event application
- final response dedupe
- blob reload after tool-result
- repaint policy
- draft_saved behavior

Possible safer seam:

- leave delayed-pause and repaint in `client.ts`
- extract small handlers for event families:
	- stream events
	- response/info events
	- tool events
	- draft events

Expected impact:

- `client.ts`: -80 to -120 LOC
- repo net: probably flat

This is a good finisher if the previous steps still leave `client.ts` above 500.

## Expected outcome for `client.ts`

Conservative path:

- Step 1: 1008 → ~925
- Step 2: ~925 → ~880
- Step 3: ~880 → ~800
- Step 4: ~800 → ~660
- Step 5: ~660 → ~540

That still may not hit 500 if done conservatively. To reliably get under 500, we likely need either:

- a stronger Step 4 that moves startup/session initialization fully, or
- a final small extraction of command construction / continue-action logic.

Aggressive but still reasonable path:

- startup summary
- session loader
- tab reconciliation planner
- persistence/watch startup
- event-family handlers

Expected `client.ts`: **430–500 LOC**.

## What not to do for `client.ts`

- Do not push prompt/draft behavior into `src/cli/prompt.ts` or `src/client/cli.ts` if those are near 500.
- Do not create `src/client/state.ts` that simply contains the same god object plus wrappers.
- Do not move `handleEvent()` wholesale without clarifying ownership of delayed pause/repaint/blob reload.
- Do not count an extraction as success if repo `bun cloc` goes up materially.

---

# Plan 2: `src/server/runtime.ts`

Current size: **690 LOC**.

## Why it grew

`runtime.ts` is the server equivalent of `client.ts`: it owns process-level orchestration and therefore attracts every cross-cutting server feature:

- active session ordering
- session open/fork/resume/move/close
- shared state broadcast
- prompt dispatch
- command handling
- context estimate publishing
- reset/compact maintenance
- generation lifecycle
- spawn-agent lifecycle
- model metadata refresh and alias suggestions
- startup recovery / interrupted tool repair / auto-continue
- MCP and inbox startup
- command tail loop

The file grew again because model metadata refresh, spawn handling, target-cwd startup, and richer command/open behavior all landed in the runtime orchestrator.

## Best architectural alternatives

### Alternative A — Runtime remains orchestrator; extract side domains

Move clear side domains out:

- `src/server/model-refresh.ts`
- `src/server/runtime-startup.ts`
- `src/server/session-maintenance.ts`
- `src/server/spawn.ts`

Runtime keeps:

- active session order
- command loop
- dispatch to domain helpers
- IPC broadcast

Pros:
- straightforward
- reduces runtime fast
- preserves current runtime state model

Cons:
- can become wrapper-heavy if helpers are not real owners

Verdict: recommended.

### Alternative B — Command handlers as a table/module

Move most `handleCommand()` cases into a command handler table with injected runtime operations.

Pros:
- large visible reduction from `runtime.ts`
- `handleCommand()` becomes declarative

Cons:
- risks adding an adapter layer
- overlaps with `runtime/commands.ts`, which is also near/over 500

Verdict: useful only after runtime side domains are extracted.

### Alternative C — Server runtime supervisor + session controller

Split into:

- supervisor: startup, locks, watchers, tail loops
- session controller: active sessions, open/fork/resume/close/move
- generation controller: prompt/generation/context/reset/compact

Pros:
- cleanest architecture
- good long-term boundary

Cons:
- larger refactor
- higher behavior risk

Verdict: good long-term target, but not necessary to get under 500.

## Recommended path

### Step 1 — Extract model metadata refresh to `src/server/model-refresh.ts`

Move:

- `formatModelRefreshMessage()`
- `buildAliasUpdateSuggestionText()`
- `emitSyntheticAssistant()`
- `suggestAliasUpdates()`
- `refreshModelMetadata()`

New module receives callbacks/dependencies explicitly where needed:

- active metas or session list
- `broadcastInfo`
- `appendHistorySync` / `appendEvent` through existing namespaces

Better shape:

```ts
export const modelRefresh = {
	refresh,
	formatModelRefreshMessage,
	buildAliasUpdateSuggestionText,
}
```

Expected impact:

- `runtime.ts`: -70 to -95 LOC
- repo net: flat/down if prompt builders simplify slightly

Why first:

- very cohesive
- weakly coupled to command/generation logic
- recent growth clearly belongs here

Tests:

- move or add tests currently covering `runtime.formatModelRefreshMessage()` / alias suggestion text
- run `src/server/runtime.test.ts`, model tests, `./test`

### Step 2 — Extract spawn-agent lifecycle to `src/server/spawn.ts`

Move:

- `SpawnSpec` alias if useful
- `buildSpawnPrompt()`
- `spawnSession()`
- `startSpawnedSession()`

Keep runtime-owned insertion/broadcast rules explicit. The new module can accept a small operations object:

- `createSessionTab`
- `dispatchPromptCommand`
- `publishContextEstimate`
- `recordSessionInfo`

Alternative: keep `spawnSession()` in runtime if injecting too many operations would add more LOC than it removes. In that case only move `buildSpawnPrompt()` and prompt lifecycle text.

Expected impact:

- `runtime.ts`: -35 to -55 LOC
- repo net: flat/slightly down

Tests:

- `src/tools/spawn_agent.test.ts`
- `src/server/runtime.test.ts`
- any tabs/spawn integration tests

### Step 3 — Extract reset/compact maintenance to `src/server/session-maintenance.ts`

Move shared maintenance logic for:

- active-generation guard
- old log lookup
- rotation rewrite
- context estimate republish callback
- user-facing info text

Good API:

```ts
sessionMaintenance.reset(sessionId, ops)
sessionMaintenance.compact(sessionId, ops)
```

But avoid a giant `ops` object. If the ops list gets too long, keep the helper local in `runtime.ts` and just dedupe in place.

Expected impact:

- `runtime.ts`: -25 to -40 LOC
- repo net: flat/down

### Step 4 — Extract startup recovery and service startup to `src/server/runtime-startup.ts`

Move from `startRuntime()`:

- interrupted-tool repair loop
- auto-continue scan
- dynamic MCP startup
- inbox startup
- maybe abort cleanup wiring

Keep in runtime:

- initializing `state.activeRuntimePid`
- loading active session ids
- target-cwd activation
- broadcast timing
- tail command loop, unless step 5 handles it

Expected impact:

- `runtime.ts`: -70 to -110 LOC
- repo net: flat/down

Tests:

- `tests/main.test.ts`
- `tests/ipc.test.ts`
- `tests/tabs.test.ts`
- `src/runtime/agent-loop.test.ts`

### Step 5 — Simplify `handleCommand()` after domain extraction

Current `handleCommand()` is 126 physical lines. After spawn/reset/compact/open helpers are improved, reduce it to routing:

- one helper for session-required commands
- one helper for `open` command variants
- one helper for `resume`
- command cases call named operations

Expected impact:

- `runtime.ts`: -30 to -60 LOC
- repo net: small down

## Expected outcome for `runtime.ts`

Conservative:

- model refresh: 690 → ~610
- spawn: ~610 → ~565
- maintenance/startup: ~565 → ~490

This should get under 500 without touching `runtime/commands.ts` or `agent-loop.ts`.

Aggressive:

- model refresh + runtime startup + command dispatch cleanup could land around **430–470 LOC**.

## What not to do for `runtime.ts`

- Do not move logic into `runtime/commands.ts`; it is already above 500 in current cloc.
- Do not make `sessions.ts` a dumping ground; it is currently safely below 500.
- Do not create a generic “runtime manager” wrapper that just mirrors functions.
- Do not repeat old failed dedupe attempts unless current code visibly changed.

---

# Plan 3: `src/cli/prompt.ts`

Current size: **556 LOC**.

## Why it grew

`prompt.ts` combines editor behavior and rendering:

- word wrapping
- cursor-to-row/col mapping
- row/col-to-cursor mapping
- vertical movement across wrapped rows
- simple word movement
- option/cmd word movement with punctuation rules
- editor state
- selection
- undo/redo
- history browsing
- kill/yank
- OS clipboard write/paste
- async paste placeholder replacement
- key dispatch
- prompt rendering with selection highlighting
- public API

The file grew because correctness fixes naturally landed inside the only module that understands both editing state and wrapped layout.

## Best architectural alternatives

### Alternative A — Extract wrapped layout/cursor mapping

Move layout-specific code into `src/cli/prompt-layout.ts`:

- `wordWrapLines()`
- `getLayout()`
- `cursorToRowCol()`
- `rowColToCursor()`
- `verticalMove()`
- possibly selection rendering spans

`prompt.ts` keeps editor state and key handling.

Pros:
- cleanest conceptual boundary
- solves a real ownership issue
- could later make width correctness easier

Cons:
- may be repo-LOC flat/up unless code is simplified while moving
- must respect terminal width rules; current code is `.length`-based and not `visLen()`-based

Verdict: best architecture if we are willing to add/adjust tests first.

### Alternative B — Extract keymap/action table

Keep layout local, but make key handling declarative:

- action helpers remain in prompt
- key dispatch becomes a small table or grouped helper functions

Pros:
- low risk
- can save enough lines to get under 500 if done well

Cons:
- does not address layout ownership
- previous pass already did some key-handler shrinking, so remaining savings may be smaller

Verdict: best small first pass if we only need -56 LOC.

### Alternative C — Extract editor core shared with `line-editor.ts`

Create a small shared primitive module for:

- clamp
- selection range
- move with optional selection
- replace selection
- delete selection

Pros:
- real shared domain
- can reduce both prompt and line-editor

Cons:
- `line-editor.ts` is only 134 LOC, so the savings ceiling is low
- generic editor-core can become abstraction-heavy fast

Verdict: only do if the helper is tiny and repo LOC goes down.

## Recommended path

Use a hybrid of A and B, but with tests first.

### Step 1 — Add behavior-locking tests before layout/key changes

Add or verify tests for:

- history browse restores draft after up/down
- redo after grouped typing undo
- wrapped selection rendering
- exact-width blank-line cursor after edits
- emoji/CJK prompt width behavior if touching layout
- cmd/option word movement around punctuation
- async placeholder replacement when the placeholder is missing or cursor moved

Expected impact:

- tests add LOC, but protect the reduction

### Step 2 — Extract layout/cursor mapping to `src/cli/prompt-layout.ts`

Move the layout functions and keep them pure:

```ts
export const promptLayout = {
	wordWrapLines,
	getLayout,
	cursorToRowCol,
	rowColToCursor,
	verticalMove,
}
```

Potential improvement:

- use `visLen()` / width-aware helpers where practical
- if full width-correct rewrite grows too much, defer correctness and move only current behavior

Expected impact:

- `prompt.ts`: -70 to -90 LOC
- new module: +60 to +85 LOC
- repo net: flat/slightly down

This alone should bring `prompt.ts` under 500.

### Step 3 — Compact word movement helpers

Current `optionWordLeft()` and `optionWordRight()` are about 58 physical lines. They are behavior-heavy, but some duplication can be reduced:

- local helpers for whitespace/separator/token scanning
- small scanner functions: `skipLeft`, `skipRight`, `isSeparator`
- keep comments for tricky punctuation behavior

Expected impact:

- `prompt.ts`: -10 to -20 LOC
- repo net: down if helpers are smaller than repeated loops

### Step 4 — Move clipboard write into `src/cli/clipboard.ts`

`prompt.ts` currently owns `writeToClipboard()` while `clipboard.ts` already owns paste behavior.

Move a tiny `clipboard.copy(text)` helper.

Expected impact:

- `prompt.ts`: -7 to -9 LOC
- `clipboard.ts`: +4 to +7 LOC
- repo net: small down/flat

### Step 5 — Final key dispatch cleanup if still needed

If still over 500 after steps 2–4:

- split `handleKey()` into `handleCtrlKey`, `handleNavigationKey`, `handleTextInput`
- or use a very small action table for simple ctrl keys

Avoid overengineering; current `handleKey()` is readable and already partly compacted.

Expected impact:

- `prompt.ts`: -10 to -25 LOC

## Expected outcome for `prompt.ts`

Conservative:

- layout extraction: 556 → ~475
- clipboard: ~475 → ~468

Aggressive:

- layout extraction + word scanner cleanup + key cleanup: **430–470 LOC**

## What not to do for `prompt.ts`

- Do not push prompt state into `client.ts`; it is already the biggest offender.
- Do not create a broad editor framework.
- Do not rewrite width behavior without tests.
- Do not trade 56 removed LOC for 100 LOC of new abstraction.

---

# Suggested implementation order

1. `src/cli/prompt.ts`
	- smallest overage, clearest seam, fastest win
2. `src/server/runtime.ts`
	- model-refresh extraction should produce a meaningful reduction with low risk
3. `src/client.ts`
	- largest and most architectural; do after the smaller wins, with careful review after each extraction

If the goal is to stop all immediate >500 violations, add quick follow-up plans for:

- `src/runtime/agent-loop.ts` — 532
- `src/runtime/commands.ts` — 530
- `src/cli/blocks.ts` — 514

Those are close enough that targeted local cleanup may be enough.
