# E2E Testing Plan

## Test commands

- `bun test` — unit tests only (fast, src/**/*.test.ts)
- `bun run test:e2e` — e2e tests only (tests/**/*.test.ts)
- `bun run test:all` — both

Configuration: add `[test] root = "src"` to `bunfig.toml` so bare
`bun test` stays fast. E2e script runs `bun test ./tests`.

## Test harness

Two approaches, use both:

### 1. IPC-based (runtime logic)

Start hal in **headless mode** with a fresh temp state dir. Write
commands to `commands.ason`, read events from `events.ason`. No TUI,
no PTY needed. Fast and deterministic.

Good for: session lifecycle, commands, model switching, handoff, fork,
IPC event ordering, command scheduling.

```ts
// tests/helpers/harness.ts
interface HalProcess {
  proc: Subprocess
  stateDir: string
  sendCommand(type: string, text?: string): Promise<void>
  waitForEvent(match: (e: RuntimeEvent) => boolean, timeoutMs?: number): Promise<RuntimeEvent>
  waitForLine(pattern: string | RegExp, timeoutMs?: number): Promise<string>
  stop(): Promise<void>
}

async function startHal(options?: { fresh?: boolean }): Promise<HalProcess>
```

### 2. PTY-based (TUI behavior)

Spawn hal inside a pseudo-terminal. Send raw keystrokes, read screen
output. Needed for input handling, rendering, resize, key combos.

Save for later — IPC-based covers most logic. PTY tests are slower
and platform-dependent.

## Test files

Organized by subsystem. Each file tests one area.

### tests/startup.test.ts — Startup & lifecycle

From commits: owner election, Ctrl-C restart (exit 100), Ctrl-D exit,
web server port, headless mode, fresh state.

| Test | What |
|------|------|
| starts in headless mode | spawn with --headless, verify owner claim |
| fresh state dir is empty | -f flag creates temp state, no sessions |
| startup emits session + model events | first events contain [session] and [model] lines |
| startup emits context status | [context] line present in startup events |

### tests/session.test.ts — Session management

From commits: session create/load/save, registry, /reset, /close,
/cd, per-tab input history.

| Test | What |
|------|------|
| new session appears in registry | send prompt, verify session in registry |
| /reset clears session | send prompt, /reset, verify empty |
| /cd changes working dir | /cd /tmp, verify session workingDir updated |
| /cd to nonexistent dir fails | /cd /nonexistent, verify error event |
| /cd - returns to previous dir | /cd /tmp, /cd -, verify back |
| /close removes session | create 2 sessions, close one, verify removed |

### tests/fork.test.ts — Fork

From commits: /fork command, fork metadata.

| Test | What |
|------|------|
| fork creates new session | send prompt, /fork, verify 2 sessions |
| fork copies conversation history | fork, load new session, messages match |
| fork while busy is refused | start long prompt, /fork, verify error |
| fork after pause works | start prompt, /pause, /fork, verify success |
| forked sessions are independent | fork, send different prompts to each |

### tests/handoff.test.ts — Handoff

From commits: handoff summary, session rotation, handoff-previous.md.

| Test | What |
|------|------|
| handoff creates handoff.md | send prompts, /handoff, verify file |
| handoff rotates session | after handoff, session-previous.ason exists |
| handoff loads in new session | handoff, new prompt, verify handoff in messages |

### tests/model.test.ts — Model switching

From commits: /model command, model change in history, system prompt
reload.

| Test | What |
|------|------|
| /model shows current model | /model with no args, verify info event |
| /model switches model | /model codex, verify config updated |
| model change recorded in history | switch model, verify [model changed] message |
| system prompt reloads on model change | switch model, verify prompt reload event |

### tests/ipc.test.ts — IPC event system

From commits: file-backed IPC, tailFile reliability, event publishing,
command scheduling.

| Test | What |
|------|------|
| commands flow through to events | send command, verify matching event |
| multiple sessions scheduled | send prompts to 2 sessions, both get responses |
| pause interrupts active session | start prompt, /pause, verify paused event |
| events are session-scoped | events for session A don't leak to session B |

### tests/commands.test.ts — CLI commands

From commits: /help, /system, /todo, /bug, /snapshot.

| Test | What |
|------|------|
| /help lists commands | verify event contains command names |
| /system shows prompt | verify event contains system prompt text |
| /todo appends to TODO.md | /todo test item, verify file updated |

### tests/prompt.test.ts — Prompt processing

From commits: system prompt loading, SYSTEM.md + AGENTS.md, model
tags, variable substitution.

| Test | What |
|------|------|
| system prompt loads SYSTEM.md | verify system prompt contains expected content |
| AGENTS.md is appended | create AGENTS.md in workingDir, verify loaded |
| model tags filter correctly | claude model gets claude block, not codex block |
| variables are substituted | ${cwd}, ${model}, ${date} replaced |

## Priority order

1. **Harness** (`tests/helpers/harness.ts`) — without this nothing works
2. **startup.test.ts** — proves the harness works
3. **session.test.ts** — core session lifecycle
4. **ipc.test.ts** — event reliability
5. **fork.test.ts** — new feature, needs coverage
6. **commands.test.ts** — command routing
7. **model.test.ts** — model switching
8. **handoff.test.ts** — needs provider mock (generates summary)
9. **prompt.test.ts** — system prompt assembly

## Notes

- Each test gets a fresh temp state dir (cleaned up after).
- Tests must not depend on auth tokens — mock the provider or use a
  dummy that echoes back.
- Timeout: 5s per test default, 15s for handoff (LLM call).
- The harness `waitForEvent` should use tailFile internally for
  efficiency.
- Tests should not depend on timing — use event matching, not sleeps.
