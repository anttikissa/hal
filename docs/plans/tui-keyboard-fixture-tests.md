# TUI Keyboard Fixture Tests (Ghostty Baseline)

## Goal
Add unit tests for TUI keyboard tokenization and Kitty/Ghostty key normalization, using the captured Ghostty fixture as the baseline.

## Plan
1. Add a small test-only export from `src/cli/tui.ts` for Kitty key parsing/normalization helpers (minimal surface).
2. Add unit tests that load `src/tests/fixtures/keys/keys-ghostty.ason` and verify `parseKeys(...)` tokenization matches recorded tokens.
3. Add normalization tests (direct + fixture-driven) for recent Kitty/Ghostty fixes: compact `CSI u`, release suppression, functional key normalization, Ctrl/Alt/Super handling, Shift-Enter/Tab.
4. Add TODOs for Cmd key semantic cases where Ghostty provides no actual key token (for example `Cmd-Z`, empty `Cmd-V`), to fill later with more terminal fixtures.
5. Run tests and commit only the new tests/plan plus minimal helper exports.
