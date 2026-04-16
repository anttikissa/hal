# LOC-reduction plan for `src/server/runtime.ts`

## Current size

- `bun cloc src/server/runtime.ts`: **731 LOC**
- Current repo total from the same `bun cloc` run: **13,500 LOC**

## What I read before planning

Primary file:
- `src/server/runtime.ts`

Nearby tests / usages:
- `src/server/runtime.test.ts`
- `tests/tabs.test.ts`
- `tests/ipc.test.ts`
- `src/main.ts`
- `src/server/sessions.ts`
- `src/server/sessions.test.ts`
- `src/runtime/commands.ts`
- `src/runtime/context.ts`
- `src/runtime/agent-loop.ts`
- `src/session/replay.ts`
- `src/ipc.ts`

That is enough to see what this module owns today, what is already tested elsewhere, and where duplicate logic already exists.

## Responsibilities currently mixed together

`runtime.ts` is doing too many kinds of work at once:

1. **Open-tab in-memory state and ordering**
	- `activeSessions`
	- insert / move / find / sync to shared IPC state

2. **Session lifecycle orchestration**
	- create
	- fork
	- spawn
	- resume
	- close
	- auto-close after spawned subagent completion

3. **Prompt routing**
	- command vs non-command prompt handling
	- steering during active generation
	- inbox message queueing

4. **Generation orchestration around `agentLoop`**
	- build system prompt
	- resolve attachments
	- append history
	- compute provider messages
	- emit stream-start
	- keep shared busy/activity state in sync
	- close session when done

5. **Conversation maintenance operations**
	- reset
	- compact
	- context estimate publish

6. **Runtime startup / restart recovery**
	- load sessions
	- initial broadcast
	- prompt-file watch setup
	- restart marker handling
	- interrupted-tool recovery
	- auto-continue recovery

7. **IPC command pump**
	- tail commands
	- validate routing
	- per-command dispatch
	- error fencing

8. **Integration bootstrapping**
	- lazy MCP startup
	- lazy inbox watcher startup

9. **Temporary debug instrumentation**
	- command-pump logging to `/tmp/hal-command-pump.asonl`
	- preview/source helpers only used by that instrumentation

This is the main reason the file is large: it is not just “runtime”; it is runtime, tab manager, prompt router, recovery coordinator, and maintenance command handler.

## Big picture target

Getting under **500 LOC** is plausible, but probably **not** by tiny in-file cleanup alone.

The practical path is:
- delete obvious dead / temporary code first
- stop mirroring session metadata in two places
- merge duplicated logic with existing helpers in `sessions.ts`, `commands.ts`, and `context.ts`
- only then extract the leftover startup / pump chunks if still needed

My read: **under 500 is reachable in one pass**, but only if that pass includes a couple of small adjacent-module changes, not just cosmetic edits inside `runtime.ts`.

---

## Reduction ideas by type

## 1) Delete outright

### 1.1 Remove temporary command-pump debug logging

Code involved:
- `COMMAND_PUMP_DEBUG_LOG`
- `logCommandPump()`
- `commandPreview()`
- `commandSource()`
- most `logCommandPump(...)` call sites
- the extra `appendFileSync` / `ason` imports used only for this

Why this looks removable:
- The comments explicitly call it **temporary instrumentation**.
- It writes to `/tmp`, not user-visible state.
- None of the tests depend on it.
- It adds a lot of scaffolding around the hot path.

Estimated impact:
- **runtime.ts: -45 to -70 LOC**
- **repo total: same reduction**

Risk / tests to watch:
- Very low behavioral risk.
- Run `tests/ipc.test.ts`, `tests/tabs.test.ts`, `src/server/runtime.test.ts`.

### 1.2 Delete unused `mostRecentlyClosedSessionId()`

Code involved:
- `mostRecentlyClosedSessionId()` is defined but appears unused.

Estimated impact:
- **runtime.ts: -7 LOC**
- **repo total: -7 LOC**

Risk / tests to watch:
- Very low.
- Grep first, then delete.

### 1.3 Inline tiny one-use wrappers if they do not clarify anything

Candidates:
- `findSession()`
- possibly `broadcastSessions()`
- possibly `recordOpenedTab()` / `recordForkedTab()` if replaced by one shared helper or moved next to creation paths

This is not always worth doing, but some of these only add naming layers around trivial expressions.

Estimated impact:
- **runtime.ts: -5 to -15 LOC**

Risk / tests to watch:
- Low.
- Keep readability; do not inline everything blindly.

---

## 2) Simplify state ownership

### 2.1 Stop mirroring session metadata in a custom `Session` object

Current smell:
- `runtime.ts` defines its own `Session` interface.
- `activeSessions` stores copied session fields.
- `sessions.ts` already owns the real live session metadata.
- prompt commands mutate the runtime copy, then runtime persists those changes back to the session store.

That creates duplicated state and duplicated code:
- `Session` interface
- `sessionFromMeta()`
- `createSession()` local object creation
- session mutation syncing in `handlePrompt()`
- repeated `findSession()` / `activeSessions.map(...)` boilerplate
- subtle differences between `meta.name` / `meta.topic` / derived fallback naming

Better shape:
- let runtime own only **ordered open session ids**
- let `sessions.ts` own session metadata
- add a tiny helper like `getOpenSessionMeta(id)` or `mustSessionMeta(id)`
- `syncSharedState()` maps ids -> live metas
- prompt-command mutations update meta directly, not a copied runtime object

Why this is likely worth it:
- it removes an entire mirror state layer
- it shrinks several helpers at once
- it reduces correctness risk, not just LOC

Estimated impact:
- **runtime.ts: -45 to -80 LOC**
- **repo total: flat to -20 LOC** if done carefully in `sessions.ts`

Risk / tests to watch:
- Medium; touches core tab/session behavior.
- Watch:
	- `tests/tabs.test.ts`
	- `src/server/runtime.test.ts`
	- `src/runtime/commands.test.ts` for `/cd`, `/model`, `/rename`
	- `src/client-startup.test.ts`
	- `tests/render*.test.ts` indirectly through shared state

### 2.2 Make `sessions.createSession()` return the live meta it already creates

Current smell:
- runtime comment says `createSession()` is async “for API symmetry”, but the real work is sync.
- runtime creates a separate `Session` object, then calls `void sessionStore.createSession(...)`.

Possible simplification:
- let `sessions.createSession()` return the live `SessionMeta`
- runtime can insert the id immediately and use the returned meta, no parallel local object needed
- the comment explaining the weird async/sync mismatch can disappear

Estimated impact:
- **runtime.ts: -10 to -20 LOC**
- **repo total: flat to slightly down**

Risk / tests to watch:
- Low to medium.
- Mostly type / call-site churn.

---

## 3) Dedupe with existing session-store helpers

### 3.1 Move reset/compact log-rotation boilerplate into `sessions.ts`

Current duplication in runtime:
- `runReset()` and `runCompact()` both do all of this:
	- busy guard
	- load history
	- preserve `forked_from`
	- rotate log
	- append replacement entries into the new log
	- publish context estimate / info message

Also relevant:
- `src/server/sessions.test.ts` already contains tests for the fork-preservation pattern during reset/compact-style rotation.
- That is a strong sign the low-level behavior belongs in `sessions.ts`, not `runtime.ts`.

Concrete helper idea:
- `sessions.rewriteHistoryAfterRotation(sessionId, entries)`
- or two explicit helpers:
	- `sessions.resetConversation(sessionId, ts, oldLog)`
	- `sessions.compactConversation(sessionId, ts, oldLog, summaryText)`

Best version for LOC:
- one low-level helper in `sessions.ts` that:
	- rotates log
	- preserves `forked_from` if present
	- appends replacement entries
- runtime keeps only the high-level policy and messages

Estimated impact:
- **runtime.ts: -20 to -35 LOC**
- **repo total: flat to -10 LOC** because it can replace similar setup in `sessions.test.ts` and clarifies ownership

Risk / tests to watch:
- Medium.
- Watch:
	- `src/server/sessions.test.ts`
	- `src/session/api-messages.test.ts`
	- any render tests that depend on reset/compact blocks

### 3.2 Add one shared close/deactivate helper

Current duplication:
- auto-close in `runGeneration()`
- explicit close command in `handleCommand()`

Both paths do variants of:
- `updateMeta(...closedAt...)`
- `deactivateSession()`
- remove from `activeSessions`
- maybe create a new tab if none remain
- broadcast state

Concrete helper idea:
- `closeOpenSession(sessionId, opts)` inside runtime
- or `sessions.closeSession()` plus runtime-specific open-list update

Estimated impact:
- **runtime.ts: -15 to -25 LOC**
- **repo total: flat**

Risk / tests to watch:
- Medium.
- Watch:
	- `tests/tabs.test.ts`
	- close-on-subagent-complete behavior from `src/server/runtime.test.ts`

### 3.3 Use one startup mapper for session metas

Current duplication / inconsistency:
- `sessionFromMeta()` exists
- `startRuntime()` still manually maps `metas` to session objects instead of using it
- fallback naming logic differs

Even before deeper refactors, this should be unified.

Estimated impact:
- **runtime.ts: -5 to -10 LOC**
- possible small bug fix on session naming consistency

Risk / tests to watch:
- Low.
- `tests/tabs.test.ts` and client startup tests.

---

## 4) Dedupe with `runtime/commands.ts`

### 4.1 Share closed-session resume target lookup

Current duplication:
- `runtime.ts`
	- `pickMostRecentlyClosedSessionId()`
	- `resolveResumeTarget()`
- `commands.ts`
	- `closedSessionLines()`
	- `lookupClosedResumeTarget()`

These modules are solving the same problem twice:
- list closed sessions
- resolve a resume selector by id or name
- guard against already-open sessions

Concrete helper location:
- `sessions.ts` or a new tiny `src/server/session-targets.ts`
- functions like:
	- `listClosedSessions(openIds)`
	- `resolveClosedSessionSelector(metas, openIds, selector)`

Why this is high-value:
- reduces `runtime.ts`
- also reduces another already-large file, `src/runtime/commands.ts` (**656 LOC**)
- makes `/resume` and runtime behavior match exactly

Estimated impact:
- **runtime.ts: -10 to -20 LOC**
- **commands.ts: -15 to -25 LOC**
- **repo total: -15 to -30 LOC** net depending on helper shape

Risk / tests to watch:
- Low to medium.
- Watch:
	- `src/server/runtime.test.ts`
	- `src/runtime/commands.test.ts`

### 4.2 Share a “build command session snapshot” helper

Current duplication / verbosity:
- `handlePrompt()` manually builds `SessionState`
- a lot of that data is straightforward open-tab snapshot data

If active session ownership is simplified to ids + metas, a shared helper for command dispatch becomes even simpler.

Estimated impact:
- **runtime.ts: -10 to -15 LOC**
- **repo total: roughly flat**

Risk / tests to watch:
- Low.
- `src/runtime/commands.test.ts`

---

## 5) Dedupe with `context.ts` and `agent-loop.ts`

### 5.1 Share “session context estimate” calculation

Current duplication in runtime:
- `publishContextEstimate()` computes:
	- model
	- system prompt
	- tool defs size
	- provider messages
	- `context.estimateContext(...)`

Related duplication elsewhere:
- `agent-loop.ts` also computes context estimate and persists it in multiple places.
- `commands.ts` `/system` builds the system prompt separately.

Concrete helper idea:
- `context.estimateSessionContext({ sessionId, cwd, model, includeTools: true })`
- or `sessions/session-context.ts` helper that returns:
	- `model`
	- `systemPrompt`
	- `messages`
	- `used/max`

This helps runtime even if the first pass only uses it in `publishContextEstimate()` and `runGeneration()`.

Estimated impact:
- **runtime.ts: -10 to -20 LOC**
- **agent-loop.ts: additional reduction possible later**
- **repo total: flat to down** if reused immediately in at least two places

Risk / tests to watch:
- Medium, because it touches prompt/message sizing.
- Watch:
	- `src/runtime/context.test.ts`
	- `src/session/api-messages.test.ts`
	- `src/runtime/agent-loop.test.ts`

### 5.2 Collapse repeated “persist context estimate” call patterns

Related smell in `agent-loop.ts`:
- `sessions.updateMeta(sessionId, { context: { used, max } })` is repeated at several exit points.

If a shared helper is added, runtime and agent-loop can both use it.

Estimated impact:
- Mostly **cross-file benefit**, not huge runtime gain by itself.
- Worth calling out because it reduces another large file (`agent-loop.ts`, **523 LOC**).

Risk / tests to watch:
- `src/runtime/agent-loop.test.ts`

---

## 6) Simplify command dispatch

### 6.1 Split session-lifecycle cases out of `handleCommand()`

Current size:
- `handleCommand()` is about **126 LOC** and mixes tiny routing with long inline business logic.

Good candidates for dedicated helpers:
- `handleOpenCommand(...)`
- `handleSpawnCommand(...)`
- `handleResumeCommand(...)`
- `handleCloseCommand(...)`

Important note:
- this by itself does **not** reduce repo LOC much; it mostly moves code around.
- it becomes worthwhile only when paired with the dedupe ideas above.

Estimated impact:
- **runtime.ts: -30 to -60 LOC**
- **repo total: flat or slightly up** if done as pure extraction

Risk / tests to watch:
- Medium.
- Everything tab-related.

Recommendation:
- do **after** delete/dedupe work, not before.

### 6.2 Replace repeated switch branches with a small command-handler table only if the code becomes smaller

Possible, but risky from a LOC perspective:
- handler maps can become more abstract yet not shorter
- async + per-command session requirements can make it noisier, not leaner

Estimated impact:
- **runtime.ts: maybe -5 to -15 LOC**, maybe worse

Recommendation:
- low priority
- only do it if earlier refactors already isolate the command cases cleanly

---

## 7) Simplify prompt/generation flow

### 7.1 Pull command-mutation sync out of `handlePrompt()`

Current smell:
- `handlePrompt()` does slash-command handling, mutation diffing, persistence, info emission, and steering-triggered restart behavior all inline.

Concrete helper idea:
- `applyCommandSessionChanges(sessionId, before, sessionState)`
- or one helper returning `{ cwdChanged, modelChanged, nameChanged }`

Estimated impact:
- **runtime.ts: -10 to -20 LOC**
- **repo total: flat**

Risk / tests to watch:
- `/model`, `/cd`, `/rename`, steering retry behavior
- `src/runtime/commands.test.ts`

### 7.2 Pull “prepare generation inputs” into one helper

Current duplication inside `runGeneration()` / `publishContextEstimate()`:
- default model
- system prompt
- provider messages
- context-overhead calculation

Concrete helper idea:
- `prepareGenerationContext(session)` returns `{ model, promptResult, messages, overheadBytes }`

Estimated impact:
- **runtime.ts: -10 to -15 LOC**
- **repo total: flat or slightly down** if shared beyond one callsite

Risk / tests to watch:
- prompt and context estimate tests

### 7.3 Merge busy-guard logic for maintenance actions

Current duplication:
- `runReset()` and `runCompact()` both start with the same host-lock + busy checks

Concrete helper idea:
- `requireIdleSession(sessionId)`
- or `runIfIdle(sessionId, fn)`

Estimated impact:
- **runtime.ts: -5 to -10 LOC**

Risk / tests to watch:
- low

---

## 8) Simplify startup / recovery / integrations

### 8.1 Extract restart recovery pass as one helper or module

Current block inside `startRuntime()`:
- interrupted-tool detection
- placeholder tool-result writes
- auto-continue logic

This is a coherent responsibility on its own: **recover session state after host restart**.

Best home:
- `sessions.ts` or `replay.ts` adjacent helper
- or small `src/server/runtime-recovery.ts`

LOC reality:
- this is mostly movement unless some of the logic merges with existing `sessions.detectInterruptedTools()` / `replay.buildCompactionContext()` style helpers

Estimated impact:
- **runtime.ts: -25 to -45 LOC**
- **repo total: flat or slight up** unless paired with other dedupe

Risk / tests to watch:
- `src/server/runtime.test.ts`
- `src/runtime/agent-loop.test.ts`
- manual restart behavior

Recommendation:
- only if still above target after the lower-risk deletions/dedupes

### 8.2 Extract command-tail loop into its own helper

Current block inside `startRuntime()`:
- tail commands
- host-lock fencing
- stale-session filtering
- error handling
- temp debug logging

Without the debug logging, this block will already shrink a lot.

Estimated impact:
- **runtime.ts: -20 to -35 LOC**
- **repo total: flat**

Recommendation:
- do this only if needed for readability after removing the debug scaffolding

### 8.3 Extract lazy integration startup (`mcp`, `inbox`)

Current block inside `startRuntime()`:
- lazy import of `mcp/client.ts`
- shutdown hookup
- lazy import of `runtime/inbox.ts`

This is a nice extraction candidate, but mostly a move.

Estimated impact:
- **runtime.ts: -15 to -25 LOC**
- **repo total: flat or slightly up**

Recommendation:
- late, optional, readability-only

---

## 9) Merge with existing tests/helpers instead of adding new glue

These are the best “flat-or-down repo cloc” opportunities because they reduce more than one file.

### 9.1 Put reset/compact rewrite logic in `sessions.ts` and simplify `sessions.test.ts`

Why this matters:
- the tests already know that the fork-preserving rewrite behavior belongs near the session store
- moving it there reduces both runtime logic and test setup duplication

Estimated impact:
- small repo win, not just runtime win

### 9.2 Put closed-session lookup in one shared helper used by both runtime and commands

Why this matters:
- directly cuts both `runtime.ts` and `commands.ts`
- ensures `/resume` UX and actual runtime resume behavior stay aligned

### 9.3 Add one shared `errorMessage()` helper in `utils/helpers.ts`

Observation:
- `errorMessage(err)` is duplicated in several files, including `runtime.ts` and `ipc.ts`.

This is not a huge runtime-only win, but it is a legit cross-repo LOC reduction opportunity.

Estimated impact:
- **runtime.ts: -4 to -6 LOC**
- **repo total: likely down** once a few duplicates switch over

Risk / tests to watch:
- very low

---

## Ideas I would not prioritize

### Pure file-splitting without deleting or deduping anything

Example:
- move `startRuntime()` into `runtime-startup.ts`
- move `handleCommand()` into `runtime-commands.ts`

That can make `runtime.ts` smaller, but usually makes repo LOC **flat or higher** because of glue imports/exports and extra wrapper functions.

Given the stated goal, that should be a last resort, not the main plan.

### Fancy command-dispatch abstractions

A generic handler registry could look cleaner, but this code is already branching on a discriminated union. Abstraction might cost more lines than it saves.

---

## Risks / tests to watch by area

### Session/tab lifecycle changes
Watch:
- `tests/tabs.test.ts`
- `src/server/runtime.test.ts`
- `src/client-startup.test.ts`

Main risks:
- wrong tab order after open/fork/move/resume/close
- losing the “opened from” / “forked from” info entries
- failing to keep one tab open after closing the last session

### Resume-lookup dedupe
Watch:
- `src/server/runtime.test.ts`
- `src/runtime/commands.test.ts`

Main risks:
- `/resume` says one thing while runtime does another
- case-insensitive name matching changes unexpectedly

### Prompt/generation simplification
Watch:
- `src/runtime/commands.test.ts`
- `src/runtime/agent-loop.test.ts`
- `src/runtime/context.test.ts`
- `src/session/api-messages.test.ts`

Main risks:
- slash-command mutations not persisted
- wrong system prompt / wrong context estimate
- steering restart behavior breaking after `/model`

### Startup / recovery changes
Watch:
- `tests/ipc.test.ts`
- `src/server/runtime.test.ts`
- `src/runtime/agent-loop.test.ts`

Main risks:
- duplicate runtime-start behavior
- restart recovery not filling interrupted tool results
- auto-continue firing when it should not

---

## Recommended execution sequence

This sequence aims for **under 500 LOC in `runtime.ts`** while keeping total repo cloc **flat or down**.

### Step 1: delete dead / temporary code first

Do:
- remove command-pump temp logging, preview/source helpers, and unused imports
- remove `mostRecentlyClosedSessionId()`
- trim trivial wrappers that become obviously unnecessary afterward

Expected effect:
- **runtime.ts: roughly 731 -> 660 or better**
- repo total goes down immediately

Why first:
- cheap, safe, and it exposes the real shape of the remaining file

### Step 2: unify closed-session resume lookup with `commands.ts`

Do:
- introduce one shared closed-session resolver/list helper
- use it in both runtime and `/resume`

Expected effect:
- `runtime.ts` drops a little
- `commands.ts` drops too
- semantics become aligned

Why second:
- high confidence, real cross-file reduction

### Step 3: move reset/compact rewrite mechanics into `sessions.ts`

Do:
- add one low-level “rotate and rewrite” helper in `sessions.ts`
- simplify `runReset()` / `runCompact()` to policy-only code
- simplify corresponding `sessions.test.ts` setup where possible

Expected effect:
- noticeable runtime drop
- repo total flat or slightly down

Why third:
- the tests already indicate this behavior belongs there

### Step 4: stop mirroring session metadata in runtime

Do:
- replace `Session` mirror objects with ordered open ids + live metas from `sessions.ts`
- remove `sessionFromMeta()` and the sync-back dance in `handlePrompt()`
- make shared-state sync map from live session metas

Expected effect:
- this is the biggest structural LOC win
- also reduces correctness risk from runtime/meta drift

Expected impact:
- should bring `runtime.ts` close to the target on its own when combined with steps 1–3

### Step 5: add one close/deactivate helper and one generation-context helper

Do:
- unify auto-close + explicit close flow
- unify prompt/message/context preparation used by `runGeneration()` and `publishContextEstimate()`

Expected effect:
- smaller runtime hot paths
- less duplicated state mutation

### Step 6: only if still above 500, extract one cohesive startup chunk

Preferred extraction order:
1. restart recovery pass
2. lazy integrations (`mcp`, `inbox`)
3. command-tail loop

Why this order:
- recovery is the most conceptually separate responsibility
- integrations are mostly startup glue
- command tail loop is worth extracting only after debug logging is gone

Expected effect:
- this should comfortably push the file below **500 LOC** if earlier steps leave it slightly above

---

## Best reduction ideas

If I had to pick the highest-value set:

1. **Delete command-pump temp logging**
	- fastest true LOC win
	- low risk

2. **Stop duplicating session state in a custom runtime `Session` mirror**
	- biggest structural runtime win
	- reduces bugs as well as lines

3. **Move reset/compact rewrite mechanics into `sessions.ts`**
	- strong ownership fit
	- already supported by existing tests

4. **Share resume target lookup with `commands.ts`**
	- reduces two large files at once

5. **Unify close / auto-close paths**
	- good medium-sized cleanup with low conceptual risk

---

## Opportunities that would also reduce other large files

### `src/runtime/commands.ts` (656 LOC)
- shared closed-session lookup
- possibly shared command-session snapshot builder
- possibly shared system-prompt/context summary helper

### `src/runtime/agent-loop.ts` (523 LOC)
- shared session context-estimate / persist helper
- shared stream-end bookkeeping helper

### `src/server/sessions.ts` (488 LOC)
- this file may grow slightly, but if reset/compact rewrite logic lands there and replaces duplicated test/runtime logic, repo total can still go down
- it also becomes the clearer owner of session-log rewrite behavior

### `src/client.ts` / startup-adjacent code
- if session metadata becomes single-source-of-truth, some client/runtime state translation code may simplify later too

---

## Bottom line

- Current `runtime.ts` size: **731 LOC**
- **Under 500 is reachable in one pass**, but not from in-file cosmetics alone.
- The most realistic winning pass is:
	1. delete temp debug code
	2. share resume lookup with `commands.ts`
	3. move reset/compact rewrite mechanics into `sessions.ts`
	4. stop mirroring session metadata in runtime
	5. unify close/context helpers
	6. extract one startup chunk only if still needed

If done in that order, `runtime.ts` should get under target **without increasing total repo cloc**, and a few of the changes should shrink other already-large files too.
