# Session history rename + layout cleanup plan

Goal: finish the naming cleanup after the blob refactor.

## Constraints

- Keep changes focused.
- No migration/back-compat code unless explicitly asked.
- Update tests and docs in the same change.

## Scope

1. Rename session log naming from `messages` to `history`.
2. Rename per-session metadata file from `session.ason` to `session.ason`.
3. Rename `src/session/history.ts` to `src/session/history.ts` and move fork helpers into `src/session/history-fork.ts`.
4. Update imports/usages across runtime, CLI, and tests.
5. Move top-level CLI entry from `src/cli/cli.ts` to `src/cli/cli.ts` and update entry import.
6. Update user-facing docs and comments to the new names.

## Implementation slices

### Slice 1: storage names

- `history.asonl` -> `history.asonl`
- `messages2.asonl` -> `history2.asonl` (same rotation scheme, new base name)
- `session.ason` -> `session.ason`
- Update defaults and rotation regex in `src/session/session.ts`

### Slice 2: session module rename

- Move `src/session/history.ts` -> `src/session/history.ts`
- Keep API shape mostly the same, but export namespace as `history`
- Extract fork-chain helpers to `src/session/history-fork.ts`

### Slice 3: callsites + tests

- Update all imports from `session/messages.ts` to `session/history.ts`
- Update references from `messages.*` namespace to `history.*`
- Update file-path assertions in tests (`history.asonl`, `session.ason`)

### Slice 4: CLI entry layout

- Move `src/cli/cli.ts` -> `src/cli/cli.ts`
- Update `src/main.ts` dynamic import
- Update path-based tests that spawn the CLI entry file

### Slice 5: docs + follow-up notes

- Update docs/session.md + key comments with new paths
- Add `docs/session-questions.md` for deferred questions (per user request)

## Verification

- Targeted red/green loop on session/runtime tests first
- Full suite: `./test`
- Type check: `bunx tsgo --noEmit`
- Size snapshot: `bun scripts/cloc.ts`
