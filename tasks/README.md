# Tasks

Shared context for implementing every task in this project: goals, constraints, conventions, and anything a fresh build needs to know.

Each task lives in a directory named by its ID, with a task.ason record and optional supporting files. Use `tsk ready` to find work, `tsk show <id>` for details, and `tsk done <id>` when it is implemented.

## Architecture

- One host per home (sessions/ + state/) owns sessions, provider calls and all state
  writes. Every other process is a client over a Unix socket; if the
  host goes away, a client takes over. Reconnect = connect + snapshot.
- Conversation truth is per-session ASONL history of provider-neutral
  blocks. Provider input is rebuilt from it; display state never is.
- Providers are small request/stream mappers behind one interface.
- Small ASON state files go through liveFile, never hand-rolled I/O.
- No config file: config values are functions on module objects,
  overridable from one gitignored `local.ts`.

## Layout and module conventions

- `src/common/` — browser-safe types and pure functions (ASON, blocks).
  No disk, sockets or process globals; imports only common.
- `src/host/` — sessions, providers, disk. Imports host and common.
- `src/client/` — terminal. Imports client and common.
- `src/main.ts` — the composition root and the only file that wires
  host and client together. Tests sit next to code as `*.test.ts`.
- `src/conventions.test.ts` enforces the import rules and that
  importing every module (main.ts included) prints nothing, registers
  no signal handlers and leaves no timers or watchers running.
- Importing a module does no I/O, timers, watchers or signal setup.
  Startup work lives in an idempotent `init()`; `main.start()` calls
  them in order, and runs only when main.ts is the entry point.
- Each module exports one mutable object (`export const foo = { ... }`)
  and calls its own functions through it (`foo.bar()`, not `bar()`), so
  eval, hot patches and `local.ts` overrides take effect. Mutable state
  goes in a `state` field on that object.
- Config values are plain functions on these objects, such as
  `models.defaultModel()`, read at call time — never captured at import.

## Artifacts

Files in a task directory are its artifacts, copied from the old Hal.
"Lift" means copy into src and adapt; "reference" means read, don't
copy. Never read the old Hal directly: artifacts survive `tsk reset`.
