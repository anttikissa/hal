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

`prompt`, `pause`, `resume`, `drop`, `queue`, `handoff`, `reset`, `close`, `restart`, `model`, `system`, `cd`, `fork`, `topic`

Commands are created with `makeCommand(...)` and appended to `commands.asonl`.

### Event Types

- `line`: leveled text (`info`, `warn`, `error`, `tool`, `meta`)
- `chunk`: streamed assistant/thinking text
- `status`: busy/queue/active session snapshot; may include `activity`
- `sessions`: session list + active session id
- `command`: lifecycle (`queued`, `started`, `done`, `failed`)
- `prompt`: prompt echo (`text` + `source`)

## Queue & Scheduling Behavior

- Commands are queued per session (FIFO within a session).
- Multiple sessions run concurrently up to `config.ason:maxConcurrentSessions` (default `4`).
- Immediate commands (bypass the session queue): `pause`, `resume`, `drop`, `queue`, `close`, `fork`, `cd`.
- `reset` drops queued commands for that same session before reset executes.
- Sending a prompt while paused auto-resumes the session.

Runtime flow:

- `src/runtime/process-command.ts`: normalize session, immediate commands, queue policy
- `src/runtime/command-scheduler.ts`: per-session queues + bounded concurrency
- `src/runtime/handle-command.ts`: command dispatch/handlers

## State Snapshot (`state.ason`)

`RuntimeState` fields include:

- `ownerPid`, `ownerId`
- `busy`, `queueLength`
- `busySessionIds`, `activeSessionId`
- `sessions`
- `commandsOffset`, `updatedAt`

Owner updates this via `publishStatus(...)` in `src/runtime/event-publisher.ts`.

## Notes

- Owner startup trims `events.asonl` (`resetBusEvents`) — keeps last 500 events so clients can hydrate scroll history.
- Event tailing uses `parseStream(..., { recover: true })` to tolerate partial writes.
- `status` events used for transient model activity are emitted with `activity` text and are not a separate `activity` event type.
