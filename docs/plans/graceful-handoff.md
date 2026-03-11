# Graceful Handoff on Quit/Restart

## Goal

1. **Smooth handoff**: When host quits (ctrl-c/d) or restarts (ctrl-r) while sessions are active,
   print handoff message if other clients exist that can be promoted.
2. **Wait for destructive tools**: If bash/write/edit tools are mid-execution, gate the first
   ctrl-c/d/r behind a confirmation (second press forces).

## Design

### Detecting other clients

Find other `bun src/main.ts` processes (excluding self) via `pgrep`. These are potential promotees.

### Detecting destructive tools running

The runtime has `busySessionIds` but doesn't distinguish "streaming text" from "running bash".
Add a `runningTools` set to the Runtime that tracks `sessionId:toolName` while tools execute.
The agent loop already emits tool events with `phase: 'running'` — we can track from there.

Actually simpler: add a `Set<string>` `activeDestructiveTools` to Runtime. The agent loop adds to it
before executing bash/write/edit, removes after. The quit/restart path checks if non-empty.

### Quit/restart flow

In `cli.ts`:
- `quit()` and `restart()` check for destructive tools via IPC state (or runtime directly since
  the host process has both cli and runtime).
- If destructive tools running:
  - First press: show ephemeral info line "waiting for tool calls to finish; ctrl-c again to force"
  - Set a flag `pendingQuit`/`pendingRestart`
  - Second press: proceed normally
- If no destructive tools (or forced):
  - Find client PIDs
  - If active sessions exist AND clients exist: print handoff message
  - Proceed with quit/restart

### Handoff message

Print to stdout (after clearing TUI):
- Single client: `pid XXXX will continue from here`
- Multiple: `one of pids XXXX, YYYY will continue from here`
- No clients: (nothing extra, current behavior)

## Files to change

- `src/runtime/runtime.ts` — add `activeDestructiveTools: Set<string>`
- `src/runtime/agent-loop.ts` — track destructive tool execution in runtime
- `src/cli/cli.ts` — gate quit/restart, print handoff message
- `src/cli/keybindings.ts` — no change needed (already calls ctx.quit/restart)
- `src/ipc.ts` or `src/protocol.ts` — expose destructive tools in state (so cli can read it)
