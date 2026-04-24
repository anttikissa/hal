# LOC reduction plan for `src/server/sessions.ts`

## Current size

- `bun cloc src/server/sessions.ts` → **488 LOC**

## Review verdict

This file still has real reduction room, but the original plan mixed a few strong deletions with a few weaker “helperization” ideas that could turn into split-and-add-glue.

After checking the current code and nearby usages, the strongest one-pass path is:

1. delete code and persisted fields that are actually unused
2. collapse the fake async / sync wrapper pairs
3. dedupe the duplicated live-file plumbing **locally inside this file**
4. only then do a small reducer cleanup if needed to get under 400

That path targets **net repo LOC reduction**, not file shuffling.

---

## Verified findings from current code

These are grounded in the current tree, not guessed from old plans.

### Dead or likely-dead items

#### 1) `pruneConfig` + `pruneSessions` look dead

- `src/server/sessions.ts` defines them and exports them.
- `rg` found no production callers outside this module/export surface.
- That makes this the best first delete.

**Estimated impact:** **-35 to -40 LOC** in `sessions.ts`, roughly flat-or-down repo-wide.

#### 2) `SessionLive.busy`, `activity`, `updatedAt` look dead in production

What I verified:

- production `loadLive()` usage is `src/client.ts`, and it reads **only** `.blocks`
- session busy/activity truth lives in shared IPC state, not in `live.ason`
- tests stub these fields, but production code does not appear to depend on them

So the likely cleanup is:

- narrow `SessionLive` to `{ blocks: any[] }`
- shrink `defaultLive()` / `fixLive()`
- delete timestamp mutation from `saveLive()`
- update test stubs that currently return extra fields

**Estimated impact:** **-10 to -18 LOC** in `sessions.ts`, plus small test cleanup.

**Watch:** `src/client-startup.test.ts`, `src/runtime/commands.test.ts`, `src/server/sessions.test.ts`

#### 3) `SessionMeta.lastPrompt` is unused; `parentSessionId` appears write-only

What I verified:

- `lastPrompt` only appears in the type definition and this plan file
- `parentSessionId` is defined in `SessionMeta` and written in `src/server/runtime.ts`, but I found no readers

This is a real cleanup opportunity, but small.

**Estimated impact:** **-2 to -4 LOC** in `sessions.ts`, plus **-1 LOC** in `src/server/runtime.ts`

#### 4) `'session'` history entries currently have consumers but no producer

This needed tightening from the original plan.

What I verified:

- no current production writer for `{ type: 'session', ... }`
- there **are** consumers:
	- `src/cli/blocks.ts`
	- `src/session/api-messages.ts`
	- one focused test in `src/cli/blocks.test.ts`

So this is still a valid delete candidate, but the plan must account for all consumers. The win is repo-wide only if you remove the dead format end-to-end, not just from the union.

**Estimated impact:** **-8 to -15 LOC** in `sessions.ts`, plus more in `cli/blocks.ts` and `session/api-messages.ts`

**Risk:** if model-change history is about to be implemented, deleting the dormant format removes that placeholder path. Today that looks acceptable because there is no writer.

---

## Strong reduction ideas that are actually grounded

### 1) Collapse the fake async meta API

Current code:

- `createSession()` is `async` but does synchronous work
- `updateMeta()` is `async` but just mutates a live object and saves it
- `rotateLog()` is `async` only because it calls `updateMeta()`

This is a real LOC target because it also deletes wrapper noise in callers:

- `void sessionStore.createSession(...)` comments in `src/server/runtime.ts`
- `void` / `await` around `updateMeta()` in `runtime.ts` and `agent-loop.ts`

Best version for LOC reduction:

- make the meta path synchronous
- preferably keep **one** mutating helper, local to this module
- do **not** replace it with a new abstraction layer spread across files

**Estimated impact:** **-15 to -25 LOC** in `sessions.ts`, plus a few more in callers.

### 2) Collapse `appendHistory` + `appendHistorySync` into one path

This is also real. Today the only difference is `appendFile` vs `appendFileSync`.

For LOC reduction, the best option is:

- keep a single synchronous implementation
- remove `appendHistorySync`
- update callers to use one function

Why sync is the best reducer here:

- writes are tiny ASONL appends
- the codebase already relies on sync file writes in nearby places
- keeping both APIs preserves duplication for little benefit

**Estimated impact:** **-8 to -12 LOC** in `sessions.ts`, plus cleanup in `src/server/runtime.ts`

**Risk:** behavior change is small but real, so this should stay in the first pass only if tests keep passing.

### 3) Dedupe the duplicated live/meta live-file plumbing, but keep it local

This is the biggest remaining internal duplication that is worth touching.

Repeated twice today:

- cache map lookup
- disk fallback read
- `liveFiles.liveFile(..., { watch: false })`
- normalize/fix
- save/update path

A **local helper inside `sessions.ts`** is credible.

A broader `liveFiles.liveFile(..., normalize)` API is **not** the best first-pass plan here, because it risks moving code around and adding glue instead of reducing net LOC.

**Estimated impact:** **-15 to -25 LOC** in `sessions.ts`

**Recommendation:** do this only as a local reducer in this file on the first pass.

### 4) Small `applyLiveEvent()` cleanup is credible, but keep it modest

`applyLiveEvent()` has real duplication in the assistant/thinking streaming branches.
A small helper for “append-or-start streaming text block” is plausible.

But this should be a **small** cleanup, not a rewrite.

**Estimated impact:** **-5 to -15 LOC**

**Recommendation:** only do this if the file is still above target after the safer deletions and API collapse.

---

## Ideas to demote or skip in the first pass

These were the parts of the earlier plan most likely to become split-and-add-glue.

### 1) Do **not** start with tiny wrapper trimming

Candidates like:

- `ensureSessionDir`
- `sessionLivePath`
- `sessionMetaPath`
- `collectMetas`

might save a few lines, but they are weak first moves. They easily become noisy churn for small payoff.

**Use only as opportunistic follow-up** after bigger simplifications land.

### 2) Do **not** start with type-compression tricks

Examples like:

- `type Timed<T> = T & { ts?: string }`
- removing `text?: never`

may save a handful of lines, but they are easy to overestimate and can make the unions harder to scan.

**Good only if the final diff proves a real win.** Not a primary plan item.

### 3) Defer fork-model redesign

The larger idea “stop persisting `forked_from` and synthesize it from metadata” is real, but it is **not needed** to get this file under 400.

Today it touches:

- `src/server/sessions.ts`
- `src/server/runtime.ts`
- `src/session/blob.ts`
- tests in `src/server/sessions.test.ts`, `src/server/runtime.test.ts`, `src/tools/read_blob.test.ts`, `tests/tabs.test.ts`

That is second-wave work, not the fastest one-pass reducer.

### 4) Defer `liveFiles` utility generalization unless reused immediately

Adding normalization hooks to `src/utils/live-file.ts` only makes sense if the same change is applied right away to other modules and the repo `cloc` still goes flat or down.

For this plan, keep the first pass local.

---

## Best one-pass execution path

This is the strongest sequence if the goal is **under 400 LOC with flat-or-down repo cloc**.

### Phase 1: real deletions first

1. Delete `pruneConfig` + `pruneSessions`
2. Remove dead `SessionLive` fields and their normalization/writes
3. Remove dead `SessionMeta` fields: `lastPrompt`, `parentSessionId`
4. Delete dead `'session'` history entry support **only if** you remove its consumers too:
	- `src/cli/blocks.ts`
	- `src/session/api-messages.ts`
	- related test/docs references

**Expected gain:** roughly **55 to 75 LOC repo-wide**

### Phase 2: collapse duplicate APIs

5. Make session meta operations synchronous
6. Delete `updateMeta()` as a separate async wrapper, or make it the single sync mutator
7. Collapse `appendHistory` + `appendHistorySync` into one implementation

**Expected additional gain:** roughly **20 to 35 LOC**

### Phase 3: local dedupe only

8. Add one local helper for cached live-file-backed data
9. Reuse it for both session meta and live state

**Expected additional gain:** roughly **15 to 25 LOC**

### Phase 4: only if still needed

10. Do a modest `applyLiveEvent()` dedupe
11. Opportunistically trim tiny wrappers if the diff is still clearly net-negative

**Expected additional gain:** roughly **5 to 15 LOC**

---

## Is under 400 reachable in one pass?

**Yes, probably without touching the fork model.**

Starting point: **488 LOC**

Credible first-pass path:

- dead pruning code: **~35 to 40**
- dead `SessionLive` fields: **~10 to 18**
- dead `SessionMeta` fields: **~2 to 4**
- dead `'session'` format + consumers: **~8 to 15** in this file, more repo-wide
- sync meta API collapse: **~15 to 25**
- append-history duplication collapse: **~8 to 12**
- local live/meta plumbing dedupe: **~15 to 25**

That is enough to make **sub-400 realistic in one pass**, while still keeping repo `cloc` flat or down, **if the execution stays local and deletion-first**.

---

## Risks / behavior to protect

### Must-protect behaviors

- creating a session still writes a usable `session.ason`
- open sessions still keep live meta objects wired through `liveFiles`
- closed sessions still load from disk
- `loadHistory()` still honors `currentLog`
- `rotateLog()` still preserves reset/compact behavior
- forked sessions still inherit parent history correctly
- inherited blobs across forks still resolve correctly
- live blocks still:
	- append streamed text correctly
	- close on tool/info/error transitions
	- preserve assistant continuation IDs across interruptions
	- attach tool results to the right tool block

### Tests to watch closely

Primary:

- `src/server/sessions.test.ts`
- `src/server/runtime.test.ts`
- `src/runtime/agent-loop.test.ts`
- `src/client-startup.test.ts`

Secondary if `'session'` or fork logic changes:

- `src/cli/blocks.test.ts`
- `src/session/api-messages.test.ts`
- `src/tools/read_blob.test.ts`
- `src/session/attachments.test.ts`
- `tests/tabs.test.ts`

Also keep an eye on compatibility with existing on-disk `state/sessions/*` ASON/ASONL data.

---

## Bottom line

The plan is now tighter.

The strongest execution path is:

- **delete dead things first**
- **collapse fake async/sync duplication second**
- **dedupe locally, not by introducing new shared glue**
- **defer fork-model redesign**

That is the clearest path to a real one-pass reduction below **400 LOC** without cheating by splitting the module.