# TUI Refactor Plan (No Functionality Cuts)

This file tracks the TUI refactor so work can continue even after context resets.

## Ground Rules

- Refactor only. No feature cuts.
- Keep behavior and UX parity.
- One small commit at a time.
- Add/update tests for each refactor slice.
- Run relevant tests per slice, then full `bun test` before commit.
- Keep docs in sync when behavior changes (for pure refactor, behavior should not change).

## Baseline (2026-02-28)

Non-test TUI-related code (current): **3274 LOC**

- `src/cli/tui.ts`: 1767
- `src/cli/client.ts`: 730
- `src/cli/tab.ts`: 79
- `src/cli/tui-links.ts`: 211
- `src/cli/tui-text.ts`: 200
- `src/cli/tui-input-layout.ts`: 68
- `src/cli/tui/format/status-bar.ts`: 54
- `src/cli/clipboard.ts`: 50
- `src/cli/keys.ts`: 36
- `src/cli/tui/format/*` small helpers: 79

## Progress Tracker

### [X] Part 1 DONE — Extract tab helpers from `client.ts`

Status: complete

Commit:
- `a873943` — **Extract tab state helpers from client**

What moved:
- `CliTab` type + tab helper functions to new `src/cli/tab.ts`
- `createTabState(...)` introduced and wired into `client.ts`

Tests:
- Added `src/cli/tab.test.ts`
- Ran targeted tests + full suite (`bun test`) and passed

---

### [ ] Part 2 — Make key handling in `tui.ts` table-driven (no behavior change)

Goal: shrink and simplify the giant `handleKey()` branch chain while preserving exact key precedence.

Planned steps:

- [ ] **2A: Extract small action helpers**
	- Move repeated edit actions into named local functions (delete left/right, move cursor, selection collapse, etc.)
	- Keep them in `tui.ts` first (mechanical refactor)
	- Add focused tests if needed

- [ ] **2B: Introduce declarative key bindings for exact-match keys**
	- Build ordered binding table for exact sequences (`'\x1b[D'`, `'\x1b[1;2D'`, etc.)
	- Keep fallback logic untouched
	- Verify behavior with `src/cli/tui-keyboard.test.ts`

- [ ] **2C: Introduce small predicate bindings for grouped cases**
	- Handle grouped forms (e.g. Home variants, End variants) via explicit predicate list
	- Preserve original ordering and early returns

Commit strategy:
- 2A, 2B, 2C as separate commits if diff is large

Tests per commit:
- `bun test src/cli/tui-keyboard.test.ts`
- `bun test src/cli/tui-input-layout.test.ts`
- then `bun test`

---

### [ ] Part 3 — Extract input editor state/helpers from `tui.ts`

Goal: move input buffer editing/selection/undo mechanics to a dedicated module.

Planned steps:

- [ ] **3A: Extract input state type + pure helpers**
	- Selection range, clamp, replace range, undo snapshots
	- No IO, no terminal writes

- [ ] **3B: Wire `tui.ts` to use extracted helpers**
	- Keep exact side effects (render timing, history semantics)

- [ ] **3C: Add/expand tests for edge cases**
	- Selection replace-on-type
	- Undo behavior
	- word/line boundaries

Tests per commit:
- `bun test src/cli/tui-input-layout.test.ts`
- `bun test src/cli/tui-keyboard.test.ts`
- then `bun test`

---

### [ ] Part 4 — Extract mouse/screen-selection engine

Goal: isolate screen selection and click mode handling (char/word/line) from core render logic.

Planned steps:

- [ ] **4A: Extract selection state/types + pure transforms**
- [ ] **4B: Keep `tui.ts` as orchestrator only for event wiring + render calls**
- [ ] **4C: Keep link-open and Cmd-hover behavior unchanged**

Tests per commit:
- `bun test src/cli/tui-text.test.ts`
- `bun test src/cli/tui-keyboard.test.ts`
- then `bun test`

---

### [ ] Part 5 — Extract stdin pipeline + terminal protocol normalization

Goal: split raw input pipeline into modules with clean boundaries:
- tokenization/parsing
- kitty/xterm normalization
- routing to handlers

Planned steps:

- [ ] **5A: Move kitty key normalization helpers out of `tui.ts`**
- [ ] **5B: Move stdin chunk pipeline (paste, mouse, coalescing) out of `tui.ts`**
- [ ] **5C: keep `onStdinData` orchestration minimal**

Tests per commit:
- `bun test src/cli/tui-keyboard.test.ts`
- `bun test src/cli/tui-text.test.ts`
- then `bun test`

---

### [ ] Part 6 — Render pipeline decomposition

Goal: keep one full-frame render write, but split row builders into focused helpers.

Planned steps:

- [ ] **6A: Extract title/activity/status row renderers**
- [ ] **6B: Extract output viewport rendering helper**
- [ ] **6C: Extract prompt area rendering helper**
- [ ] **6D: Preserve synchronized output wrapper behavior exactly**

Tests per commit:
- `bun test src/cli/tui-format.test.ts`
- `bun test src/cli/tui-keyboard.test.ts`
- then `bun test`

---

### [ ] Part 7 — Consolidate ANSI scanning helpers

Goal: remove duplicate ANSI walk logic between `tui-text.ts` and `tui-links.ts` where safe.

Planned steps:

- [ ] **7A: Introduce shared low-level scan utility (minimal API)**
- [ ] **7B: migrate one caller at a time**
- [ ] **7C: ensure OSC-8 edge cases remain green**

Tests per commit:
- `bun test src/cli/tui-text.test.ts`
- then `bun test`

---

### [ ] Part 8 — `client.ts` decomposition (tabs/session sync)

Goal: split heavy tab/session sync logic from `client.ts` into focused module(s).

Planned steps:

- [ ] **8A: Extract tab sync/reconcile helpers**
- [ ] **8B: Extract replay/bootstrap helpers**
- [ ] **8C: Keep command wiring in `client.ts`**

Tests per commit:
- `bun test src/tests/restore.test.ts src/tests/fork.test.ts src/tests/startup.test.ts`
- then `bun test`

---

### [ ] Part 9 — Final pass

- [ ] run `bun run cloc` and compare before/after
- [ ] run full `bun test`
- [ ] update this file with final numbers and commit list

## Commit Protocol (every slice)

1. Make one narrow refactor slice.
2. Run targeted tests for that slice.
3. Run `bun test`.
4. Commit only touched files for that slice.
5. Update this file:
	- mark checkbox(es)
	- add commit hash under relevant part.

## Current Next Step

Next planned commit: **Part 2A** (extract repeated key action helpers inside `tui.ts`, still no behavior change).
