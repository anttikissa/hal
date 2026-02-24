# TUI Refactor Phase 1 (shrink `src/cli/tui.ts`)

## Goal
Make `src/cli/tui.ts` easier to read before adding more features, with no behavior changes.

## Plan
1. Extract pure text/ANSI helpers (wrapping, truncation, key parsing, word-boundary helpers) into a small helper module.
2. Remove dead code in `tui.ts` (unused internal low-level helpers and unused compat exports).
3. Keep public behavior unchanged for active callers (`src/cli/client.ts`).
4. Run `bunx tsc --noEmit` and `bun run test:quick`.

## Next (before input-box selection feature)
1. Split input editing/key handling into its own module/state machine.
2. Reuse the selection model per-surface (`output`, `status`, later `input`) and explicitly forbid cross-surface selections.
3. Then add GUI-like input selection/editing (replace-on-type, delete selection, word/line selection keybindings, clipboard shortcuts where terminal allows).
