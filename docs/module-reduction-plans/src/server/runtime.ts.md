# LOC-reduction review for `src/server/runtime.ts`

## Current measured size

Measured on the live branch:

- `bun cloc src/server/runtime.ts` → **580 LOC**
- `bun cloc` repo total → **12,782 LOC**

Current `src/` files above 500 LOC from the same run:

- `src/client.ts` — 954
- `src/runtime/commands.ts` — 656
- `src/server/runtime.ts` — 580
- `src/cli/prompt.ts` — 515

## Review verdict

**Partly valid, but too optimistic from current state.**

The previous runtime plan was directionally right about the remaining hotspots, but two parts are stale now:

- some earlier suggested savings have already been consumed by changes already on this branch
- the old claim that the first three reductions alone make **under 500** plausible is no longer supported by the live 580 LOC file

Current verdict:

- `src/server/runtime.ts` still has real deletion targets
- the best path is still **delete + dedupe**, not splitting the file into more wrappers
- **under 500 in one pass is still realistic**, but only if the pass lands **4-5 concrete deletions**, not just the first 3

## What I verified in the current code

Primary file:

- `src/server/runtime.ts`

Coupled files/tests requested for review:

- `src/server/runtime.test.ts`
- `tests/tabs.test.ts`
- `tests/ipc.test.ts`
- `src/main.ts`
- `src/server/sessions.ts`
- `src/runtime/commands.ts`
- `src/runtime/context.ts`
- `src/runtime/agent-loop.ts`

Verified facts from the live branch:

1. **The test-only adapter layer is still present**
	- `RuntimeSession`
	- `runtimeSession()`
	- `testMeta()`
	- test-only export wrappers at the bottom of `runtime.ts`

2. **Generation/context prep is still duplicated**
	- `runGeneration()` and `publishContextEstimate()` both load meta, resolve cwd/model, build the system prompt, build provider messages, and compute context-overhead inputs

3. **Reset/compact still repeat the same maintenance pattern**
	- host-lock guard
	- busy guard
	- timestamp/log lookup
	- history rotation rewrite
	- context republish

4. **Session lifecycle plumbing is still spread across three paths**
	- `openSession()`
	- `createForkSession()`
	- `spawnSession()`
	- they overlap on session creation/update and info-entry work, even though tab ordering should stay in runtime

5. **Startup glue is still duplicated inline in `startRuntime()`**
	- two similar lazy-start blocks for `mcp` and `inbox`
	- inline restart-recovery pass
	- inline command-tail loop

6. **Several ownership moves are already done, so they are no longer future savings**
	- `sessions.ts` already owns `createSession()`
	- `sessions.ts` already owns `pickMostRecentlyClosedSessionId()`
	- `sessions.ts` already owns `resolveResumeTarget()`
	- `sessions.ts` already owns `rewriteHistoryAfterRotation()`
	- `sessions.ts` already owns `detectInterruptedTools()`

## Stale or over-optimistic claims to remove from the old plan

These were the biggest problems in the previous draft:

- it still leaned on already-consumed reductions from older runtime versions
- it treated some cleanup as available savings when those lines are already gone
- it implied the first three deletions are enough to get below 500

That last point is the main correction.

From the **current 580 LOC** file:

- steps **1-3 only** are likely to stall around **520-540 LOC**
- steps **1-4** may still miss and land around **505-520 LOC** if the savings come in low
- the realistic one-pass route to **under 500** is **steps 1-5**, or at least 4 strong hits with one of them landing unusually well

## Strongest execution path, ordered by net LOC reduction

This ordering is for **real expected net deletion from `src/server/runtime.ts`**, not for “least scary edit first”.

### 1) Delete the test-only adapter layer first

Target:

- `RuntimeSession`
- `runtimeSession()`
- `testMeta()`
- test-only wrappers in the exported `runtime` object

How:

- make runtime tests use `SessionMeta` directly
- if tests want a friendlier builder, keep that builder in the test file, not in production runtime code
- keep production helpers typed around the real session shape instead of a second runtime-only shape

Why this is still the strongest first move:

- it is pure deletion from production code
- it removes a second fake “session” shape from the module
- it simplifies the export surface as well as the implementation

Expected effect:

- runtime: **-20 to -28 LOC**

### 2) Share session prompt/context preparation between `runGeneration()` and `publishContextEstimate()`

Good helper shape:

- one helper that returns:
	- `meta`
	- `cwd`
	- `model`
	- `promptResult`
	- `messages`
	- `overheadBytes`

Keep **outside** that helper:

- attachment resolution
- user-history append
- generation side effects

Why this is high value:

- the overlap is real right now
- both sites already depend on the same data
- this is dedupe, not ornamental extraction

Best homes:

- `src/runtime/context.ts` is a reasonable home for a **small** prompt/context helper
- keeping it in `runtime.ts` is also acceptable if that yields the smallest repo-wide diff

Avoid:

- adding a third prompt-prep abstraction that only wraps existing calls one-for-one

Expected effect:

- runtime: **-14 to -22 LOC**

### 3) Unify open/fork/spawn creation + info-entry plumbing

What to unify:

- session creation/update details
- info-entry recording
- close-when-done annotation

What to keep in runtime:

- `activeSessions`
- insertion order / tab ordering
- broadcast timing
- command dispatch behavior

Why this is third, not first:

- the overlap is real and the savings are real
- but it touches more behavior than steps 1-2, so it should ride on top of those easier deletions

Avoid:

- inventing a new “runtime session manager” module
- moving logic into `sessions.ts` just to hide LOC

Expected effect:

- runtime: **-12 to -20 LOC**

### 4) Replace duplicated lazy-start blocks with one tiny helper

Target the two inline blocks in `startRuntime()`:

- `mcp`
- `inbox`

Good shape:

- one helper that loads a runtime service module, starts it, and wires abort cleanup if needed

Why it is worth doing:

- the `.then(...).catch(...)` structure is visibly duplicated
- the reduction is real if the helper is tiny
- it deletes inline startup clutter without creating a new abstraction pile

Avoid:

- extracting the whole startup sequence into another file just to move lines

Expected effect:

- runtime: **-10 to -16 LOC**

### 5) Merge reset/compact into one maintenance helper path

Good shape:

- one shared idle-only guard helper
- one shared maintenance runner that does:
	- timestamp setup
	- old-log lookup
	- rotation rewrite
	- `publishContextEstimate()`
	- final user-visible info text

Why this is fifth, not earlier:

- it is still real dedupe
- but the current code is already fairly short, so the savings are smaller than the first four moves

Expected effect:

- runtime: **-8 to -14 LOC**

### 6) Only if still needed, do a same-file final sweep

Examples:

- trim tiny one-use wrappers left behind after the main dedupe
- simplify `handleCommand()` only after helpers already exist

Do **not** do this first.

On its own, this kind of cleanup usually produces tiny savings and can easily turn into churn.

## What must NOT happen during execution

1. **No split-and-glue refactor**
	- do not create a new orchestrator/manager/service module that just rehosts the same logic

2. **Do not dump code into `src/runtime/agent-loop.ts`**
	- it is already **498 LOC**
	- that file has effectively no headroom for this pass

3. **Do not push enough code into `src/server/sessions.ts` to create a new >500 file**
	- it is already **432 LOC**
	- only move a helper there if ownership is clearly correct and the net repo LOC still goes down

4. **Do not change behavior just to save lines**
	- tab ordering must stay the same
	- fork provenance/history behavior must stay the same
	- spawn auto-close behavior must stay the same
	- restart recovery must stay the same
	- prompt watch reload events must stay the same
	- host-lock safety checks must stay the same

5. **Do not count test cleanup as production reduction unless runtime code is actually deleted**
	- moving complexity from `runtime.ts` into a test helper is fine
	- leaving the production adapter layer in place is not

6. **Do not widen the pass into unrelated `commands.ts` cleanup unless it clearly reduces runtime too**
	- `commands.ts` has its own reduction work
	- this runtime pass should not turn into a side quest there

## Overlap risks and file-budget constraints

Important nearby files:

- `src/runtime/agent-loop.ts` — **498 LOC**
	- bad place to move helpers for this pass
- `src/server/sessions.ts` — **432 LOC**
	- acceptable home for a small ownership-correct helper, but watch the budget closely
- `src/runtime/context.ts` — **251 LOC**
	- safest home for a small shared prompt/context-prep helper if one is needed
- `src/runtime/commands.ts` — **656 LOC**
	- there is overlap in concepts, but that is a separate reduction target and should not absorb runtime logic casually

## Stop conditions

Stop and remeasure after step 2, and again after step 4.

Execution should stop and be reconsidered if any of these happen:

- the work is mostly moving code sideways instead of deleting it
- `src/server/sessions.ts` or `src/runtime/agent-loop.ts` starts approaching or crossing 500 LOC because of this pass
- the runtime file is still above about **505 LOC after step 4** and the only next idea is loop extraction
- the next proposed reduction is “move restart recovery” or “move command tail loop” without clear repo-wide savings

If that happens, do **not** force the file under 500 with fake extraction. Re-plan instead.

## Is under 500 in one pass still realistic?

**Yes, but not with the old three-step expectation.**

From the live 580 LOC state:

- **not realistic** if the pass is mostly cosmetic cleanup
- **not realistic** if it stops after steps 1-3
- **plausible** if it lands 4 strong reductions
- **realistic** if it lands steps **1-5** as real deletions rather than movement

Short version:

- old claim: **too optimistic**
- new claim: **still achievable, but requires a fuller pass and stricter stop conditions**

## Tests to watch

Always run:

- `./test`

Most relevant suites for this pass:

- `src/server/runtime.test.ts`
- `tests/tabs.test.ts`
- `tests/ipc.test.ts`
- `src/server/sessions.test.ts`
- `src/runtime/context.test.ts`
- `src/runtime/agent-loop.test.ts`
- `src/runtime/commands.test.ts`
- `tests/main.test.ts`

## Bottom-line execution plan

Recommended order from current state:

1. delete the test-only adapter layer
2. share generation/context preparation
3. unify open/fork/spawn creation + info-entry plumbing
4. dedupe the `mcp` / `inbox` lazy startup blocks
5. merge reset/compact maintenance flow
6. only then do a tiny same-file cleanup pass if still needed

That is the strongest current path for **real net LOC reduction**.

Anything else risks another miss at **520+ LOC** while still increasing abstraction.