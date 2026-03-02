# Plan: Server-owned sessions & new session ID format

## Status: IMPLEMENTATION COMPLETE — needs review + commit

All code changes are done. 429 tests pass. No type errors.

## Summary of changes

### New session ID format: `DD-xxx`

- `DD` = zero-padded days since HAL epoch (`state/epoch.txt`, written once on first run)
- `xxx` = 3-char alphanumeric suffix (`[a-z0-9]`)
- Collision: retry up to 10 times, then extend to 4 chars
- Old `s-*` dirs remain valid — no migration needed

### Server creates all sessions via `open` command

Client sends `{ type: 'open', text: workingDir }` (new tab) or `{ type: 'open', text: workingDir, sessionId: existingId }` (restore). Server creates session, emits `sessions` event. Client sees the tab appear via `syncTabsFromSessions`.

### No more phantom `cd` on tab open

`ensureTabBootstrap` is deleted. Tabs no longer send a bootstrap `cd` command to register themselves.

### No more dir renaming on close

`runClose` just removes the session from the registry. The dir stays with its original ID. `/restore` finds it by scanning dirs not in the registry.

## Files changed

### `src/state.ts`
- Added `EPOCH_PATH = ${STATE_DIR}/epoch.txt`

### `src/protocol.ts`
- Added `'open'` to `CommandType`

### `src/session.ts`
- Replaced `makeSessionId()` (sync, `s-hex`) with async `makeSessionId()` (`DD-xxx` format)
- Added `ensureEpoch()` to read/write `state/epoch.txt`
- Added `generateId(epoch, suffixLen)` helper
- Removed `sanitizeSessionId`
- `createSessionInfo` no longer sanitizes
- `loadSessionRegistry` calls `await makeSessionId()` instead of hardcoding `'s-default'`
- `forkSession` calls `await makeSessionId()`

### `src/runtime/sessions.ts`
- Removed `sanitizeSessionId` export
- `ensureSession` no longer sanitizes — uses ID as-is
- `initialize()` calls `await ensureEpoch()` at startup, `await makeSessionId()` for fallback
- Added `getSessionMeta` to exports (used by `open` handler)

### `src/runtime/process-command.ts`
- Added `open` handler in `processCommand` (bypasses scheduler, like close/fork):
  - With `sessionId`: restores existing session (loads saved topic/model from `info.ason`)
  - Without: creates new session with `await makeSessionId()`
  - Places new session after current active session
- `normalizeCommandSession` no longer creates sessions:
  - `cd` case: errors if session doesn't exist
  - Default case: errors if session doesn't exist
- `resolveSessionId`: removed `sanitizeSessionId` call
- Added imports: `loadSessionInfo`, `existsSync`, `sessionDir`, `getSessionMeta`, `persistRegistry`

### `src/runtime/handle-command.ts`
- `runClose`: removed dir rename logic (was 7 lines: `makeSessionId()` + `rename()`)
- Removed `import { rename }` and `makeSessionId` imports

### `src/cli/client.ts`
- Deleted `makeLocalSessionId()` — client never generates IDs
- Deleted `ensureTabBootstrap()` — no phantom `cd` on tab open
- Removed `bootstrapSent` from all tab handling
- `createTab()`: sends `open` command, sets `pendingOpenSwitch`
- `openSessionTab()`: pre-loads conversation, sends `open` command with sessionId, sets `pendingOpenSwitch` + `pendingOpenData`
- `forkTab()`: unchanged (still sends `fork` command)
- Added module state: `pendingOpenSwitch`, `pendingOpenData`
- `syncTabsFromSessions`:
  - Handles new tabs from `open` (like fork but with optional pre-loaded output)
  - Switches to new tab when `pendingOpenSwitch` is set
  - Removed `bootstrap` option
- `applyActiveTabSnapshot`: removed `ensureTabBootstrap` call
- `bootstrapState`: removed `ensureTabBootstrap` calls
- `applySelfMode`: uses `createTab()` which now sends `open` (no change needed)
- `ensureFallbackTab`: still uses `'s-default'` as temp placeholder — replaced on next `sessions` event

### `src/cli/tab.ts`
- Removed `bootstrapSent` from `CliTab` interface and `createTabState`
- `sessionName`: kept `s-` strip (harmless no-op for new IDs, still correct for old)

### `src/cli/commands.ts`
- `listClosedSessions`: removed `startsWith('s-')` filter — now scans all directories
- `restore` arg parsing: tries exact match first, then `s-` prefix fallback for old sessions

### Tests
- `src/tests/fork.test.ts`: session ID regexes updated from `s-[a-zA-Z0-9_-]+` to `[\w]+-[\w]+`
- `src/cli/tab.test.ts`: `bootstrapSent` removed from expected output
- All 429 tests pass

## Remaining items (not in scope)

- `src/cli/client.ts:238` `ensureFallbackTab` still uses `'s-default'` — harmless placeholder, overwritten on next server sync
- `src/tests/topic-restart-regression.test.ts` hardcodes `s-default` — old format still loads fine
- `src/cli/tab.ts:41` `sessionName` strips `s-` prefix — no-op for new format, still useful for old dirs
