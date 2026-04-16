# LOC reduction plan for `src/runtime/agent-loop.ts`

## Current size

- Current `bun cloc` LOC: **523**
- Physical lines right now: **697**
- Target: get this module **comfortably under 500 bun cloc LOC** with **flat-or-down total repo cloc**
- Practical reduction needed: only **24 bun cloc LOC**, but the real target should be **~40-70 LOC removed** so the file has headroom

## Review verdict

The original direction was mostly right, but it needed tighter sequencing.

The current code does have real delete/dedupe opportunities. This is **not** a case where the only way under 500 is splitting the switch into more files. A one-pass reduction is realistic if the pass starts with **deletions, existing-module ownership fixes, and in-file dedupe**, not new abstractions.

The most important correction is priority:

1. **delete dead and thin code first**
2. **move tool-specific logic to the tool that already owns it**
3. **share only already-duplicated helpers across existing modules**
4. **only then add one or two local helpers inside `agent-loop.ts`**

That order makes under-500 reachable with repo cloc flat or down. Starting with new helper modules would miss the real goal.

## What this file currently mixes together

This file is still small enough to rescue without a rewrite, but it owns too many jobs at once:

1. **Provider lookup / model parsing**
	- parses `provider/model-id`
	- lazily loads the provider

2. **Per-session request ownership**
	- prevents concurrent generations on one session
	- stores abort controllers
	- stores custom abort text

3. **IPC event publishing**
	- wraps event metadata creation
	- writes live events both to session live state and IPC log

4. **Provider stream consumption**
	- consumes `text`, `thinking`, `thinking_signature`, `tool_call`, `server_tool`, `status`, `error`, `done`
	- accumulates assistant text, thinking text, tool calls, tool blobs, usage, retry state

5. **Retry / rate-limit policy**
	- computes backoff
	- parses retry timing from bodies
	- sleeps with abort support
	- decides whether an error is terminal

6. **Tool normalization and execution**
	- strips model-added `cd $CWD && ...` from bash calls
	- batches tool execution with concurrency limits

7. **Blob persistence**
	- writes thinking blobs
	- writes tool call blobs
	- writes provider error blobs
	- patches tool result blobs

8. **History persistence**
	- writes thinking / assistant / tool_call / tool_result history entries
	- mutates `messages` for the next provider call

9. **Context estimation + meta persistence**
	- estimates context multiple times
	- emits `stream-end`
	- persists session context meta

10. **Public runtime API**
	- exports `abort()`
	- exports `isActive()`
	- exports config/state namespace

That is why it feels slightly too large: the core loop is mixed with persistence details, transport details, and tool/provider cleanup.

## Concrete duplication / bloat hotspots

These are the highest-value cuts grounded in the current code:

- **Terminal finish logic is repeated three times**
	- abort finish: `280-293`
	- clean completion: `515-525`
	- max-iteration stop: `626-634`
	- this is the strongest in-file dedupe target

- **Thinking history entry creation is duplicated**
	- `491-500`
	- `548-557`

- **Assistant response persistence / response-event emission is duplicated**
	- `502-514`
	- `559-575`

- **Tool call blob bookkeeping is duplicated**
	- initial write on `tool_call`: `370-372`
	- repeated before history append: `561-563`

- **Retry reset/body parsing is duplicated across modules**
	- `src/runtime/agent-loop.ts:153-162`
	- `src/providers/openai.ts:73-80`

- **Thin wrappers add lines without adding policy**
	- `getProvider()`
	- `executeTool()`

- **Bash-specific cleanup lives in the wrong module**
	- `resolveTilde()` + `stripCdCwd()` only exist for bash tool input cleanup

- **There is one real dead block, not just duplication**
	- `612-614` computes `est` and then does nothing with it
	- this should simply be deleted before any refactor discussion

## Reduction ideas, grouped by value

### 1) Real deletions first

These are the safest first cuts because they remove code instead of relocating it.

| Idea | Est. `agent-loop.ts` impact | Est. repo impact | Notes |
|---|---:|---:|---|
| Delete dead `est` block after tool results (`612-614`) | -2 to -4 | -2 to -4 | Pure deletion; should happen first |
| Delete `getProvider()` and call `providerLoader.getProvider()` directly | -3 to -6 | -3 to -6 | Also likely drops the `Provider` type import |
| Delete `executeTool()` and call `toolRegistry.dispatch()` directly from the batched executor | -8 to -12 | -8 to -12 | `dispatch()` already catches and formats errors |
| Drop explicit `ToolDef[]` local annotation if inference stays clear | -1 to -2 | -1 to -2 | Also may drop imported `ToolDef` type |
| Merge `activeRequests` + `abortTexts` into one map of `{ controller, abortText? }` | -4 to -8 | -4 to -8 | Real cleanup, but lower priority than the three above |

**Why this is good:** these are actual net deletions.

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/server/runtime.test.ts` for `abort()` / `isActive()` behavior if request state changes

### 2) Move behavior to the module that already owns it

These are the best repo-level reductions because they simplify ownership instead of creating glue.

#### 2.1 Move bash `cd $CWD && ...` stripping into `src/tools/bash.ts`

Right now `agent-loop.ts` imports `path` and `os` only to normalize bash tool input:

- `HOME`
- `resolveTilde()`
- `stripCdCwd()`

That logic is bash-tool-specific policy. `src/tools/bash.ts` already has `normalizeInput()` and already owns command execution in `ctx.cwd`, so it is the natural home.

**Estimated impact:**
- `agent-loop.ts`: **-18 to -24 LOC**
- repo total: **down or roughly flat**, likely **-6 to -10 LOC** if implemented tightly inside existing bash normalization

**Important review note:** this is only a win if the bash tool absorbs the logic directly into its existing normalization path. Do **not** create a new shared helper file just for this.

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts` tool-call flow
- add direct bash-tool coverage for:
	- `cd <cwd> && echo hi`
	- `cd ~/x && ...` not being stripped unless it resolves to actual `ctx.cwd`
- `src/tools/builtins.test.ts`

#### 2.2 Share `parseResetsInSeconds()` via `src/providers/shared.ts`

This is real duplication today:

- `src/runtime/agent-loop.ts`
- `src/providers/openai.ts`

Best home: `src/providers/shared.ts`, next to `parseRetryDelay()`.

**Estimated impact:**
- `agent-loop.ts`: **-8 to -10 LOC**
- repo total: **-10 to -12 LOC** after deduping `openai.ts`

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts` retry/abort tests
- `src/providers/openai.test.ts`

#### 2.3 Share context snapshot persistence only if it stays tiny

`agent-loop.ts` and `server/runtime.ts` both estimate context and persist `{ used, max }`.

That duplication is real, but the safe first-pass target is **small**:

- helper should only do `estimateContext(...)` + `updateMeta(...)`
- do **not** invent a broad new “stream finish” shared layer between runtime modules on the first pass

A small helper in an **existing** module like `runtime/context.ts` is plausible. A bigger cross-runtime event/persistence abstraction is not a first-pass LOC play.

**Estimated impact:**
- `agent-loop.ts`: **-6 to -12 LOC**
- `server/runtime.ts`: **-4 to -8 LOC**
- repo total: modestly down if the helper stays tiny

**Review note:** this is weaker than the bash move and retry dedupe. Do it only after the obvious deletions land.

### 3) Dedupe repeated branch logic inside this file

This is the best way to get under 500 **without** creating more files.

#### 3.1 Dedupe terminal finish handling inside `agent-loop.ts`

Three branches recompute context and emit terminal state. They differ only in:

- phase/result
- optional abort info text
- optional failure message
- whether usage is included

A **local helper in this file** is the strongest target here.

**Estimated impact:**
- `agent-loop.ts`: **-18 to -25 LOC**
- repo total: flat to slightly down

**Recommended shape:**
- `finishStream({ phase, usage, message, abortText })`
- or `emitStreamEndAndPersistContext(...)`

**Review correction:** do this locally first. Sharing with `server/runtime.ts` can come later if a tiny shared helper naturally falls out.

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/client-streaming.test.ts`

#### 3.2 Dedupe thinking + assistant history construction

Both the no-tool path and the tool path repeat:

- thinking entry creation
- assistant history append
- response event emission

A small local helper should pay for itself quickly.

**Estimated impact:**
- `agent-loop.ts`: **-20 to -35 LOC**
- repo total: flat to slightly down

**Good target shape:**
- `appendThinkingHistoryEntry(...)`
- `appendAssistantEntry(...)`
- or one compact helper that pushes both into a passed `historyEntries` array

**Review correction:** prefer a helper that removes duplicated code in place. Do **not** extract “history helpers” to a brand-new file unless a second caller exists.

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/session/api-messages.test.ts`
- `src/client-startup.test.ts`

#### 3.3 Tighten tool blob bookkeeping without adding a blob API first

Current flow:

- write tool-call blob during streaming
- write tool-call blob again before history append
- later read blob and patch in result

That is real duplication, but the first-pass fix should be simple:

- introduce a tiny local `toolBlobId(toolId)` helper or equivalent
- guarantee the call blob is written once
- later patch only the result

**Estimated impact:**
- `agent-loop.ts`: **-8 to -14 LOC**
- repo total: flat

**Review correction:** do **not** start by adding `blob.mergeBlob()` or another new blob abstraction. That risks turning a delete into a sideways move.

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/session/api-messages.test.ts`
- `src/client-streaming.test.ts`

### 4) Lower-priority cleanups

These are real, but they are not needed for the first under-500 pass.

#### 4.1 Collapse provider-error formatting + blob serialization

Today there are three helpers around provider errors:

- `parseErrorPayload()`
- `formatErrorDetails()`
- `writeErrorBlob()`

A tighter helper could shorten the `error` case, but this is not the first thing to reach for because current behavior is already fairly clear and test-covered.

**Estimated impact:**
- `agent-loop.ts`: **-8 to -14 LOC**
- repo total: roughly flat

#### 4.2 Unify active request state into one map

This is a real cleanup, but it is not where the fastest LOC wins are.

**Estimated impact:**
- `agent-loop.ts`: **-4 to -8 LOC**
- repo total: **-4 to -8 LOC**

#### 4.3 Shared session event-envelope helper

There is some duplication between `agent-loop.ts` and `server/runtime.ts`, but the two modules are not identical callers:

- `agent-loop.ts` also calls `sessions.applyLiveEvent(...)`
- `server/runtime.ts` often only appends IPC events

So this is **not** a top-priority reduction target.

**Review correction:** treat this as optional follow-up, not part of the first-pass plan.

## Ideas that do **not** count as progress

These may shrink this file while missing the repo-level goal:

- splitting the switch into a new sibling file with the same logic
- extracting retry logic into a brand-new helper module used only here
- extracting history-writing helpers to a new file with no second caller
- adding a new blob patch API before deleting the duplicated local paths
- adding a shared event abstraction that makes both runtime modules more indirect but not shorter overall

## Strongest execution path

This is the best one-pass path to get under 500 with repo cloc flat or down:

### Pass 1: pure deletions and ownership fixes

1. **Delete the dead context-estimate block at `612-614`**
2. **Delete `getProvider()` and call `providerLoader.getProvider()` directly**
3. **Delete `executeTool()` and dispatch tools directly through `toolRegistry.dispatch()`**
4. **Move bash command cleanup into `src/tools/bash.ts`**
5. **Share `parseResetsInSeconds()` via `src/providers/shared.ts` and remove both copies**

**Expected result:** roughly **-35 to -50 LOC** from `agent-loop.ts`, with total repo cloc likely down too.

That alone should put the file roughly around **473-488 bun cloc LOC**.

### Pass 2: only the highest-value local dedupe

6. **Add one local helper for terminal `stream-end` + context/meta persistence**
7. **Add one local helper for thinking/assistant history duplication**
8. **Tighten tool blob bookkeeping so the tool-call blob is written once per call path**

**Expected result:** another **-15 to -35 LOC** from `agent-loop.ts`.

After this, the file should likely land around **440-475 LOC**.

### Pass 3: only if still awkward

9. **Optionally unify active request state into one map**
10. **Optionally tighten provider-error helpers**
11. **Only then consider a tiny shared context snapshot helper with `server/runtime.ts`**

These are cleanup passes, not the main route to the target.

## Risks / tests to watch

Primary targeted tests:

- `src/runtime/agent-loop.test.ts`
	- thinking blobs while streaming
	- provider error blob vs short UI message
	- status forwarding
	- abort between tool iterations
	- custom abort text
	- silent abort text
	- abort during rate-limit backoff

- `src/client-streaming.test.ts`
	- no duplicate assistant text after `response`
	- tool-call / tool-result live block ordering
	- response error blob metadata

- `src/session/api-messages.test.ts`
	- replay of thinking / tool_call / tool_result into provider messages

Secondary tests likely affected:

- `src/providers/openai.test.ts`
	- if retry reset parsing moves to `providers/shared.ts`
- `src/client-startup.test.ts`
	- if history entry shapes or replay timing change
- `src/server/runtime.test.ts`
	- only if the plan expands into shared context persistence
- `src/tools/builtins.test.ts`
	- tool registration assumptions

Missing coverage worth adding during execution:

- direct bash-tool tests for cwd-prefix stripping
- a focused test that tool-call blobs are not re-written through two divergent paths

Behavioral risks to watch closely:

- abort text semantics: default `[paused]`, custom text, and empty-string silent abort
- retry wait cancellation when the parent signal aborts
- preserving short visible provider error text while keeping full payload in blob
- not breaking tool result replay into provider messages
- not duplicating assistant text between streamed live blocks and final `response` events

## Bottom line

Yes: **under 500 bun cloc LOC is reachable in one pass** without cheating by splitting files.

The real route is:

1. delete dead code
2. delete thin wrappers
3. move bash-only normalization into `bash.ts`
4. dedupe the already-duplicated retry parser in `providers/shared.ts`
5. do only the two highest-value local dedupes inside `agent-loop.ts`

That path targets actual reduction, keeps repo cloc flat or down, and is ready for execution.