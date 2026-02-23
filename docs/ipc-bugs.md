# IPC Bugs / Audit Findings

Date: 2026-02-23

This document summarizes how `state/ipc/*` is used and the bugs found while tracing the runtime, CLI, and web clients.

## IPC File Usage (`state/ipc/`)

- `owner.lock`
	- Owner election lock file.
	- Written/read in `src/ipc.ts` (`claimOwner()`, `releaseOwner()`).
	- Used by startup and promotion logic in `main.ts`.
- `commands.ason`
	- Append-only command bus.
	- Clients/web append commands (`appendCommand()`).
	- Owner tails and processes commands (`tailCommands()` -> `processCommand()`).
- `events.ason`
	- Append-only event bus for runtime output, status, sessions, and bootstrap messages.
	- Runtime and bootstrap code append events (`appendEvent()` / `publish*()`).
	- CLI and web clients read recent history and then tail for live updates.
- `state.ason`
	- Snapshot state for fast attach/bootstrap (`/state`, CLI startup).
	- Updated primarily from `publishStatus()` and owner claim/release.

## Findings (ordered by severity)

1. **Web SSE event parsing is broken (ASON emitted, JSON expected).**
	- `src/web.ts` serializes SSE payloads with ASON (`stringify()`), not JSON.
	- Browser code uses `JSON.parse()` for incoming SSE messages.
	- Result: streamed events are dropped unless they accidentally parse as JSON.
	- References: `src/web.ts:5`, `src/web.ts:102`, `src/utils/ason.ts:92`.

2. **Commands can be lost during owner restart/promotion gaps.**
	- `tailCommands()` starts from current EOF, not from a persisted offset.
	- If commands are appended while no owner is tailing, the new owner skips them.
	- `commandsOffset` exists in runtime state but is not used.
	- References: `src/ipc.ts:203`, `src/ipc.ts:205`, `src/protocol.ts:124`, `src/ipc.ts:38`.

3. **Attach/reconnect can lose events (recent-snapshot to tail race).**
	- CLI and web both do:
		1. `readRecentEvents(...)`
		2. later start `tailEvents()`
	- `tailEvents()` starts at current EOF, so events appended between (1) and (2) are missed.
	- This is a real detach/attach problem.
	- References: `src/cli/client.ts:557`, `src/cli/client.ts:187`, `src/web.ts:186`, `src/web.ts:198`, `src/ipc.ts:209`.

4. **Paused state is not restored correctly on attach.**
	- Full `status` events include `pausedSessionIds`.
	- `state.ason` does not persist paused session IDs.
	- CLI bootstrap restores `busySessionIds` from state but does not rebuild paused state from recent events.
	- Result: after attach/restart, UI can fail to show `Paused` / resume hint until another full status event arrives.
	- References: `src/runtime/event-publisher.ts:115`, `src/protocol.ts:116`, `src/cli/client.ts:543`, `src/cli/client.ts:555`, `src/cli/client.ts:560`.

5. **Global (`sessionId: null`) line events are routed into the active tab transcript.**
	- CLI renders non-status events with `sessionId: null` into the currently active tab.
	- Some events are intentionally global (e.g. close notices, owner release signal).
	- Result: global notices can appear in the wrong tab history.
	- References: `src/cli/client.ts:666`, `src/cli/client.ts:669`, `src/runtime/handle-command.ts:435`, `src/ipc.ts:175`.

6. **Web UI mixes all sessions into one stream (no session filtering).**
	- Web client appends every `line`/`chunk` event regardless of `sessionId`.
	- Commands are sent to a single `activeSessionId`.
	- Result: users can see output from other sessions while typing into one session.
	- References: `src/web.ts:83`, `src/web.ts:90`, `src/web.ts:105`.

7. **Web status badge misinterprets partial `status` events as global runtime state.**
	- `publishActivity()` and `publishContext()` emit lightweight `status` events for one session.
	- Web treats every `status` event as authoritative global `busy/idle`.
	- Result: web header can show incorrect busy/idle state (especially with multiple sessions).
	- References: `src/runtime/event-publisher.ts:122`, `src/runtime/event-publisher.ts:135`, `src/web.ts:103`.

8. **Per-session model changes are not broadcast live via `sessions` events (regression from per-tab model feature).**
	- `SessionInfo` now includes `model`.
	- `/model` persists the per-session override, but `runModel()` does not call `emitSessions(true)`.
	- Existing clients that rely on `sessions` events do not get the model metadata change live.
	- They may only see it after reconnect/bootstrap via `state.ason` or another session-list event.
	- References: `src/session.ts:11`, `src/session.ts:14`, `src/runtime/handle-command.ts:311`, `src/runtime/handle-command.ts:328`, `src/runtime/handle-command.ts:330`.

9. **Per-session model changes do not refresh estimated context in the UI.**
	- `/model` reloads the system prompt for the new model (which can change prompt bytes/tokens).
	- But it does not publish a fresh estimated context afterward.
	- `runCd()` and `runReset()` do refresh context, so this is inconsistent.
	- References: `src/runtime/handle-command.ts:341`, `src/runtime/handle-command.ts:344`, `src/runtime/handle-command.ts:307`, `src/runtime/handle-command.ts:408`.

10. **Protocol/type drift: bootstrap emits `line.level = "status"` but `EventLevel` does not include it.**
	- Runtime emits bootstrap lines with level `"status"`.
	- `EventLevel` type only allows `info | warn | error | tool | meta`.
	- This is a typing/schema mismatch (can hide bugs or require `any` escape hatches).
	- References: `main.ts:64`, `src/protocol.ts:51`.

## Global vs Session Event Handling Notes

- The codebase already distinguishes some event classes correctly:
	- `sessions` events are handled globally in the CLI (`syncTabsFromSessions()`).
	- `status` events are handled specially in the CLI and are not added to scrollback.
- The biggest scoping problems are:
	- global `line` events rendered into the active tab (CLI)
	- all session output mixed into one stream (web)
	- partial `status` events treated as full/global status (web)

## Per-Tab Model Feature: Did It Cause Bugs?

Yes.

- It introduced a **live sync bug**: `/model` updates `SessionInfo.model` but does not emit a `sessions` update.
- It also introduced/stresses a **context display bug**: changing model can change system prompt size, but `/model` does not publish updated estimated context.

## Attach/Detach Clarification

There is no explicit `attach` / `detach` command in the code. The observed problems are in client reconnect/bootstrap behavior:

- snapshot + tail race can drop events
- paused state is not restored from persisted state
- global/session event scoping is inconsistent across CLI vs web
