# E2E Test Plan

## How to run

```bash
bun test              # unit tests only (src/**/*.test.ts)
bun test:e2e          # e2e tests only (tests/**/*.test.ts)
bun test:all          # everything
```

## Test harness

Each e2e test:
1. Starts hal in a fresh temp state dir (`-f` flag or `HAL_STATE_DIR`)
2. Communicates via IPC files (commands.ason / events.ason) — same as a real client
3. Waits for a readiness signal before sending commands
4. Asserts on emitted events
5. Cleans up (kills process, removes temp dir)

Helper: `tests/harness.ts` — `startHal()`, `sendCommand()`, `waitForEvent()`, `stop()`.

## Test files

### tests/startup.test.ts — Startup & lifecycle
- Starts as owner, emits session restored/new message
- Second instance starts as client
- Client promotes to owner when owner exits
- Ctrl-C exits with code 100 (restart)
- Ctrl-D exits with code 0

### tests/sessions.test.ts — Session management
- New session created on first start
- `/reset` clears session state
- `/cd` changes working directory
- `/cd -` returns to previous directory
- Session registry persisted across restart

### tests/tabs.test.ts — Tab / multi-session
- Ctrl-T opens new tab (new session in registry)
- `/close` removes session from registry
- `/fork` clones session state to new session
- Fork refused while session is busy

### tests/model.test.ts — Model switching
- `/model codex` switches model in config
- `/model claude` switches model in config
- Model change recorded in conversation history

### tests/commands.test.ts — Command processing
- Prompt enqueued and processed
- `/pause` aborts active generation
- Double-enter steers (pause + immediate prompt)
- `/handoff` generates summary and rotates session
- `/todo` appends to TODO.md

### tests/ipc.test.ts — IPC bus
- Commands written and tailed correctly
- Events written and tailed correctly
- Owner lock claimed and released
- State file updated on status changes

### tests/web.test.ts — Web server
- Web server starts on configured port
- SSE stream emits events
- Web server port released on exit
- Port retry with backoff after promotion

### tests/input.test.ts — Terminal input (if feasible)
- Shift+Enter adds newline
- Arrow up/down navigates history
- Arrow up/down navigates multi-line input
- Tab completion for commands and models

## Priority order

1. **startup.test.ts** — foundation, proves harness works
2. **sessions.test.ts** — core state management
3. **ipc.test.ts** — transport layer
4. **commands.test.ts** — command processing
5. **tabs.test.ts** — multi-session
6. **web.test.ts** — web interface
7. **model.test.ts** — model switching
8. **input.test.ts** — TUI input (hardest, may need pty)
