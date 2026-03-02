# Docs Cleanup Plan

Audit of active docs (not historical plan files) against current codebase state.

## Files to update

### 1. `docs/ipc-bugs.md` — stale filenames + fixed bugs

- **Line 13**: `commands.ason` → `commands.asonl`
- **Line 17**: `events.ason` → `events.asonl`
- **All line references** (e.g. `src/web.ts:5`, `src/cli/client.ts:557`) are stale — code has changed significantly since the audit (2026-02-23). These should be removed or updated.
- **Bug #1** (Web SSE ASON vs JSON): verify if still present
- **Bug #10** (`EventLevel` missing `status`): already fixed — `EventLevel` now includes `'fork' | 'notice' | 'status'`
- Decision: mark bugs as fixed where applicable, remove stale line refs

### 2. `docs/make-lean.md` — stale LOC numbers + file references

- LOC numbers are from an old snapshot (9,950 total). Current: 8,962.
- `tui.ts` listed as 1,767 lines — now 1,203
- References to `codex` model / conversation about OpenAI adapters — this is a paste from a session transcript, not a doc. Consider removing or converting to a clean summary.
- 5 of the 6 `src/cli/tui/format/*.ts` files listed no longer exist (only `status-bar.ts` remains)

### 3. `docs/REMAINING-TESTS.md` — stale file paths in P2

- Section 8 lists 6 formatter files under `src/cli/tui/format/`. Only `status-bar.ts` exists:
  - `src/cli/tui/format/prompt.ts` — GONE
  - `src/cli/tui/format/horizontal-padding.ts` — GONE
  - `src/cli/tui/format/chunk-stability.ts` — GONE
  - `src/cli/tui/format/line-style.ts` — GONE
  - `src/cli/tui/format/line-prefix.ts` — GONE
- All P2 items are marked `[x]` done, so this section could just note the tests exist

### 4. `AGENTS.md` line 12 — stale claim

- "Tabs are real sessions; `/handoff` rotates session history and writes `handoff.md`."
- No code references `handoff.md` anywhere. Remove that claim.

### 5. `docs/ason.md` line 76 — stale API description

- `parseStream(stream)` doc says it accepts `{ recover: true }` option
- Actual signature: `parseStream(stream: ReadableStream<Uint8Array>)` — no options parameter
- The recovery behavior exists (silently catches parse errors on first line) but isn't an option

### 6. `docs/ipc.md` line 75 — stale API reference

- "Event tailing uses `parseStream(..., { recover: true })`" — no such option exists
- Should say: "Event tailing uses `parseStream(...)` which tolerates parse errors on the first line"

### 7. `docs/session.md` — file listing order

- `messages.N.asonl` is listed before `messages.asonl` (line 7 before 9). The current file should come first for clarity.

## Files that are fine

- `docs/tui.md` — comprehensive and current
- `docs/terminal-keys.md` — reference data, still valid
- `docs/ipc.md` — mostly accurate (minor parseStream fix needed)
- `docs/session.md` — mostly accurate after our earlier fix (minor ordering)

## Approach

Fix all the above in one pass. Don't touch plan files (historical).
