# Steering v2 — first-class `steer` command

## Problem

Current steering (double-enter) sends separate `pause` + `resume` commands, producing noisy
output (`[pause] paused — 1 queued message(s)...`, `[resume] processing...`). The prompt is
echoed as `[queued]` before we know it's a steer, and there's no way to cleanly indicate it.

## Desired behavior

1. **Not busy + Enter**: normal prompt, no label
2. **Busy + single Enter**: echo `[queued] message` (neutral color), message waits in queue
3. **Busy + double Enter** (within 1000ms): echo `[steering] message` (orange) as a NEW
   prompt block below whatever the model has written since `[queued]`. Abort current
   generation, promote this message to front of queue, process immediately.
4. No `[pause]`/`[resume]` noise.

The scrollback tells an honest chronological story:

```
<model output>
[queued] This is my prompt
<model continues to write — then user double-enters>
[steering] This is my prompt
<new generation starts>
```

The `[queued]` line naturally scrolls into the back buffer. No redraw needed.

## Changes

### 1. Protocol — add `steer` command type

**`src/protocol.ts`**
- Add `'steer'` to `CommandType`

The `steer` command means: "abort current generation for this session, promote the most
recently queued prompt to front, and resume processing immediately — silently."

### 2. Runtime — handle `steer` in `process-command.ts`

**`src/runtime/process-command.ts`**

Add a `steer` handler (alongside pause/resume/drop):
- Abort current generation (`runtime.activeAbort?.abort()`)
- Promote the last queued `prompt` command to front of queue
- Publish a new `prompt` event with the text (for the `[steering]` echo)
- Resume the session (unfreeze scheduler, clear pausedByUser)
- Emit status
- NO `[pause]`/`[resume]` publishLine messages

### 3. Scheduler — add `promoteLastPrompt`

**`src/runtime/command-scheduler.ts`**
- `promoteLastPrompt(sessionId)`: find the last `prompt` command in the session's queue,
  move it to position 0, return the command (or null if none found). Other queued commands
  keep their relative order behind it.

### 4. Client — clean up `handleDoubleEnter`

**`src/cli/client.ts`**
- `handleDoubleEnter()`: send a single `steer` command instead of `pause` + `resume`
- Remove the `pushLocal('local.warn', '⏎⏎ steering...')` message
- Keep `wasBusyOnLastSubmit` guard (if not busy, double-enter is no-op)

### 5. Prompt event — add label field

**`src/protocol.ts`** — add `label?: 'queued' | 'steering'` to the prompt event type

**`src/runtime/process-command.ts`**:
- When echoing a prompt while busy: publish with `label: 'queued'`
- When steer publishes the steering echo: publish with `label: 'steering'`

**`src/cli/format/index.ts`** + **`src/cli/tui/format/prompt.ts`**:
- Render prompt label prefix from the event's `label` field
- `queued` → dim `[queued]` prefix
- `steering` → orange `[steering]` prefix
- No label → no prefix (normal prompt)

This replaces the current approach of baking `[queued]` into the prompt text in
process-command.ts.

### 6. Double-enter timeout: 500ms → 1000ms

**`src/cli/tui.ts`** line 1409: change `500` to `1000`

## Summary of file changes

| File | Change |
|------|--------|
| `src/protocol.ts` | Add `'steer'` to `CommandType`; add `label` to prompt event |
| `src/runtime/process-command.ts` | Handle `steer` silently; use `label` for prompt echo |
| `src/runtime/command-scheduler.ts` | Add `promoteLastPrompt(sessionId)` |
| `src/cli/client.ts` | `handleDoubleEnter` sends `steer` instead of pause+resume |
| `src/cli/tui.ts` | Timeout 500→1000 |
| `src/cli/format/index.ts` | Render prompt label from event field |
| `src/cli/tui/format/prompt.ts` | Orange styling for steering prompts |

## Test plan

- Unit: `command-scheduler.test.ts` — `promoteLastPrompt` moves last prompt to front
- Unit: prompt formatting — `[queued]` dim, `[steering]` orange, no label = no prefix
- Manual: submit while busy → see `[queued]`, double-enter → see `[steering]`, model restarts
