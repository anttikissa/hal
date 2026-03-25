# Plan 7/7: Utils/Perf/Polish

## Overview
Performance improvements, logging, misc utilities, client state persistence.
Budget: ~200 lines added. Target after: ~6,265.

## Subplans

### 7a. Perf improvements (~110 lines)

**Expand:** `src/perf.ts` from 32 → ~80 lines

Port from `prev/src/perf/startup-trace.ts` (181 lines), simplify to what we use:
- Timing waterfall: show elapsed between marks as a visual bar chart
- `perf.trace()` — return formatted startup trace string
- `perf.summary()` — one-line summary: "Started in Xms (Y marks)"
- Configurable: enable/disable via env var `HAL_PERF=1`

**Perf event handling (~30 lines) in runtime or main:**
- Emit perf events via IPC for client display
- Show startup trace on first load (dismissable)

### 7b. Logging (~40 lines)

**File:** `src/utils/log.ts`

Port from `prev/src/utils/log.ts` (61 lines), simplify.

Structured logging to file for debugging:
- `log.info(msg, ...data)`, `log.error(msg, ...data)`, `log.debug(msg, ...data)`
- Output to `state/hal.log`
- Format: `[ISO timestamp] [LEVEL] message {json data}`
- Rotation: truncate when file > 1MB
- Disabled by default, enable via `HAL_LOG=1` or `HAL_LOG=debug`

### 7c. Misc utils (~50 lines)

Small utilities spread across files:

**`src/utils/is-pid-alive.ts` (~10 lines):**
Port from `prev/src/utils/is-pid-alive.ts` (20 lines).
- `isPidAlive(pid: number): boolean` — process.kill(pid, 0) with try/catch
- Used by main.ts for server crash detection (currently inline, extract)

**Read-file caching (~20 lines) in utils:**
- Simple LRU cache for file reads (AGENTS.md, config files)
- Invalidate on mtime change
- Avoids re-reading unchanged files on every agent loop iteration

**Other small helpers (~20 lines):**
- `truncateMiddle(text: string, maxLen: number): string`
- `pluralize(n: number, word: string): string`
- `debounce(fn, ms)` if not already present

### 7d. Client state persistence (~30 lines)

**Expand existing in `src/client.ts`:**

Already partially there (peak, lastTab). Add:
- Persist scroll position per tab
- Persist prompt history across restarts (save to state/prompt-history.txt)
- Save/restore model selection per session

## Dependencies
- All independent of each other
- 7a builds on existing perf.ts
- 7b is standalone
- 7c is standalone
- 7d extends client.ts

## Testing
- `bun test` after each subplan
- `bun cloc` to verify budget — should end around 6,265
