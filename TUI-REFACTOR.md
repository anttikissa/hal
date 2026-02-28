# TUI Refactor Plan (No Functionality Cuts)

This file tracks the TUI refactor so work can continue even after context resets.

## Ground Rules

- Goal: reduce TUI code from ~3000 LOC to ~2000 LOC.
- No feature cuts. Keep behavior and UX parity.
- One small commit at a time.
- Add/update tests for each refactor slice.
- Run relevant tests per slice, then full `bun test` before commit.
- Keep docs in sync when behavior changes (for pure refactor, behavior should not change).

## Baseline (2026-02-28)

Non-test TUI-related code (current): **3274 LOC**
Target: **~2000 LOC** (cut ~1000 lines through deduplication, dead code removal, and consolidation).
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

### [X] Part 2A+2B+2C DONE — Compress handleKey with action helpers

Status: complete (combined 2A-2C into one step since all three reduced LOC together)

Commit:
- `7bfb2ff` — **Refactor: compress handleKey with action helpers (3274 → 3059 LOC)**

What changed:
- Added 3 key action helpers: `moveCursor`, `moveOrCollapse`, `deleteOrSel`
- Compressed ~430-line handleKey to ~210 lines using one-liner key bindings
- Combined Arrow Up/Down handlers, Shift+Up/Down handlers
- No behavior change — all key precedence preserved

Tests:
- `bun test src/cli/tui-keyboard.test.ts` — 72 pass
- `bun test src/cli/tui-input-layout.test.ts` — 9 pass
- `bun test` — 433 pass, 0 fail

---

### [X] Part 3 DONE — Consolidate input/clipboard/mouse helpers in `tui.ts`

Status: complete (consolidated in-place rather than extracting to separate module — actual LOC reduction)

Commit:
- `3672a9f` — **Refactor: consolidate mouse/clipboard/undo/paste in tui.ts (3059 → 2915 LOC)**

What changed:
- Removed dead `copySelectionToClipboard` function
- Inlined `currentInputUndoSnapshot` and `restoreInputUndoSnapshot` (each used once)
- Extracted `updateInputSelFocus` to deduplicate 4 identical word/line selection patterns in mouse handler
- Extracted `cleanAndInsertPaste` to deduplicate paste cleaning in clipboard + bracketed paste
- Compressed `getSelectionRange` (3 return paths → 1 with swap)
- Compressed `handleInputClipboardShortcutKey`
- Compressed `handleMouseEvent` input click handler

Tests:
- `bun test src/cli/tui-keyboard.test.ts` — 72 pass
- `bun test` — 433 pass, 0 fail

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

- [ ] run `bun run cloc` and verify TUI code is ≤ 2000 LOC
- [ ] run full `bun test`
- [ ] update this file with final numbers and commit list

## Commit Protocol (every slice)

1. Make one narrow refactor slice.
2. Run targeted tests for that slice.
3. Run `bun test`.
4. Run `bun run cloc` and record non-test LOC. It must be ≤ previous checkpoint (tests may grow).
5. Commit only touched files for that slice.
	- Commit message must include LOC change, e.g.: `Refactor: extract key actions (3274 → 3180 LOC)`
6. Update this file:
	- mark checkbox(es)
	- add commit hash + LOC number under relevant part.

## LOC Checkpoint Log

| Commit | Part | LOC (non-test) | Δ |
|--------|------|-----------------|---|
| `a873943` | 1 | 3274 | baseline |
| `7bfb2ff` | 2A+2B+2C | 3059 | −215 |
| `3672a9f` | 3 | 2915 | −144 |

## Current Next Step

Next planned commit: **Part 4+** (continue compressing tui.ts, client.ts, tui-text.ts, tui-links.ts).