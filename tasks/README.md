# Tasks

Shared context for implementing every task in this project: goals, constraints, conventions, and anything a fresh build needs to know.

Each task lives in a directory named by its ID, with a task.ason record and optional supporting files. Use `tsk ready` to find work, `tsk show <id>` for details, and `tsk done <id>` when it is implemented.

## Goal

Hal is built from scratch with tsk. The previous implementation (repo
anttikissa/hal-old) is for reference only.
Not an identical clone, but: smaller, better architected, more capable
where possible, and it leaves behind a set of tasks with implementation
notes from which Hal can be rewritten again and again by more capable
models. The tasks are the product as much as the code.

## Terms

- **host**: the one process that owns a home (sessions, provider
  calls, every state write). It also serves remote terminal and web
  clients.
- **peer**: another Hal process on the same machine, in the client
  role; it can become host in automatic mode. In server mode (`hostMode:
  'server'`, task fd1), it waits for the supervised `hal serve` process.
- **client**: anything following sessions: the host's own terminal, a
  peer, a browser.
- **server**: only the listeners (Unix socket, HTTP), never a role.

How sessions behave (states, who may pause, failures, interrupt delivery,
drafts) is decided in tasks/j1/states.md; forms, commands, modals,
approval and how terminal and web share code in tasks/w4/forms.md.
Follow them. A design doc lives in the task that owns it; later tasks
point to it.

## Messages and notices (nzv)

A turn spans provider requests until an answer; a round is one request and
reply, followed by its tools before the next request. Messages carry their
source. Hal notices report facts in meta framing. The inbox holds messages;
delivery is at the next round, interrupt, or after this turn. Existing wire
fields and tool flags remain compatible.

Before a request, history.messages freezes pending notices on a user record,
with original source numbers, timestamps and text. This is the same durable
provider input used for prompts and delivered inbox messages, not a second
queue. Notice-only records neither start a turn nor become a recalled prompt.
Host facts (resource levels, neighbor activity and restarts, task nvm) use
notice records through this path, never suffixes inside bash output.
Replay places notices after tool results, never inside an unfinished exchange;
later facts do not move into earlier request prefixes. Model and cwd changes
interrupt active work through hard steering and continue with the new context
(task 6eq); unsafe-to-stop calls finish first. Display order is block-start
order in both clients; it is separate from delivery eligibility.

## Architecture

- Runs on macOS and Linux only: the host lock uses flock through bun:ffi
  and clients talk over Unix sockets. Windows is left to its first user.
- One host per home (sessions/ + state/) owns sessions, provider calls and all state
  writes. Every other process is a client over a Unix socket; if the
  host goes away, a client takes over in automatic mode. Server-mode
  clients wait for the supervised host. Reconnect = connect + snapshot.
- Every client (terminal, peer, browser) uses one connection core,
  `src/common/connection.ts`, over a small transport: in-process or
  Unix socket (`src/client/link.ts`), WebSocket (`src/common/ws-link.ts`,
  the browser and `./run -r <host>`, task tr).
  It re-opens followed sessions and resends unanswered commands; each
  command's client-made id lets the host ignore repeats. The host side
  of every transport is `host.adapt()`.
- Typed text is never lost: each session's draft lives on the host
  (`src/host/drafts.ts`) and in every client's local store, synced by
  `src/common/drafts.ts`, which also keeps sent prompts pending until
  acknowledged (task rw).
- Conversation truth is per-session ASONL history of provider-neutral
  blocks. Provider input is rebuilt from it; display state never is.
- Providers are small request/stream mappers behind one interface.
  The system prompt is built per request from its inputs alone
  (`src/host/system-prompt.ts`) so it stays byte-identical for caching;
  what changes mid-session (cwd, model) is also told as a <meta> note.
- Small ASON state files (config, metadata, credentials) go through
  `liveFiles.liveFile` in `src/host/live-file.ts`; never hand-roll
  reading, parsing or writing them.
- Credentials, tokens and private keys live only in `secrets/` in the
  home (task de): owner-only (0700), every file 0600, opened through
  `secrets.file` in `src/host/secrets.ts`. Logs, diagnostics, caches
  and transcripts never hold them; state/ keeps only files without
  credentials.
- Corrupt data is an error, not a case to handle: a malformed history
  record, metadata or ASON file throws with its path and stops that
  session (or startup), and nothing is skipped, reset or patched
  around it. The one exception is a torn last history line, which a
  crash mid-write leaves and opening a session cuts off. The user
  prefers this to defensive code.
- Fail fast and loud, never speculative defensive code: an unreadable
  session is never skipped or hidden. Its tab stays, failed with the
  reader's error (path, record); opening it is refused with that error.
  Retiring a history record type means removing its records from the
  existing histories too; the reader keeps no dead types.
- Slash commands are files in `src/host/commands/` (one per command,
  found by listing the directory; `src/host/commands.ts`). They run and
  complete on the host; a command that asks re-runs with the answer.
  A command may declare a `key`; `clientOnly` commands (quit, restart,
  suspend, redraw) run in the client from `src/client/commands/`. One
  shared list in `src/common/commands/` feeds /keys, /help, completion
  and key dispatch (tasks/w4/forms.md, Keys and client-only commands).
- Model tools are files in `src/host/tools/` the same way (one per
  tool, exporting `tool`; `src/host/tools.ts` is the registry). Calls
  run one after another in call order, never in parallel.
- Settings: common ones in config.ason (home root, declared in one
  table in src/common/settings.ts, task pc); anything else by
  overriding exported functions or fields from gitignored `local.ts`.
  Owned, hot-reloaded hooks on those functions go in plugins/*.ts
  (src/host/plugins.ts, task an).
  Settings marked `browser` reach the web page as JSON the host writes
  into each page it serves (task rr), not over the WebSocket.

## Layout and module conventions

- `src/common/` — browser-safe types and pure functions (ASON, blocks).
  No disk, sockets or process globals; imports only common.
- `src/host/` — sessions, providers, disk. Imports host and common.
- `src/client/` — terminal. Imports client and common.
- `src/perf/` — the performance harness behind scripts/perf (tasks y9,
  te); never loaded by Hal. Imports perf and common.
- `src/web/` — browser client, a SolidJS 2 app (task 1b). Imports web
  and common only; host/web.ts bundles `main.tsx` into `index.html`
  with Bun.build on first request, compiling .tsx with the JSX
  compiler it imports dynamically then. Solid and the compiler are
  browser-only: no host, client or common module imports them
  statically. Components are .tsx files in `src/web/components/`, one
  exported component each, whose root element has a class named after
  it (`<form class="Question">`). Decisions (keys, view state,
  reconnect, scroll maths) stay in plain .ts modules (app.ts, view.ts,
  link.ts), unit-tested without a browser or Solid; main.tsx renders
  only when `document` exists. Colors come only from the CSS the host
  generates from src/common/colors.ts (none written in src/web); layout
  CSS lives in the one stylesheet in index.html.
- `src/main.ts` — the composition root and the only file that wires
  host and client together. Tests sit next to code as `*.test.ts`.
- US English spelling (color, center, gray, canceled, summarize) in
  code, names, comments, docs and tasks; quoted outside text keeps its
  own. Persisted fields follow too: no compatibility shims for older
  British-spelled records (task k45).
- `src/conventions.test.ts` enforces the import rules and that
  importing every module (main.ts included) prints nothing, registers
  no signal handlers and leaves no timers or watchers running.
- Non-test modules under src/ stay at or under 400 lines (`wc -l`), so
  each fits one read and has one job. conventions.test.ts enforces it;
  its short exception list gives each entry a reason (ason.ts is one
  cohesive format; others name the task that splits them) and fails
  when a listed file shrinks or disappears. Tests have no limit.
- `./test` runs bun test, tsc and oxlint, and fails on any lint
  warning (.oxlintrc.json turns off only no-control-regex: a terminal
  program matches control bytes on purpose). No tautological tests:
  none that restates a one-line function, repeats a constant, or
  checks the test file's own helper; delete such a test rather than
  keep it. A test run leaves nothing in the temp dir: tests delete the
  homes they make, and a test that spawns ./run sets HAL_HOME and
  TMPDIR to such a home (SIGKILL skips ./run's cleanup trap).
- Importing a module does no I/O, timers, watchers or signal setup.
  Startup work lives in an idempotent `init()`; `main.start()` calls
  them in order, and runs only when main.ts is the entry point.
- Each module exports one mutable object (`export const foo = { ... }`)
  and calls its own functions through it (`foo.bar()`, not `bar()`), so
  eval, hot patches and `local.ts` overrides take effect. Mutable state
  goes in a `state` field on that object.
- Settings that are constants are plain values on these objects
  (`ttlMs: 3_600_000`, read as `models.ttlMs`); a plugin overrides one
  with `plugin.set(obj, key, value)` and the loader undoes it (task
  d41). Read them through the object at call time — never destructure
  or capture them at import. Values that compute something (read
  config.ason like `models.defaultModel()`, or derive from other
  values) stay functions.

## Web client (Solid)

Before implementing or reviewing UI, read `.agents/skills/ui-craft/SKILL.md`.
Catalog equivalent variants, fix shared layout owners, and inspect their
rendered short/long, open/closed and responsive states before claiming a
visual fix. Passing tests alone does not establish visual quality.

Solid 2 is not Solid 1: read the current tasks/1b/web.md before writing
web code; tasks/1b/old-web.md is historical reference. The notes of
1b and 4s cover specific implementation failures. Match
@solidjs/compiler to the latest Solid 2 runtime; src/host/web.ts loads
it only when building the page with Bun, not on the host startup path.

- Render only what changed. A change costs DOM work for what it
  touched: typing reaches the composer alone, a streamed delta one
  card's text, a new item one new card; reconnecting, switching tabs
  and loading earlier history rebuild nothing that stays. The CDP test
  in host/web.test.ts asserts it with a MutationObserver (task 4s).
- Keep identity. Update data in place or gate it (a memo per field
  with a real equality, or a store merged with reconcile(data, key));
  never rebuild objects every redraw that bindings then chase. Never
  build DOM inside a Show fallback or getter that reads such a value:
  it re-creates the node. An entrance animation that replays means a
  remount, which the user sees as a flash.
- List keys survive every change the list sees (position only while
  it only appends; an id only if it exists from the first streamed
  byte). UI state such as open or closed belongs to the item, not to
  the DOM slot, so it never moves to another item or tab.
- One scroller, the transcript; nothing scrolls inside it, and an
  overlay scrolls itself, never the page behind it.
- Links are cross-cutting: anything one client can link to (a session,
  a block, an image, a paste), the other can too, at the same address
  under the host's webUrl (task e3), and a terminal link carries a
  one-time code only in its hidden OSC 8 target.
- Anything that navigates is an `<a href>` (Cmd-click, middle-click,
  copy link keep working). The browser never polls: the host pushes.
- Phones: fields at least 16px, touch targets at least 44px, touch
  behavior keyed on `pointer: coarse` rather than width, the page
  sized from visualViewport (iOS keyboard), no horizontal page overflow,
  and text kept out of the safe area: viewport-fit=cover (else every
  env(safe-area-inset-*) is 0) and edge rows padded with them (4s).
  The tab strip alone supports native horizontal momentum scrolling (ce);
  its secondary chevrons are 24px wide but retain 44px height.
- Decisions live in .ts modules with unit tests; looks are checked by
  hand in a real browser at phone and desktop widths. No tests that
  read source or copy CSS; CDP tests assert structure (nodes kept,
  one scroller, delegated events firing).

## Look: retro sci-fi terminal (user's standing preference)

Bold, colorful, contrasty: think 2001: A Space Odyssey, Alien, Blade
Runner, Tron (the early-1980s film), CRT VT100 terminals glowing in the dark. Saturated phosphor
hues on near-black, lit solid edges (a card's left bar is an LED,
not a hairline; no glow or blur: the user doesn't want it), square corners everywhere (cards, buttons, tabs,
fields, dialogs; no border-radius). Never meek, pastel, washed-out or
corporate-neutral (the user's words: "be-afraid-say-nothing"). No
slate: no blue-gray surfaces or buttons in any theme, the default
included. Color
changes are proposed to the user with options before they land; he
decides. Spacing follows the terminal grid (quarter lines vertically,
whole ch across), and small text is fine where space is scarce; task gn
holds the rest of what the user chose (selection, focus, tabs). Readable text below still holds.

## Emergency keys (invariants)

- Ctrl-C quits, Ctrl-Z suspends, Ctrl-R restarts — in every state,
  including the legacy bytes and the kitty CSI-u forms.
- They are found in raw stdin (`src/common/emergency.ts`) before any
  stateful decoding; no escape parser, paste buffer, editor, modal,
  queue or host round-trip may sit in front of them or delay them.
- Handling is synchronous in the client (`src/client/terminal.ts`) and
  never waits on the host. No feature may rebind or capture them.
- One exception (task ker): Ctrl-R in the terminal that runs the host,
  while a call flagged unsafeToStop runs there, opens the restart
  dialog (Wait or Restart anyway) instead of restarting. The check is
  synchronous, in the host process. This is the only modal that may
  stand before Ctrl-R; Ctrl-C and Ctrl-Z never wait.
- Quit and restart restore the terminal and never clear it or use the
  alternate screen, so the last frame stays visible, all but its last
  row (the help row), which the shell prompt takes without scrolling.
  Restart exits with `terminal.restartCode` (100), which ./run answers
  by starting again.
- Suspend restores the terminal and SIGSTOPs the process group; on
  SIGCONT it re-enters raw mode and calls `terminal.redraw()`.

## Motion (web)

After Emil Kowalski: animate only opacity, color and transform (the
user's exceptions: a card opening or closing animates its height, as
in tasks/4s/demo.tsx [F12], and a tab marker appearing its width); one
strong ease-out (--ease-out); short (80–300 ms), exits faster than
entrances; nothing that happens in milliseconds (a round trip) may
show, so state changes that are usually brief start after a delay;
no motion under prefers-reduced-motion.

## Readable text (invariant, terminal and web)

Never use faint/dim (SGR 2), and never fade text at rest on the web
(opacity, filter or color-mix); animations may pass through it. Every
glyph meets WCAG 2.2 AA contrast against the background it actually
sits on (the block's own, else the lightest dark background we
support): text at least 4.5:1, including placeholders and disabled
items (terminal text is never "large text"); meaningful non-text marks
(Hal cursor, tab glyphs, rules, control borders) at least 3:1. The one
exception, the user's choice: the example request in an empty prompt
(oklch.faint; about 3.1:1 on the HAL palette), which says nothing
needed and stays visibly distinct from typed text.
Hierarchy comes from hue, lightness steps above the minimum, bold or
position, never from dropping below it. Don't overdo testing this;
just be careful when introducing new colors.

## Artifacts

Files in a task directory are its artifacts, copied from the old Hal.
"Lift" means copy into src and adapt; "reference" means read, don't
copy. Never read the old Hal directly: artifacts survive `tsk reset`.

## Plumbing visible (UI guide)

Show everything relevant once: identifiers users act on, file paths,
failures and complete output. Omit what nobody reads, such as tool call
IDs, argument types and restated defaults; session files keep them.
A closed tool says concisely what it does; opening it shows the detail
and the whole output. Bash reads like a terminal: `$ command` (`&` when
backgrounded), declared files as "Edits a.ts, src/*.ts", then streaming
output. Show non-default controls, invalid or unfamiliar arguments and
why Hal rejected a call. Use readable text, not JSON/ASON.
