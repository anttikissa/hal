# Module Size Reduction Plan

## Why this plan exists

We have an explicit rule that no module should be over 500 lines of code.

Current `bun cloc` top offenders:
- `src/client.ts` — 954
- `src/server/runtime.ts` — 712
- `src/cli/blocks.ts` — 689
- `src/providers/openai.ts` — 659
- `src/runtime/commands.ts` — 635
- `src/runtime/agent-loop.ts` — 523
- `src/cli/prompt.ts` — 514
- `src/client/render.ts` — 503

So this is not one accidental outlier. It is a pattern.

## How we ended up here

1. We kept taking the shortest local path.
When a behavior already lived in a file, the next adjacent behavior got added there too.
This was usually faster for one change, but it slowly turned each file into a junk drawer.

2. Some files own too many axes at once.
Examples:
- `client.ts` owns tab state, persistence, prompt mirroring, IPC event handling, startup merge, and command construction.
- `server/runtime.ts` owns session lifecycle, prompt dispatch, command handling, compaction, shared-state sync, and startup.
- `cli/blocks.ts` owns history translation, blob loading, tool-title logic, tool-output formatting, and final rendering.

3. We optimized for hot-patching, but did not finish the corresponding decomposition.
The mutable-namespace convention is good, but we often stopped at “one big namespace object” instead of several small ones.

4. We tracked total line count, not per-module size.
`bun cloc` kept us aware of total growth, but nothing stopped one file from growing past the point where a model can comfortably hold it in working memory.

5. Render/runtime code attracts unrelated fixes.
Terminal bugs, startup fixes, command tweaks, tool formatting, and session edge cases all land in the same few central files.
Without deliberate extraction, they only grow.

## Constraints for the split

- Keep behavior unchanged unless a split makes a small cleanup obviously safer.
- Preserve the mutable namespace convention.
- Imports stay cheap and side-effect free.
- Prefer extract-and-forward refactors over rewrites.
- After each extraction step: run `./test`.
- Commit after each finished sub-step.

## Target state

No production module in `src/` over 500 lines.

Near-term target:
- Get every file under 500.
- Add a guard so we do not drift back here.

## Execution order

Do the low-risk seam cuts first, then the bigger central files.

### Phase 1: Easy wins with clear seams

#### 1a. Split `src/client/render.ts` (503)
Reason: already grouped by section comments; pure rendering file; minimal state surface.

Proposed files:
- `src/client/render-history.ts`
	- visible history filtering
	- group rendering
	- history-to-lines logic
- `src/client/render-status.ts`
	- tab bar
	- status line
	- help bar
- `src/client/render-paint.ts`
	- frame build
	- cursor movement
	- diff/full repaint logic

Target result:
- `render.ts` becomes orchestration namespace only
- each new file roughly 120–250 LOC

#### 1b. Split `src/cli/prompt.ts` (514)
Reason: three natural chunks already exist.

Proposed files:
- `src/cli/prompt-layout.ts`
	- wrapping
	- cursor row/col mapping
	- vertical move helpers
- `src/cli/prompt-editor.ts`
	- mutations
	- selection
	- undo/redo
	- word motion
- `src/cli/prompt-render.ts`
	- prompt rendering
	- render payload building

Target result:
- `prompt.ts` keeps shared mutable state + tiny public facade

### Phase 2: Split rendering logic by responsibility

#### 2a. Split `src/cli/blocks.ts` (689)
Reason: currently mixes data prep, tool formatting, and terminal rendering.

Proposed files:
- `src/cli/blocks-history.ts`
	- `historyToBlocks`
	- user text extraction
	- timestamp parsing
- `src/cli/blocks-blobs.ts`
	- blob loading
	- blob application
	- size caps
- `src/cli/blocks-tools.ts`
	- tool title logic
	- tool details
	- tool output formatting
	- spinner/elapsed helpers
- `src/cli/blocks-render.ts`
	- colors
	- headers
	- content wrapping
	- final block rendering

Target result:
- keep `src/cli/blocks.ts` as the small namespace/export barrel

### Phase 3: Split slash command handling

#### 3a. Split `src/runtime/commands.ts` (635)
Reason: this is really four modules pretending to be one.

Proposed files:
- `src/runtime/commands-parse.ts`
	- parse helpers
	- tab target resolution
- `src/runtime/commands-tabs.ts`
	- `/tabs`, `/open`, `/move`, `/rename`, resume helpers
- `src/runtime/commands-config.ts`
	- config snapshot
	- path parsing
	- value parsing
	- read/write helpers
- `src/runtime/commands-help.ts`
	- help topic routing
	- long-form help text

Target result:
- `commands.ts` becomes dispatch table + thin facade

### Phase 4: Split the agent loop internals

#### 4a. Split `src/runtime/agent-loop.ts` (523)
Reason: just over the limit, and internal seams already exist.

Proposed files:
- `src/runtime/agent-loop-retry.ts`
	- retry backoff
	- status parsing
	- error formatting
- `src/runtime/agent-loop-tools.ts`
	- tool normalization
	- tool execution
	- tool result persistence helpers
- `src/runtime/agent-loop-events.ts`
	- IPC emit helpers
	- thinking/tool blob write helpers

Target result:
- main loop file stays focused on turn progression

### Phase 5: Split server runtime by domain

#### 5a. Split `src/server/runtime.ts` (712)
Reason: biggest coordination file after `client.ts`; needs domain separation.

Proposed files:
- `src/server/runtime-sessions.ts`
	- create/open/fork/move/close session helpers
	- shared-state sync
- `src/server/runtime-prompts.ts`
	- prompt handling
	- command retry persistence
	- context estimate publication
- `src/server/runtime-commands.ts`
	- command dispatch helpers
	- per-command execution glue
- `src/server/runtime-spawn.ts`
	- subagent spawn spec parsing
	- spawn session creation
	- spawned session startup

Target result:
- `runtime.ts` keeps bootstrap wiring and top-level control flow only

### Phase 6: Split the giant client state machine

#### 6a. Split `src/client.ts` (954)
Reason: this is the main memory overload source.

Proposed files:
- `src/client/state.ts`
	- shared mutable state
	- tab factory
	- recent-tab bookkeeping
- `src/client/startup.ts`
	- startup merge
	- shared-state bootstrap
	- watchers
- `src/client/events.ts`
	- IPC event handling
	- history/live merge
	- busy/streaming transitions
- `src/client/tabs.ts`
	- switch/next/prev/load tab helpers
	- draft/history accessors
- `src/client/commands.ts`
	- `makeCommand`
	- `sendCommand`
	- continue helpers

Target result:
- `client.ts` becomes a narrow facade over submodules

### Phase 7: Split provider protocol plumbing

#### 7a. Split `src/providers/openai.ts` (659)
Reason: request building, message conversion, and streaming parser should not live together.

Proposed files:
- `src/providers/openai-messages.ts`
	- message conversion
	- tool schema shaping
- `src/providers/openai-stream.ts`
	- SSE chunk parsing
	- streamed tool-call assembly
- `src/providers/openai-request.ts`
	- body construction
	- model options
	- request submission glue

Target result:
- `openai.ts` keeps provider facade + high-level orchestration

## Guardrail after the split

After the first wave lands, add a small test or script:
- fail if any `src/**/*.ts` production module exceeds 500 lines
- ignore tests
- optionally allow a tiny temporary waiver list, but keep it empty by default

Without this, we will drift back.

## Recommended first execution slice

Do this first, in order:
1. Split `src/client/render.ts`
2. Run `./test`
3. Commit
4. Split `src/cli/prompt.ts`
5. Run `./test`
6. Commit

Why this slice first:
- clear seams
- low protocol risk
- immediately gets two files under budget
- good rehearsal for the larger splits later
