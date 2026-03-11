# Tool modularization plan (start with bash)

Goal: move tool behavior toward `src/tools/*` so execution + formatting can be shared by CLI and a future web client.

Status: bash-first slice is implemented. See `docs/tools.md` for current architecture and streaming/formatting behavior.

## Why

- `src/runtime/tools.ts` currently mixes schemas, execution, and formatting-adjacent previews.
- `src/cli/blocks.ts` contains bash-specific formatting logic.
- For web/CLI parity, tool-specific formatting should live in a frontend-agnostic module.

## Scope for this slice

1. Add `src/tools/bash.ts` with:
	- bash tool schema
	- args preview
	- execution logic (`bun spawn` + streaming chunks)
	- presentation formatting for bash tool blocks (label + wrapped command + output truncation metadata)
2. Wire runtime to use `src/tools/bash.ts` for bash schema/preview/execution.
3. Wire CLI block rendering to use `src/tools/bash.ts` for bash formatting.
4. Add focused tests for `src/tools/bash.ts` formatting behavior.

## Non-goals (for now)

- No full registry rewrite yet.
- No migration of other tools yet (`read`, `write`, `edit`, ...).
- No protocol changes.

## Verification

- Red/green on new bash tool module tests.
- Run full test suite: `./test`.
- Run size snapshot: `bun scripts/cloc.ts`.

## Follow-up after this slice

- Move next tools one-by-one to `src/tools/*`.
- Add a shared tool registry in `src/tools/` once at least 2-3 tools are migrated.
- Move non-bash tool formatting out of CLI into shared tool modules.