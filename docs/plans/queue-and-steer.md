# `/queue` and `/steer` commands

## Problem
When a session is busy, typing a prompt shows "Session is busy" and does nothing. Users want two options:
1. **Queue** a message to be sent after the current generation finishes.
2. **Steer** (interrupt) the current generation to redirect the model.

## Design

### `/queue <prompt>`
- Stores a pending message for the session.
- When the current generation finishes, the queued prompt is automatically sent.
- Persisted to disk (like drafts) so it survives quit/restart.
- Only one queued message per session (last one wins — user can overwrite).
- File: `state/sessions/<id>/queue.txt`
- Show in the UI: `[queued] <first line preview>` info block.
- `/queue` with no args shows current queue or clears it.
- On generation complete: runtime checks for queued message, if found, sends it as a prompt.

### `/steer <prompt>`
- Aborts the current generation (like Escape/pause).
- Appends a user message to history that tells the model to adjust course.
- Immediately re-starts generation with the steering message injected.
- The steering prompt appears as a special `input` block with label "steering".
- `steer` is already in `CommandType`.

## Implementation

### Files to modify:
1. **`src/cli/queue.ts`** (new) — `saveQueue`, `loadQueue`, `clearQueue` (like draft.ts)
2. **`src/runtime/commands.ts`** — Add `queue` and `steer` command handlers
3. **`src/protocol.ts`** — Add `queue` to `CommandType`
4. **`src/cli/keybindings.ts`** — Route `/queue` and `/steer` through slash commands (already works via catch-all)
5. **`src/runtime/runtime.ts`** — After generation finishes, check for queued message
6. **`src/cli/keybindings.ts`** — Update help text
7. **`src/cli/event-handler.ts`** — Handle steering prompt label display

### Flow:

**Queue:**
1. Client sends `queue` command with text
2. Runtime saves to `queue.txt` and emits info "[queued] preview..."
3. In `startGeneration().finally()`, runtime checks for queue, if found, loads & clears it, then sends as prompt

**Steer:**
1. Client sends `steer` command with text  
2. Runtime aborts current generation (like pause)
3. Waits for abort to complete
4. Writes partial output to history (agent-loop already does this on abort)
5. Writes user steering message to history
6. Restarts generation with full message history
