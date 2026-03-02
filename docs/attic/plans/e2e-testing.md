# E2E Testing Plan

## Test commands

- `bun test` — unit tests only (fast, `src/**/*.test.ts`)
- `bun run test:e2e` — e2e tests only (`tests/**/*.test.ts`)
- `bun run test:all` — both

Config: `bunfig.toml` sets `[test] root = "src"` so bare `bun test`
stays fast. E2e script runs `bun test ./tests`.

## Test mode (`--test`)

Hal gains a `--test` flag. In test mode:

- No TUI, no raw mode, no ANSI escapes.
- Stdout emits one structured ASON record per event/output.
- Stdin accepts lines: prompts or `/commands`.
- Runs as owner with a fresh temp state dir.

### Stdout format

Each line is an ASON object:

```
{type:'ready'}
{type:'line', level:'status', session:'s-abc123', text:'[session] new session'}
{type:'line', level:'status', session:'s-abc123', text:'[model] anthropic/claude-opus-4-6'}
{type:'chunk', channel:'assistant', session:'s-abc123', text:'Hello'}
{type:'prompt', session:'s-abc123', text:'hi'}
{type:'status', busy:true, sessions:['s-abc123']}
{type:'sessions', active:'s-abc123', sessions:[{id:'s-abc123', workingDir:'/tmp/test'}]}
```

### Stdin format

Plain text lines — same as typing in the TUI:

```
hello world
/model codex
/cd /tmp
/fork
```

### Why this approach

- Tests the full pipeline: stdin → command parsing → IPC → runtime →
  events → structured output.
- No PTY, no ANSI parsing, fully deterministic.
- Easy to assert: read lines, parse ASON, match fields.

## TUI rendering tests (later, separate)

Unit tests of `tui.ts` with a `getScreenState()` function that returns
the current state of each region (status bar, activity, output, prompt).
Not e2e — fast unit tests that call TUI functions directly.

## Test harness

```ts
// tests/helpers/harness.ts
interface TestHal {
	sendLine(text: string): void
	waitFor(match: (record: any) => boolean, timeoutMs?: number): Promise<any>
	waitForLine(pattern: string | RegExp, timeoutMs?: number): Promise<any>
	waitForReady(timeoutMs?: number): Promise<void>
	stop(): Promise<{ exitCode: number }>
	stateDir: string
	records: any[] // all records received so far
}

function startHal(options?: { env?: Record<string, string> }): Promise<TestHal>
```

## Test files

### tests/startup.test.ts — Startup & lifecycle

| Test                 | What                                     |
| -------------------- | ---------------------------------------- |
| emits ready          | process starts, emits `{type:'ready'}`   |
| emits session event  | startup produces `[session]` status line |
| emits model event    | startup produces `[model]` status line   |
| emits context status | startup produces `[context]` status line |
| exits cleanly on EOF | close stdin, process exits 0             |

### tests/session.test.ts — Session management

| Test                     | What                                         |
| ------------------------ | -------------------------------------------- |
| /reset clears session    | send prompt, /reset, verify `[reset]` event  |
| /cd changes working dir  | /cd /tmp, verify sessions event with new dir |
| /cd to nonexistent fails | /cd /nonexistent, verify error event         |
| /cd - returns to prev    | /cd /tmp, /cd -, verify original dir         |

### tests/fork.test.ts — Fork

| Test                     | What                                         |
| ------------------------ | -------------------------------------------- |
| fork creates new session | /fork, verify sessions event with 2 sessions |
| fork while busy refused  | start prompt, /fork before done, verify warn |

### tests/commands.test.ts — CLI commands

| Test                 | What                                       |
| -------------------- | ------------------------------------------ |
| /model shows current | /model, verify info line with model name   |
| /model switches      | /model codex, verify status line           |
| /system shows prompt | /system, verify info line with prompt text |

### tests/ipc.test.ts — IPC & event flow

| Test                   | What                                         |
| ---------------------- | -------------------------------------------- |
| prompt flows through   | send prompt, verify prompt + response events |
| pause stops generation | start prompt, /pause, verify pause event     |

## Priority order

1. `--test` mode in main.ts (structured output, stdin reader)
2. `tests/helpers/harness.ts`
3. `tests/startup.test.ts` — proves everything works
4. Remaining test files

## Notes

- Each test gets a fresh temp state dir (auto-cleaned).
- Tests must not need auth tokens — either mock providers or test
  only commands that don't hit LLMs.
- Default timeout: 5s per test.
- Harness `waitFor` reads stdout lines, parses ASON, matches.
- No sleeps — always wait for specific events.
