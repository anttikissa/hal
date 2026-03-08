# Plan: Safe restart resume without replaying completed tool work

Date: 2026-03-07

## Problem

After restart, we want to continue an interrupted assistant turn **without** blindly replaying tool side effects.

Example target behavior:

- user prompt
- thinking
- assistant text
- tool call(s)
- tool result(s)
- thinking
- assistant text (cut off)

On restart, continue from the cut-off point and **do not rerun completed tools**.

## Core constraints

1. Tool calls can have side effects (edits, shell commands, writes).
2. Restart can happen in the middle of a tool round.
3. With parallel tools, some may be finished while others are unknown.
4. Unknown completion state must be treated as unsafe for auto-retry.

## Safety policy

### Allowed automatic resume

Auto-resume is allowed only when state proves there are **no unknown tool outcomes** for the interrupted turn.

Concretely:

- If a tool call has a durable `done` result checkpoint, it is treated as completed.
- If all tool calls in the interrupted round are completed, resume may proceed from post-tool context.
- If interruption happened after tool round completion (during plain assistant text), resume is safe.

### Disallowed automatic resume

If any tool call status is unknown/incomplete, do **not** auto-run generation.

Instead, mark session as recoverable and require explicit user decision.

## Data/checkpoint design

Add durable per-session resume state file (example: `state/sessions/<id>/resume.ason`).

Schema sketch:

- `generationId` (string)
- `phase` (`model`, `tool_round`, `post_tool_model`, `done`, `failed`, `interrupted`)
- `round` (number)
- `toolCalls`: list of `{ id, name, input, status, startedAt, doneAt?, resultDigest? }`
- `pendingToolIds`: string[]
- `completedToolIds`: string[]
- `lastSafeResumePoint`: enum (`before_round`, `after_all_tools`, `post_tool_text`)
- `updatedAt`

Rules:

- Write checkpoint before executing each tool call.
- Write checkpoint immediately when each tool finishes (`status=done`).
- Flush to disk synchronously on each checkpoint update.

## Runtime behavior on startup

For each restored session:

1. Load `resume.ason` + message log.
2. Determine restart status:
	- no interrupted generation -> nothing
	- interrupted, all tools complete -> safe auto-resume
	- interrupted, unknown tools -> no auto-resume
3. Emit explicit status line:
	- safe: `[resume] continuing interrupted response`
	- unsafe: `[resume] interrupted during tools; user action required`
4. Update session status event to include resumability info.

## User-facing recovery flow

Add explicit command for unsafe cases:

- `/continue` -> continue only if safe; otherwise explain why blocked
- `/continue --rerun-unknown` -> explicit opt-in to rerun unknown tools
- `/continue --skip-unknown` -> continue with unknown tools marked skipped (advanced, risky semantics clearly disclosed)

Default must be conservative: **never rerun unknown tools automatically**.

## Agent loop changes

In `new/runtime/agent-loop.ts`:

1. Introduce `generationId` and round checkpoint hooks.
2. Before each tool execution: checkpoint `running`.
3. After each tool completion: checkpoint `done` with digest/summary.
4. Only append post-tool assistant/user tool_result messages when tool statuses are fully known.
5. On process interruption, startup logic reads checkpoint and decides safe vs unsafe resume.

## Handling parallel tool calls

Treat each tool call independently by ID.

- completed set is durable
- unknown set blocks auto-resume

If model emitted 3 parallel tools and only 2 completed before crash:

- auto-resume is blocked
- UI explains: `2 done, 1 unknown`
- user chooses rerun or manual recovery

## Tests (comprehensive)

### Unit tests

1. Checkpoint transitions per tool status.
2. Resume classification: safe vs unsafe.
3. `/continue` behavior for safe/unsafe sessions.

### Integration/e2e tests

1. Restart after cut-off post-tool text -> auto-resume allowed, no tool rerun.
2. Restart with mixed parallel tool completion -> auto-resume blocked.
3. `/continue --rerun-unknown` reruns only unknown tool IDs.
4. Ctrl-R restart preserves resumability flags and tab/session state.

## Rollout steps

1. Implement checkpoint file + writer.
2. Wire agent loop checkpoint updates.
3. Add startup classifier and safe auto-resume gate.
4. Add explicit continue command variants.
5. Add tests.
6. Remove broad auto-resume fallback that resumes all pending user turns.

## Non-goals

- Perfect deduplication for external side effects without tool idempotency guarantees.
- Automatic recovery of unknown tool outcomes without user confirmation.

## Success criteria

1. Completed tool calls are never replayed on restart.
2. Unknown tool states are never auto-rerun.
3. Plain text cut-off resumes automatically when safe.
4. Behavior is explicit in UI and covered by e2e tests.
