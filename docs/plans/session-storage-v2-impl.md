# Session Storage v2 — Implementation Plan

## Decisions (resolved)

1. **Signatures**: Stored in `.ason` block files alongside thinking text
2. **Deletion**: Never delete anything. Rotation on `/reset` too (without context injection)
3. **Timestamps**: ISO in `session.asonl`, short display in TUI behind `timestamps: true` config
4. **Append-only**: `session.asonl` is always append-only. Track `persistedCount` in runtime
5. **Hardlinks**: Skip. Simple `cp -r` for blocks on fork
6. **TUI**: Timestamps only (config-gated). Collapsed thinking = later

## Rotation naming

- `session.asonl` — always current
- `session.1.asonl` — first archive
- `session.2.asonl` — second archive (more recent than .1)
- Higher N = more recent archive. Scan for max N, use N+1
- Blocks shared across all rotations in same `blocks/` dir

## Implementation order

### 1. Block infrastructure (`src/session.ts`)
- `blocksDir(id)` path helper
- `makeBlockRef(sessionId)` — generates `<ms-offset>-<random>` ref
- `writeThinkingBlock(sessionId, ref, thinking, signature)` — writes `.ason`
- `writeToolBlock(sessionId, ref, call, result)` — writes `.ason`
- `readBlock(sessionId, ref)` — reads `.ason`, returns parsed content

### 2. Lean message format (`src/session.ts`)
- `toLeanMessage(msg, sessionId)` — converts API message → lean format, writes blocks, returns lean line
- `fromLeanMessage(lean, sessionId)` — resolves refs, returns API message

### 3. Append-only save (`src/session.ts`)
- Add `persistedCount` to `SessionRuntimeCache`
- New `saveSession()`: append only messages from `persistedCount` onward
- Each new message → `toLeanMessage()` → append line to `session.asonl`

### 4. Load with ref resolution (`src/session.ts`)
- `loadSession()` reads `session.asonl`, calls `fromLeanMessage()` on each line

### 5. Rotation (`src/session.ts` + `src/runtime/handle-command.ts`)
- `rotateSession(sessionId)` — rename `session.asonl` → `session.N.asonl`
- `buildRotationContext(sessionId, messages)` — deterministic user-prompt list
- Replace `runHandoff()` with rotation logic
- `/reset` also rotates (without context injection)

### 6. Fork update (`src/session.ts`)
- Copy `blocks/` directory in `forkSession()`

### 7. Cleanup
- Delete: `performHandoff()`, `loadHandoff()`, `handoffPath()`, `sessionPreviousPath()`
- Delete: `formatMessagesForHandoff()`, `windowConversationText()`, handoff constants
- Delete: `handoff-format.test.ts`, update `handoff.test.ts`
- Remove `loadHandoff` from `sessions.ts`

### 8. Config + timestamps
- Add `timestamps?: boolean` to Config
- Display timestamps in TUI when enabled

### 9. Tests
- Block read/write
- Lean message round-trip
- Append-only save + load
- Rotation naming
- Fork with blocks

### 10. Docs
- Update `docs/session.md`
