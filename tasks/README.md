# Tasks

Shared context for implementing every task in this project: goals, constraints, conventions, and anything a fresh build needs to know.

Each task lives in a directory named by its ID, with a task.ason record and optional supporting files. Use `tsk ready` to find work, `tsk show <id>` for details, and `tsk done <id>` when it is implemented.

## Architecture

- One host per state root owns sessions, provider calls and all state
  writes. Every other process is a client over a Unix socket; if the
  host goes away, a client takes over. Reconnect = connect + snapshot.
- Conversation truth is per-session ASONL history of provider-neutral
  blocks. Provider input is rebuilt from it; display state never is.
- Providers are small request/stream mappers behind one interface.
- Small ASON state files go through liveFile, never hand-rolled I/O.
- No config file: config values are functions on module objects,
  overridable by gitignored `*.local.ts` files.
