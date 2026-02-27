# Remaining Tests Batch 1 (2026-02-27)

Scope: Start executing `docs/REMAINING-TESTS.md` by landing the first P0 set with minimal production changes.

## Targets

1. `src/tests/fork.test.ts`
- Add busy-fork paused-child assertions.
- Add sessions-order assertion (child inserted at `parentIndex + 1`).
- Add conversation lineage assertions in both session logs.
- Add partial-snapshot persistence assertion for busy-parent fork.

2. `src/tests/commands.test.ts`
- Add `/topic <text>` persist + readback test.
- Add `/topic` on unset session returns `(none)` test.
- Add `/title` unknown-command-path test.

3. `src/tests/queue.test.ts`
- Add queued-order listing test.
- Add `/drop` drops queued command phases and clears paused state.
- Add prompt-while-paused auto-resume test.

4. Minimal harness/test-mode support
- If needed, expose paused session ids in test-mode status output for stable assertions.

## Validation

- Run `bun run test:quick`.
- Run `bun test`.
- Update checkboxes in `docs/REMAINING-TESTS.md` for completed items.
- Commit with a capitalized message.
