# IPC & Multiplexing

## Architecture

Exactly one process is elected **owner** via `state/ipc/owner.lock` (or `${HAL_STATE_DIR}/ipc/owner.lock` when `HAL_STATE_DIR` is set).

- Owner responsibilities:
  - run runtime command processing loop
  - write runtime events and state snapshots
  - start web server (default `http://localhost:9001`, override `HAL_WEB_PORT`)
- Non-owner processes attach as clients and only append commands + read events/state.

`bun main.ts --headless` runs owner without a local CLI client.

## File Layout

```
state/ipc/
  owner.lock       -- lockfile: { ownerId, pid, createdAt }
  commands.asonl   -- append-only command log (all clients write)
  events.asonl     -- append-only event log (owner writes)
  state.ason       -- latest runtime snapshot
```

Implemented in `src/ipc.ts`.

## Protocol

Definitions are in `src/protocol.ts`.

### Command Types

`prompt`, `pause`, `continue`, `resume`, `steer`, `reset`, `compact`, `open`, `close`, `model`, `fork`, `topic`, `respond`

Commands are created with `makeCommand(...)` and appended to `commands.asonl`.

### Event Types

- `line`: leveled text (`info`, `warn`, `error`, `tool`, `meta`, `notice`)
- `chunk`: streamed assistant/thinking text (channel: `assistant` | `thinking`)
- `status`: busy/queue/active session snapshot; may include `activity` and `contexts`
- `sessions`: session list + active session id
- `command`: lifecycle (`queued`, `started`, `done`, `failed`)
- `prompt`: prompt echo (`text` + `source`; optional `label: 'steering'`)
- `tool`: tool execution events (`running`, `streaming`, `done`, `error`); includes `toolId`, `name`, `args`, optional `output` and `blobId`
- `question`: model asks user a question (`questionId`, `text`)
- `answer`: user answers a question (`question`, `text`)
## Queue & Scheduling Behavior

- Commands are processed sequentially from `commands.asonl`.
- One generation runs at a time per session.
- Sending a prompt while paused auto-resumes the session.

Runtime flow: `src/runtime/runtime.ts` tails `commands.asonl` and dispatches each command via `handleCommand()`.

## State Snapshot (`state.ason`)

`RuntimeState` fields include:

- `ownerPid`, `ownerId`
- `busy`, `queueLength`
- `busySessionIds`, `activeSessionId`, `pausedSessionIds`
- `sessions`, `contexts`
- `commandsOffset`, `updatedAt`

Owner updates this via `publish()` in `src/runtime/runtime.ts`.

## Notes

- Event tailing uses `parseStream(..., { recover: true })` to tolerate partial writes.
- `status` events used for transient model activity are emitted with `activity` text and are not a separate `activity` event type.
