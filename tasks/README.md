# Tasks

Shared context for implementing every task in this project: goals, constraints, conventions, and anything a fresh build needs to know.

Each task lives in a directory named by its ID, with a task.ason record and optional supporting files. Use `tsk ready` to find work, `tsk show <id>` for details, and `tsk done <id>` when it is implemented.

## Terms

- **host**: the one process that owns a home (sessions, provider
  calls, every state write). It also serves remote terminal and web
  clients.
- **peer**: another Hal process on the same machine, in the client
  role; it can become host.
- **client**: anything following sessions: the host's own terminal, a
  peer, a browser.
- **server**: only the listeners (Unix socket, HTTP), never a role.

How sessions behave (states, who may pause, failures, steering,
drafts) is decided in tasks/j1/states.md; forms, commands, modals,
approval and how terminal and web share code in tasks/w4/forms.md.
Follow them; don't reinvent them. A design doc lives in the task that
owns it; later tasks point to it.
## Architecture

- One host per home (sessions/ + state/) owns sessions, provider calls and all state
  writes. Every other process is a client over a Unix socket; if the
  host goes away, a client takes over. Reconnect = connect + snapshot.
- Every client (terminal, peer, browser) uses one connection core,
  `src/common/connection.ts`, over a small transport: in-process or
  Unix socket (`src/client/link.ts`), WebSocket (`src/web/link.ts`).
  It re-opens followed sessions and resends unanswered commands; each
  command's client-made id lets the host ignore repeats. The host side
  of every transport is `host.adapt()`.
- Conversation truth is per-session ASONL history of provider-neutral
  blocks. Provider input is rebuilt from it; display state never is.
- Providers are small request/stream mappers behind one interface.
- Small ASON state files (config, metadata, credentials) go through
  `liveFiles.liveFile` in `src/host/live-file.ts`; never hand-roll
  reading, parsing or writing them.
- Settings: common ones in config.ason (home root, declared in one
  table in src/common/settings.ts, task pc); anything else by
  overriding exported functions or fields from gitignored `local.ts`.

## Layout and module conventions

- `src/common/` — browser-safe types and pure functions (ASON, blocks).
  No disk, sockets or process globals; imports only common.
- `src/host/` — sessions, providers, disk. Imports host and common.
- `src/client/` — terminal. Imports client and common.
- `src/web/` — browser client (plain DOM, no framework). Imports web
  and common only; host/web.ts bundles `page.ts` into `index.html`
  with Bun.build on first request. DOM-free logic (view.ts, link.ts)
  is unit-tested; page.ts runs its `init()` only when `document` exists.
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

## Emergency keys (invariants)

- Ctrl-C quits, Ctrl-Z suspends, Ctrl-R restarts — in every state,
  including the legacy bytes and the kitty CSI-u forms.
- They are found in raw stdin (`src/client/emergency.ts`) before any
  stateful decoding; no escape parser, paste buffer, editor, modal,
  queue or host round-trip may sit in front of them or delay them.
- Handling is synchronous in the client (`src/client/terminal.ts`) and
  never waits on the host. No feature may rebind or capture them.
- Quit and restart restore the terminal and never clear it or use the
  alternate screen, so the last frame stays visible. Restart exits with
  `terminal.restartCode` (100), which ./run answers by starting again.
- Suspend restores the terminal and SIGSTOPs the process group; on
  SIGCONT it re-enters raw mode and calls `terminal.redraw()`.

## Artifacts

Files in a task directory are its artifacts, copied from the old Hal.
"Lift" means copy into src and adapt; "reference" means read, don't
copy. Never read the old Hal directly: artifacts survive `tsk reset`.
