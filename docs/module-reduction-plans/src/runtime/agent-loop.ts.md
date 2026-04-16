# LOC reduction plan for `src/runtime/agent-loop.ts`

## Current size

- Current `bun cloc` LOC: **523**
- Physical lines right now: **697**
- Target: get this module **comfortably under 500 bun cloc LOC** with **flat-or-down total repo cloc**
- Practical reduction needed: only **24 bun cloc LOC**, but the real target should be **~40-70 LOC removed** so the file has headroom

## What this file currently mixes together

The file is small enough to rescue without a rewrite, but it currently owns too many unrelated jobs:

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

That is the main reason the file feels slightly too large: the core loop is mixed with persistence details, transport details, and provider-specific cleanup.

## Concrete duplication / bloat hotspots

These are the highest-value places to cut:

- **Context estimate + `stream-end` + `updateMeta` is repeated**
	- `280-293` abort finish
	- `515-525` clean completion
	- `626-635` max-iteration stop
	- similar logic also exists in `src/server/runtime.ts:531-542`

- **Thinking history entry creation is duplicated**
	- `491-500`
	- `548-557`

- **Assistant response persistence / event emission is duplicated**
	- `502-514`
	- `559-575`

- **Tool call blob persistence is duplicated**
	- initial write: `370-372`
	- repeated before history append: `561-563`

- **Retry parsing is duplicated across modules**
	- `src/runtime/agent-loop.ts:153-162`
	- `src/providers/openai.ts:73-80`

- **Thin wrappers add lines without adding much policy**
	- `getProvider()`
	- `executeTool()`

- **Bash-specific cleanup lives in the wrong module**
	- `resolveTilde()` + `stripCdCwd()` only exist to sanitize one tool’s input

## Reduction ideas, grouped by type

### 1) Delete thin wrappers and one-off scaffolding

These are the safest first cuts.

| Idea | Est. `agent-loop.ts` impact | Est. repo impact | Notes |
|---|---:|---:|---|
| Delete `getProvider()` and call `providerLoader.getProvider()` directly | -3 to -5 | -3 to -5 | Pure wrapper today |
| Delete `executeTool()` and call `toolRegistry.dispatch()` directly from the concurrent executor | -8 to -12 | -8 to -12 | `dispatch()` already catches tool errors and returns `error: ...` |
| Drop explicit `ToolDef[]` local annotation if inference is clear | -1 | -1 | Tiny, but free |
| Merge `activeRequests` + `abortTexts` into one map of `{ controller, abortText? }` | -4 to -8 | -4 to -8 | Small cleanup; not a headline change |

**Why this is good:** these cuts remove code without moving behavior elsewhere.

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/server/runtime.test.ts` for `abort()` / `isActive()` behavior

### 2) Move behavior to the module that already owns it

These are especially good because they can lower both this file and total repo LOC.

#### 2.1 Move bash `cd $CWD && ...` stripping into `src/tools/bash.ts`

Right now `agent-loop.ts` imports `path` and `os` only to normalize bash tool input:

- `HOME`
- `resolveTilde()`
- `stripCdCwd()`

That logic is bash-tool-specific policy. The bash tool already normalizes its input in `normalizeInput()`, already knows `ctx.cwd`, and is the natural owner of command cleanup.

**Estimated impact:**
- `agent-loop.ts`: **-18 to -24 LOC**
- repo total: **-6 to -10 LOC** after adding the smaller version in `bash.ts`

**Why this is strong:**
- removes two imports from `agent-loop.ts`
- removes a whole helper section from this file
- improves ownership instead of just hiding code elsewhere

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts` tool-call flow
- add/update direct bash-tool coverage for `cd ~/x && ...` and `cd <cwd> && ...`
- `src/tools/builtins.test.ts` if tool registration assumptions change

#### 2.2 Move shared retry-body parsing into `src/providers/shared.ts`

`parseResetsInSeconds()` exists in both `agent-loop.ts` and `openai.ts`. That is real duplication, not just a refactor preference.

Best home: `src/providers/shared.ts`, next to `parseRetryDelay()`.

**Estimated impact:**
- `agent-loop.ts`: **-8 to -10 LOC**
- repo total: **-10 to -12 LOC** after deduping `openai.ts`

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts` abort / retry tests
- `src/providers/openai.test.ts`
- possibly `src/providers/anthropic.test.ts` if reused there later

#### 2.3 Share context snapshot persistence with `src/server/runtime.ts`

`agent-loop.ts` and `server/runtime.ts` both do this pattern:

1. `context.estimateContext(...)`
2. write `{ used, max }` to `sessions.updateMeta(...)`
3. sometimes emit `stream-end`

This should become one shared helper in an **existing** module, not a new file. Best candidates:

- `src/runtime/context.ts`
- or `src/server/sessions.ts`

A good shape would be something like:

- `context.snapshot(sessionId, messages, model, overheadBytes)` → returns `{ used, max }` and persists meta
- optionally another helper to build the `stream-end` payload

**Estimated impact:**
- `agent-loop.ts`: **-12 to -20 LOC**
- repo total: **-10 to -15 LOC** once `server/runtime.ts` also uses it

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/server/runtime.test.ts`
- `src/client-streaming.test.ts` and startup tests that read persisted context

### 3) Dedupe repeated branch logic inside the loop

This is the biggest in-file cleanup opportunity.

#### 3.1 Dedupe finalization: abort / success / stopped

Three branches all recompute context and emit terminal state. They differ only in:

- phase/result
- whether to emit abort info text
- whether there is a failure message
- whether usage is included

A single helper can handle this cleanly.

**Estimated impact:**
- `agent-loop.ts`: **-18 to -25 LOC**
- repo total: roughly flat unless shared with `server/runtime.ts`

**Good target shape:**
- `finishLoop({ phase, usage, message, emitAbortText })`
- or a narrower `emitStreamEndAndPersistContext(...)`

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/client-streaming.test.ts`
- any tests expecting `stream-end` contents after abort/error/stop

#### 3.2 Dedupe thinking + assistant history entry construction

Both the no-tool path and the tool-call path build the same thinking history entry, and both partly duplicate assistant handling.

A helper like `buildAssistantHistoryEntries(...)` or two smaller helpers:

- `buildThinkingEntry(...)`
- `appendAssistantTextEntry(...)`

would pay for itself quickly.

**Estimated impact:**
- `agent-loop.ts`: **-20 to -35 LOC**
- repo total: flat to **-5 LOC** depending on helper shape

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/session/api-messages.test.ts`
- `src/client-startup.test.ts` replay cases

#### 3.3 Dedupe tool blob bookkeeping

Current pattern:

- write tool-call blob during streaming
- write tool-call blob again before history append
- later read blob and patch in result

This is too much read-modify-write ceremony in the loop.

Possible simplifications:

1. Add a tiny `ensureToolBlobId()` helper in this file
2. Add `blob.mergeBlob(sessionId, blobId, patch)` in `blob.ts`
3. Guarantee tool-call blob was written once, then only patch result later

**Estimated impact:**
- `agent-loop.ts`: **-10 to -18 LOC**
- repo total: flat to **-5 LOC** if a reusable blob patch helper replaces repeated read/modify/write code elsewhere later

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/session/api-messages.test.ts`
- anything loading historical tool blobs via `read_blob`

### 4) Simplify retry / provider-error handling

This block is dense because parsing, user messaging, retry decision, blob persistence, and abort-aware sleeping are all interleaved in one `case 'error'`.

#### 4.1 Collapse provider-error formatting + blob serialization

Today there are three helpers around this:

- `parseErrorPayload()`
- `formatErrorDetails()`
- `writeErrorBlob()`

A tighter shape would be a single helper that returns both:

- parsed payload for blob
- short message for UI

Example: `summarizeProviderError(event) -> { summary, payload }`

That avoids parsing the same body twice and makes the switch branch shorter.

**Estimated impact:**
- `agent-loop.ts`: **-8 to -14 LOC**
- repo total: flat to **-5 LOC** if reused elsewhere later

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts` error blob test
- ensure long payloads still stay in blob, not visible text

#### 4.2 Pull retry decision into a helper object/function

Right now the `error` case owns:

- terminal vs retryable decision
- retry window start time
- elapsed check
- body retry parsing
- fallback backoff
- user-facing wait notice
- status update
- abort-aware sleep

A helper like `nextRetryDelay(event, retryState)` or `retryPolicy.onError(...)` would shrink the switch branch.

This is worth doing **only if** it removes local branching, not if it just moves the same code to a brand new file.

**Estimated impact:**
- `agent-loop.ts`: **-6 to -12 LOC**
- repo total: flat unless shared with provider code later

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts` rate-limit retry and abort tests
- `src/providers/openai.test.ts` if logic gets shared

### 5) Merge with existing helpers instead of inventing new files

These are worthwhile if they reuse already-existing modules.

#### 5.1 Reuse `toolRegistry.dispatch()` directly

This is both a deletion and a merge-with-existing-helper case. The registry already:

- resolves unknown tools
- catches thrown tool errors
- returns `error: ...`

So `executeTool()` is mostly redundant.

**Estimated impact:** already counted above, but it is a strong recommendation.

#### 5.2 Reuse provider/shared retry helpers more aggressively

`providerShared` already has retry-delay parsing. If it grows one more tiny helper for body-based reset parsing, `agent-loop.ts` gets simpler and `openai.ts` gets smaller too.

**Estimated impact:** already counted above.

#### 5.3 Consider a shared session event helper used by both runtime modules

`agent-loop.ts` has `emitEvent()` / `emitInfo()` and `server/runtime.ts` has its own `emitInfo()` with nearly identical event-envelope creation.

If an existing module gets a helper like `sessions.emitEvent()` or `ipc.emitSessionEvent()`, both files shrink.

**Estimated impact:**
- `agent-loop.ts`: **-4 to -8 LOC**
- `server/runtime.ts`: **-4 to -8 LOC**
- repo total: **-4 to -8 LOC** depending on helper shape

**Risk / tests to watch:**
- `src/runtime/agent-loop.test.ts`
- `src/server/runtime.test.ts`
- IPC/event ordering tests

### 6) Larger contract simplifications worth noting

These are plausible and could cut more code, but they are not my recommended first pass.

#### 6.1 Normalize provider events earlier

If providers emitted more normalized data, `agent-loop.ts` could drop some provider-specific cleanup:

- pre-sanitized retry delay
- pre-parsed short error message
- possibly normalized bash tool command
- possibly a user-facing status event instead of raw `server_tool` query inspection

**Estimated impact:**
- `agent-loop.ts`: **-25 to -40 LOC**
- repo total: maybe down, maybe flat, depending on how much logic becomes shared in provider helpers

**Why not first:** this changes the provider contract and touches more modules.

#### 6.2 Move iteration persistence into `sessions`

A helper like `sessions.appendAgentIteration(...)` could take:

- thinking text/signature/blob
- assistant text
- tool calls
- maybe tool results

and write the right history/blob records.

This could reduce `agent-loop.ts` a lot, and it would make `api-messages.ts` / replay logic easier to reason about long-term.

**Estimated impact:**
- `agent-loop.ts`: **-25 to -40 LOC**
- repo total: only worth it if it becomes a true shared persistence primitive, otherwise this is mostly line-moving

**Why not first:** easy to accidentally just relocate complexity.

## Ideas I would **not** count as real progress

These may reduce this file’s LOC number but do **not** meet the repo-level goal on their own:

- splitting the switch into a brand-new sibling file with the same amount of code
- extracting retry logic into a new helper module that only `agent-loop.ts` uses
- extracting history-writing helpers into a new file without deleting any duplicated logic elsewhere

Those would shrink the module, but probably increase or flatten total repo cloc for the wrong reason.

## Recommended execution sequence

This sequence is aimed at getting under 500 in one pass while keeping total repo cloc flat or down.

### Pass 1: cheap deletions and ownership fixes

1. **Move bash command cleanup into `src/tools/bash.ts`**
2. **Delete `getProvider()` wrapper**
3. **Delete `executeTool()` wrapper and simplify `executeToolsConcurrently()` to call `toolRegistry.dispatch()` directly**
4. **Share `parseResetsInSeconds()` via `src/providers/shared.ts` and reuse it from `openai.ts`**

**Expected result:** roughly **-30 to -45 LOC** from `agent-loop.ts` with repo total likely also down.

That alone likely gets the file from **523** to about **478-493**.

### Pass 2: remove the obvious duplication still left in the loop

5. **Introduce one helper for terminal stream-end/context persistence**
6. **Introduce one helper for thinking/assistant history entry creation**
7. **Tighten tool blob bookkeeping so tool-call blobs are not re-written through duplicated paths**

**Expected result:** another **-15 to -35 LOC** from `agent-loop.ts`.

After this, the file should likely land around **450-480 LOC** and be easier to maintain.

### Pass 3: only if the file is still awkward after the above

8. **Simplify the `error` case with one provider-error summary helper**
9. **Optionally unify active request state into one map**
10. **Optionally share event-envelope creation with `server/runtime.ts`**

These are worthwhile cleanups, but they are not necessary to hit the target.

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

Secondary tests likely affected:

- `src/providers/openai.test.ts`
	- if retry parsing moves to shared provider helpers
- `src/server/runtime.test.ts`
	- if context persistence or event helpers get shared
- `src/session/api-messages.test.ts`
	- if history entry writing changes shape
- `src/client-streaming.test.ts`
	- if `stream-end` / `response` emission changes
- bash tool tests / builtins tests
	- if `cd $CWD && ...` stripping moves into the bash tool

Behavioral risks to watch closely:

- abort text semantics: default `[paused]`, custom text, and empty-string silent abort
- retry wait cancellation when the parent signal aborts
- preserving short visible provider error text while keeping full payload in blob
- not breaking tool result replay into provider messages
- not duplicating assistant text between streamed live blocks and final `response` events

## Best reduction opportunities outside this file too

These are the changes most likely to reduce other large files at the same time:

1. **Shared context snapshot helper**
	- reduces `src/runtime/agent-loop.ts`
	- also reduces `src/server/runtime.ts`

2. **Shared retry reset/body parsing in `providers/shared.ts`**
	- reduces `src/runtime/agent-loop.ts`
	- also reduces `src/providers/openai.ts`
	- may later help `src/providers/anthropic.ts`

3. **Move bash normalization into `src/tools/bash.ts`**
	- reduces `src/runtime/agent-loop.ts`
	- makes tool-specific policy live in the tool that already owns it

4. **Shared session event-envelope helper**
	- reduces `src/runtime/agent-loop.ts`
	- also reduces `src/server/runtime.ts`

## Bottom line

Yes: **under 500 bun cloc LOC is reachable in one practical pass** without cheating by just splitting files.

The best first cuts are:

1. move bash input cleanup into `bash.ts`
2. delete `getProvider()`
3. delete `executeTool()` and simplify batched tool execution
4. share `parseResetsInSeconds()` with `providers/shared.ts`
5. dedupe terminal context/stream-end handling

That set should be enough to get this module under target while keeping total repo cloc flat or down.