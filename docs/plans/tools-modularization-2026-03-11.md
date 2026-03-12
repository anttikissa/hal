# Tool modularization plan (bash + file tools)

Goal: move tool behavior toward `src/tools/*` so execution + formatting can be shared by CLI and a future web client.

Status:
- bash-first slice is implemented.
- file-tools slice (`read`, `write`, `edit`) is implemented.
- `read_blob` slice is implemented.
- `grep` slice is implemented.
- architecture summary lives in `docs/tools.md`.

## Why

- `src/runtime/tools.ts` should be a thin registry/dispatcher, not a giant implementation file.
- `read`/`write`/`edit` share path + hashline + locking behavior that belongs in one place.
- The file tools are heavily used, so extracting them gives a strong template for remaining migrations.

## Implemented in file-tools slice

1. Added `src/tools/read.ts`, `src/tools/write.ts`, and `src/tools/edit.ts`.
2. Added `src/tools/file-utils.ts` for shared:
	- path resolution
	- hashline formatting/ref validation
	- per-path async lock
3. Wired `src/runtime/tools.ts` to use module definitions + args preview + execute.
4. Kept tool protocol unchanged (same names/schemas/output strings).
5. Added focused tests in `src/tools/file-tools.test.ts`.

## Remaining follow-up

- Migrate `glob` and `ls`.
- Migrate `ask` and `eval` last.
- Add a shared registry in `src/tools/` once enough tools are migrated.
