# Startup Performance Plan

Baseline: **320ms owner, 240ms client**. Bun floor: **12ms**.

## Fix 1: Defer debug log state snapshot (~20-40ms)

**File:** `src/debug-log.ts` → `initDebugLog()`

**Problem:** When `recordEverything` is enabled, `initDebugLog` walks the
entire `state/` directory, reads every file, and flushes before returning.
This blocks startup for both owner and client.

**Fix:** Don't `await` the walk+snapshot. Fire it off and let it complete
in the background. The debug log is append-only so ordering doesn't matter
as long as the snapshot eventually lands before the first keypress log.

**Risk:** Low. Debug log entries have timestamps, so order is recoverable.

---

## Fix 2: Parallelize owner `initialize()` I/O (~20-30ms)

**File:** `src/runtime/sessions.ts` → `initialize()`

**Problem:** Three independent reads happen sequentially:
1. `loadSessionRegistry()` — reads `index.ason`
2. `getOrLoadSessionRuntime()` — reads `session.ason` (+ maybe handoff)
3. `getCalibration()` — reads calibration file

Then `reloadSystemPromptForSession()` reads `SYSTEM.md` + `AGENTS.md`.

Steps 1 and 3 are independent. Step 2 depends on 1 (needs session ID).
The system prompt load depends on 2 (needs runtime ref).

**Fix:** Run `loadSessionRegistry()` and `getCalibration()` in parallel.
Then run `getOrLoadSessionRuntime()` + `reloadSystemPromptForSession()`
(these depend on registry result, but calibration is already resolved).

**Risk:** Low. Pure reads, no shared mutable state between them.

---

## Fix 3: Batch event publishing in `initialize()` (~10-15ms)

**File:** `src/runtime/sessions.ts` → `initialize()`

**Problem:** 4-5 sequential `publishLine()` calls, each doing a separate
`appendFile()` to the events file. Each has filesystem overhead.

**Fix:** Collect all startup lines, then write once. Could add a
`publishLines(lines[])` helper to `event-publisher.ts`, or just build the
string and do one `appendFile`.

**Risk:** Low. Events are append-only.

---

## Fix 4: Parallelize client `bootstrapState()` (~10-15ms)

**File:** `src/cli/client.ts` → `bootstrapState()`

**Problem:** `readState()` and `readRecentEvents(500)` are independent
reads but run sequentially. Then `loadInputHistory()` per tab runs in
parallel (already uses `Promise.all`) — that's fine.

**Fix:** `Promise.all([readState(), readRecentEvents(500)])`.

**Risk:** Low. Pure reads from different files.

---

## Expected result

| Fix | Owner saved | Client saved |
|-----|-------------|--------------|
| 1   | 20-40ms     | 20-40ms      |
| 2   | 20-30ms     | —            |
| 3   | 10-15ms     | —            |
| 4   | —           | 10-15ms      |
| **Total** | **~50-85ms** | **~30-55ms** |

Target: **~240ms owner, ~190ms client** (conservative estimate).
