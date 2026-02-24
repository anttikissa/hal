# TUI Refactor Phase 1 (shrink `src/cli/tui.ts`)

## Goal
Make `src/cli/tui.ts` easier to read before adding more features, with no behavior changes.

## Plan
1. Extract pure text/ANSI helpers (wrapping, truncation, key parsing, word-boundary helpers) into a small helper module.
2. Remove dead code in `tui.ts` (unused internal low-level helpers and unused compat exports).
3. Keep public behavior unchanged for active callers (`src/cli/client.ts`).
4. Run `bunx tsc --noEmit` and `bun run test:quick`.
