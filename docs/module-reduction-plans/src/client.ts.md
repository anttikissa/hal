# `src/client.ts` under-500 plan

Current measurement on 2026-05-06:

- `src/client.ts`: **1008 bun-cloc LOC**
- repo total from full `bun cloc`: **13967 LOC**

This is a planning document only. The user should review/refine before implementation.

## Why this file keeps growing

`client.ts` is the broadest remaining client-side ownership point. It currently owns:

- tab/session state shape and active-tab navigation
- recent-tab and return-to-tab policy
- input history and draft persistence glue
- client-state persistence (`client.ason`)
- startup summary text and model/quota presentation
- session loading from disk, including fork-aware history, live blocks, usage, context
- history/live reconciliation
- live IPC event handling and repaint decisions
- delayed `[paused]` notice logic
- command construction and pending open/fork/resume focus hints
- IPC state watching, host-lock watching, event tailing
- background loading of histories/blobs
- startup selection from cwd/restart/saved tab
- test reset/export surface

The issue is not one big dead block. It is unresolved ownership: new features land here because this file can see all state.

## Architecture alternatives

### Alternative A — Keep `client.ts` as state owner, extract pure helpers

Extract cohesive helpers while `client.ts` remains owner of `state`, callbacks, and exported namespace:

- `src/client/startup-summary.ts`
- `src/client/session-loader.ts`
- `src/client/tabs.ts`
- later, maybe `src/client/startup.ts` or `src/client/events.ts`

This is the recommended first architecture: it reduces the file without inventing a second state owner.

### Alternative B — Client model + reducers

Introduce a `ClientModel` object and pure reducers:

- `clientTabs.applyList(model, items, opts)`
- `clientEvents.applyEvent(model, event, opts)`
- `clientStartup.initialize(model, shared, opts)`

This is cleaner long-term, but larger and riskier.

### Alternative C — UI session store

Move most tab/session state into `src/client/session-store.ts`; `client.ts` becomes process wiring.

This gives the biggest `client.ts` reduction, but risks simply renaming the god module unless the new store has a tight API and remains under 500.

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
- repo net: flat/slightly down

Why first: low risk and isolates recent growth around richer startup cards.

### Step 2 — Extract session snapshot loading

Move disk-to-tab snapshot work into `src/client/session-loader.ts`:

- load meta
- load fork-aware history and parent count
- load live blocks
- accumulate usage
- read context
- compute fork origin

Return a plain snapshot. Let `client.ts` still assemble the `Tab`.

Expected impact:

- `client.ts`: -35 to -55 LOC
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
