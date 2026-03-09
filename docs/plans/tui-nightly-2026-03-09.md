# Plan: TUI polish + completion + test fixes (2026-03-09)

## Scope

Implement requested TUI/input changes in focused commits:

1. Fix broken runtime test.
2. Add slash-command tab completion (commands + known args/models).
3. Rework block rendering:
	- 1-col outer margins on both sides.
	- Brighter thinking/info/status tones.
	- Thinking blocks with header + truncation behavior.
	- Bash header/command formatting guardrails.
	- Tool error status for erroneous tool output.
	- Assistant leading blank-line fix.
4. Rework tab line rendering:
	- New active/inactive style.
	- Session id in status line.
	- Width fallback modes (3 shrink levels).
	- Hard no-overflow/no-newline guardrails.
5. Update `docs/tui.md` for behavior changes.

## Test strategy (red-green)

- Add/adjust unit tests before each behavior change:
	- `src/runtime/runtime.test.ts`
	- `src/cli/completion.test.ts` (new)
	- `src/cli/blocks.test.ts`
	- `src/cli/tabline.test.ts` (new)
	- `src/cli/keybindings.test.ts` (completion integration)
- Run focused tests in loop (`bun test --test-name-pattern='...'`).
- Before each commit: run `./test`.
- After every `src/` edit batch: run `bun scripts/cloc.ts`.

## Notes

- Keep changes minimal and single-path.
- No app restart.
- Any unresolved questions will be written to `docs/questions.md`.