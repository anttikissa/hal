# Plan: Server-owned sessions & new session ID format

## Problem

1. **Client creates session IDs** — `createTab()` calls `makeLocalSessionId()` and invents an ID before the server knows about it. It then sends a fake `cd` command (`ensureTabBootstrap`) to register it on the server. This causes:
   - Ghost sessions (bootstrap `cd` creates server-side state, but user never types anything)
   - Double `[cd]` messages (bootstrap + any user/system `cd`)
   - 934 session dirs accumulated in `state/sessions/`

2. **`runClose` renames dirs to random IDs** — when closing a session with history, the dir gets renamed to a fresh `makeSessionId()`, so `/restore` shows a random ID the user never saw. This also doubles the session dir count.

3. **Session IDs are opaque hex** — `s-0d1282` is hard to scan. No temporal signal.

## Design: server-owned session lifecycle

### New session ID format: `DD-xxx`

- `DD` = zero-padded days since HAL epoch (stored in `state/epoch.txt`, written once on first run as ISO date)
- `xxx` = 3-char alphanumeric random suffix (`[a-z0-9]`, no uppercase — easy to type)
- Server handles collisions: if `DD-xxx` exists, regenerate suffix (retry up to 10 times, then extend to 4 chars)
- Examples: `00-x5q`, `14-b2m`, `127-a9z` (DD grows beyond 2 digits naturally)

### Server creates all sessions

**New command type: `open`**
- Client sends `{ type: 'open', text: workingDir }` when user presses Ctrl-T
- Server creates the session, adds it to registry, emits `sessions` event
- Client sees the `sessions` event via `syncTabsFromSessions` and creates the tab

**Remove `ensureTabBootstrap`** entirely. No more phantom `cd` on tab open.

**`normalizeCommandSession` stops creating sessions** — if a command arrives for an unknown session, it's an error, not an implicit create.

### Client becomes stateless about session identity

- `createTab()` → sends `open` command, does NOT add a tab locally. Tab appears when server emits `sessions`.
- `closeActiveTab()` → sends `close` command (unchanged). Tab disappears when server emits `sessions`.
- `openSessionTab()` (restore) → sends `open` with session ID to re-add to registry, tab appears via `sessions` event.
- `forkTab()` → sends `fork` (unchanged). New tab appears via `sessions` event.

The client never calls `makeLocalSessionId()` — that function is deleted.

### Stop renaming dirs on close

`runClose` currently renames `state/sessions/s-foo/` to `state/sessions/s-<random>/` "to free the ID". This is confusing and unnecessary:
- Just remove the session from the registry. The dir stays with its original ID.
- `/restore` already scans for dirs not in the registry — it'll find the closed session by its original ID.
- Delete `makeSessionId()` calls from `runClose`.

### Working directory on open

- `open` command carries `text: workingDir` (the cwd the client was launched with)
- Server uses it as the session's initial working directory
- If user wants to change it later, they use `/cd` explicitly

### `cd` command cleanup

- `cd` remains a command for *changing* a session's working directory
- No longer used as a session-creation side channel
- The double-print goes away because there's no bootstrap `cd` anymore

## Files to change

1. **`src/session.ts`**
   - Replace `makeSessionId()` with `makeSessionId(epochDate: Date)` using `DD-xxx` format
   - Add `loadEpoch()` / `ensureEpoch()` to read/write `state/epoch.txt`
   - Remove `sanitizeSessionId` (IDs are always server-generated)

2. **`src/state.ts`**
   - Add `EPOCH_PATH = ${STATE_DIR}/epoch.txt`

3. **`src/protocol.ts`**
   - Add `'open'` to `CommandType`

4. **`src/runtime/process-command.ts`**
   - Add `open` handler: creates session via `ensureSession`, emits status
   - `normalizeCommandSession`: remove implicit session creation for `cd` and default cases. If session doesn't exist, publish error and return null.
   - Keep `cd` handling but remove the `ensureSession` call from it

5. **`src/runtime/handle-command.ts`**
   - `runClose`: stop renaming session dir. Just remove from registry + cache.
   - `runFork`: uses new `makeSessionId()` with epoch

6. **`src/runtime/sessions.ts`**
   - `initialize()`: use new `makeSessionId()` with epoch
   - `ensureSession`: use new ID format
   - Load epoch on startup

7. **`src/cli/client.ts`**
   - `createTab()`: send `open` command instead of local tab creation. Remove `makeLocalSessionId()`.
   - Delete `ensureTabBootstrap()` entirely
   - `openSessionTab()` for restore: send `open` command with existing session ID
   - Remove local session ID generation

8. **`src/cli/commands.ts`**
   - `restore`: send `open` command with session ID + workingDir instead of calling `openSessionTab` directly

## Migration

- Existing `s-*` session dirs remain valid — `loadSessionInfo` still reads them
- New sessions get `DD-xxx` format
- No migration script needed — old dirs just become archival

## Edge cases

- **Race on Ctrl-T spam**: each `open` command has a unique command ID; server creates one session per command; `sessions` events arrive in order. Client ignores duplicates in `syncTabsFromSessions`.
- **Server restart**: registry is persisted. Client re-bootstraps from `readState()`. No phantom sessions.
- **Self-mode** (`applySelfMode`): currently calls `createTab()` — will send `open` command instead. Same flow.
