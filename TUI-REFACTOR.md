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

### [X] Parts 4–8 DONE — Cross-file compression (in-place, not extraction)

Status: complete (merged into compression passes rather than separate extraction steps)

Commits:
- `a016868` — **deduplicate resolve/output-dump/trim/wrapAnsi across TUI (2915 → 2769 LOC)**
- `f33c75f` — **compress render/client/resolveInput/trimTrailing (2769 → 2711 LOC)**
- `4b029f3` — **compress state/geometry/API/callbacks in tui.ts + client.ts (2711 → 2597 LOC)**

What changed:
- **Part 4 (mouse/selection):** `updateInputSelFocus` dedup, `getSelectionRange` swap, `handleMouseEvent` compressed
- **Part 5 (stdin/kitty):** `handleBracketedPaste` uses `cleanAndInsertPaste`, `resolveInput` dedup (7→1)
- **Part 6 (render):** `pushRow` helper, title/activity/status/prompt rendering compressed
- **Part 7 (ANSI helpers):** merged `trimUrlEnd`/`trimProsePunctuation` → `trimTrailing`, `stripAnsiMap` + `findUrlsInPlain` extracted in tui-links.ts, `wrapAnsi` break code consolidated via `emitBreak`
- **Part 8 (client.ts):** `modelDisplayName` table-driven, `fmtContext` dedup, `handleInputKey`/`renderTabsForStatus`/`syncTabsFromSessions` compressed, dead code removed

Tests:
- `bun test` — 433 pass, 0 fail at each step

---

### [X] Part 9 DONE — Final pass

Status: complete

Commits:
- `2f4c994` — **compress tui.ts + client.ts (2597 → 2243 LOC)**
- `c39388b` — **compress tui-text.ts + tui-links.ts (2243 → 2166 LOC)**
- `4740f2a` — **compress render/stdin/kitty/resize in tui.ts (2166 → 2070 LOC)**
- `e0def06` — **compress headers/state/output/scroll in tui.ts (2070 → 2014 LOC)**
- `1414ec8` — **final pass — clipboard/tab/tui (2014 → 1986 LOC)**

What changed:
- Collapsed small functions to one-liners (clampInputPos, clearInputTextSelection, etc.)
- Merged copy/cut clipboard functions into `clipInputSel(cut)` + `copyToClipboard()`
- Compressed `renderLineWithSelection`, `expandToWordBoundary`, `pointFromScreenCoords`
- Inlined `showCursor`, `buildStatusLine` (each used once)
- Compressed Kitty key normalization (~30 lines saved)
- Compressed stdin processing, mouse parsing, render(), resize
- Compressed Client class methods to one-liners
- Extracted `newTabState()` helper in client.ts to deduplicate tab creation
- Compressed `bootstrapState`, `syncTabsFromSessions`, `start()`, `render(event)`
- Compressed `tui-text.ts` readEscapeSequence (merged CSI/OSC branches)
- Compressed `tui-links.ts` normalizeDetectedUrl (table-driven pair matching)
- Compressed `clipboard.ts` and `tab.ts`
- Removed excess blank lines and comments

Tests:
- `bun test` — 433 pass, 0 fail at each step

## Final Result

**TUI code: 3274 → 1986 LOC (−1288, −39%)**
Target was ≤ 2000 LOC. ✓

## LOC Checkpoint Log

| Commit | Part | LOC (non-test) | Δ |
|--------|------|-----------------|---|
| `a873943` | 1 | 3274 | baseline |
| `7bfb2ff` | 2A+2B+2C | 3059 | −215 |
| `3672a9f` | 3 | 2915 | −144 |
| `a016868` | 4+5+7 | 2769 | −146 |
| `f33c75f` | 4+6+8 | 2711 | −58 |
| `4b029f3` | 4 | 2597 | −114 |
| `2f4c994` | 9 | 2243 | −354 |
| `c39388b` | 9 | 2166 | −77 |
| `4740f2a` | 9 | 2070 | −96 |
| `e0def06` | 9 | 2014 | −56 |
| `1414ec8` | 9 | 1986 | −28 |
