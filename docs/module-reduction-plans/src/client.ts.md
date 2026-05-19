# `src/client.ts` under-500 plan

Current measurement on 2026-05-19:

- `src/client.ts`: **1068 bun-cloc LOC**
- repo total from full `bun cloc`: **15114 LOC**
- `./test`: **706 pass, 0 fail** before planning

This is a planning document only. The user should review/refine before implementation.

## Why this file keeps growing

`client.ts` is the broadest client-side ownership point. It currently owns:

- tab/session state shape and active-tab navigation
- recent-tab and return-to-tab policy
- input history and draft persistence glue
- client-state persistence (`client.ason`)
- startup summary text and model/quota presentation
- session loading from disk, including fork-aware history, live blocks, usage, context
- history/live reconciliation
- live IPC event handling and repaint decisions
- delayed `[paused]` notice logic
- tool-confirmation dialog callback plumbing
- continue/retry/max-iteration status scanning
- stale/last-active session notices
- command construction and pending open/fork/resume focus hints
- IPC state watching, host-lock watching, and event tailing
- background loading of histories/blobs
- startup selection from cwd/restart/saved tab
- test reset/export surface

There is no single dead block large enough to solve this. The real problem is unresolved ownership: new behavior lands here because this file can see all state.

## Current large chunks

Large current functions/regions by physical line count:

- `handleEvent()` — still the largest function, now includes tool-confirmation events plus stream/response/info/tool/draft handling
- `initializeSessions()` — still owns saved-tab/restart/cwd preference and startup restore
- `applySessionList()` — still owns tab reconciliation, return-to-tab, fork draft copy, and startup-summary-on-open
- `startup summary/model/quota helpers` — still a cohesive presentation block worth moving first
- `makeTabFromDisk()` plus stale/last-active notice helpers — now a stronger session-loader/snapshot seam than before
- `save/load client state + watchers + startClient()` — still a cohesive bootstrap/persistence seam
- continue/retry status scanning and command construction — small finalizer seams

## Architecture alternatives

### Alternative A — Keep `client.ts` as state owner, extract pure helpers

Extract cohesive helpers while `client.ts` remains owner of `state`, callbacks, and exported namespace:

- `src/client/startup-summary.ts`
- `src/client/session-loader.ts`
- `src/client/tabs.ts`
- later, maybe `src/client/startup.ts` or `src/client/events.ts`

Pros:

- easiest to review incrementally
- least risky for hot-patching/eval friendliness
- avoids inventing a second state owner

Cons:

- repo LOC may be flat if extraction is too wrapper-heavy
- `client.ts` remains central

Verdict: recommended first architecture.

### Alternative B — Client model + reducers

Introduce a `ClientModel` object and reducers:

- `clientTabs.applyList(model, items, opts)`
- `clientEvents.applyEvent(model, event, opts)`
- `clientStartup.initialize(model, shared, opts)`

Pros:

- cleaner long-term state model
- better tests without global reset gymnastics

Cons:

- larger refactor
- may add type/glue LOC before shrinking
- riskier around drafts, delayed pauses, and background loading

Verdict: good long-term, but too large for first pass unless done gradually.

### Alternative C — UI session store

Move most tab/session state into `src/client/session-store.ts`; `client.ts` becomes process wiring.

Pros:

- biggest `client.ts` reduction

Cons:

- easy to create a new god module
- could simply rename the problem

Verdict: only acceptable if the new store has a tight API and stays well below 500.

## Recommended execution path

### Step 1 — Extract startup summary text

Move to `src/client/startup-summary.ts`:

- `formatHomePath()`
- `titleWords()`
- `providerDisplayName()`
- `chatGptSubscriptionText()`
- `quotaWindowText()`
- `startupQuotaLine()`
- `startupModelLine()`
- `startupPerfText()`
- `startupSummaryText()`

Keep mutation in `client.ts`:

- `shouldShowStartupSummary()`
- `addStartupSummaryToTab()`
- `showStartupSummary()`

Expected impact:

- `client.ts`: -70 to -95 LOC
- repo net: flat/slightly down if helpers simplify while moving

Why first: low risk and isolates recent growth around richer startup cards.

### Step 2 — Extract session snapshot loading

Move disk-to-tab snapshot work into `src/client/session-loader.ts`:

- load meta
- load fork-aware history and parent count
- load live blocks
- accumulate usage
- read context
- compute fork origin
- compute last-active/stale-session notice inputs

Return a plain snapshot. Let `client.ts` still assemble the `Tab`.

Expected impact:

- `client.ts`: -45 to -75 LOC
- repo net: flat/down

### Step 3 — Extract tab-list reconciliation planning

`applySessionList()` is a mixed policy function. Extract a pure planner to `src/client/tabs.ts` that decides:

- target active session
- return-to-tab map updates
- which tabs are new/opened
- fork draft-copy request
- background-load needs
- open-tab startup-summary request

`client.ts` applies the plan and keeps actual side effects.

Expected impact:

- `client.ts`: -60 to -90 LOC
- new module: +45 to +70 LOC
- repo net: flat/slightly down

### Step 4 — Extract client persistence/watch startup

Only after steps 1–3, move cohesive process/bootstrap code:

- `ClientStateFile`
- `defaultClientState()`
- `loadClientState()`
- `saveClientState()` internals
- `startWatchingHostLock()`
- `startWatchingIpcState()`
- possibly preferred-session startup selection helper

Expected impact:

- `client.ts`: -100 to -160 LOC
- repo net: flat/slightly down

### Step 5 — Extract event-family handlers if still above 500

`handleEvent()` is risky. Do not move it wholesale first. If needed, extract only event-family handlers:

- stream events
- response/info events
- tool events
- draft events

Keep delayed-pause ownership and repaint decisions explicit.

Expected impact:

- `client.ts`: -80 to -120 LOC
- repo net: likely flat

### Step 6 — Small finalizers if needed

If the file remains above 500 after ownership extractions:

- move command construction (`pendingTabActionForPrompt()`, `makeCommand()`) to a tiny `client/commands.ts`
- move continue/retry/max-iteration status scanning to a small pure helper
- move tool-confirm callback plumbing with event-family handlers, not as a standalone abstraction
- trim export surface if tests no longer need helper exports

Expected impact:

- `client.ts`: -25 to -55 LOC

## Expected outcome

Conservative execution may land around 540–660 LOC. To reliably get below 500, plan on:

1. startup summary extraction
2. session loader
3. tab reconciliation planner
4. persistence/watch startup extraction
5. one event-family handler extraction or a command-construction extraction

Target outcome: **430–500 LOC**.

## Tests to watch

- `src/client-startup.test.ts`
- `src/client-streaming.test.ts`
- `src/client-tab-selection.test.ts`
- `src/client/cli.test.ts`
- `src/server/sessions.test.ts`
- `tests/tabs.test.ts`
- `tests/main.test.ts`
- render tests

## Must not happen

- Do not push prompt behavior into `src/cli/prompt.ts`.
- Do not push runtime behavior into `src/server/runtime.ts`.
- Do not create a new `client/state.ts` god module.
- Do not move `handleEvent()` before clarifying delayed pause / repaint / blob reload ownership.
- Do not accept a split if repo `bun cloc` grows materially.
- Do not start by extracting all events wholesale; first remove startup/session-loader/tab-planner weight so event extraction has a clear boundary.
