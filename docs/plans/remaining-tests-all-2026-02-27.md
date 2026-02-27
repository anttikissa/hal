# Remaining Tests Completion Plan (2026-02-27)

Goal: implement all unchecked items in `docs/REMAINING-TESTS.md` and get tests green.

## Implementation order

1. Finish P0 tools unit tests (already started in `src/tools.test.ts`) and verify.
2. Add P1 config unit tests (`src/config.test.ts`).
3. Add P1 OpenAI parser unit tests (`src/providers/openai.test.ts`).
4. Add P1 restore/replay e2e tests (`src/tests/restore.test.ts`) with minimal harness extension for restart-in-place.
5. Add P2 formatter tests (`src/cli/tui-format.test.ts`, `src/cli/format/index.test.ts`).
6. Add P2 input layout tests (`src/cli/tui-input-layout.test.ts`).
7. Convert keyboard todos to concrete tests in `src/cli/tui-keyboard.test.ts`.
8. Stabilize full test execution (including e2e concurrency/environment issues), then run:
   - `bun run test:quick`
   - `bun test`
9. Update checklist in `docs/REMAINING-TESTS.md` and commit.
