# Remaining Tests Batch 2 (2026-02-27)

Scope: Continue `docs/REMAINING-TESTS.md` with P0 tool safety/concurrency unit tests.

## Targets

1. Create `src/tools.test.ts` covering:
- `write` rejects directory path.
- `read` rejects directory path.
- Input validation before FS operations (`write` path/content checks; `read` path check).
- `edit` strips trailing newline from `new_content`.
- Per-file lock serializes concurrent writes to same file.
- Concurrent write+edit on same file stays serialized and produces valid final content.

2. Keep tests isolated via temp directories/files under OS tmp.

3. Validate:
- `bun test src/tools.test.ts`
- `bun run test:quick`

4. Update checkboxes in `docs/REMAINING-TESTS.md` and commit.
