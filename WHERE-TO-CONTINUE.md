# Where to continue

## Status

UI work batch is implemented in separate commits (one fix per commit), plus follow-up syntax/test fixes.

## Completed commits (in order)

1. `b51d15b` — Name TUI regions and document UI work plan
	- Renamed screen parts in `src/cli/tui.ts` comments and `docs/tui.md`
	- Added plan doc: `docs/plans/ui-work-2026-02-26.md`

2. `6bb9923` — Style title bar and include session name context
	- Title bar now has visible background
	- Title includes session context when available

3. `34a8e7f` — Show model names prominently in activity bar
	- Activity bar shows short model labels (e.g. `Opus 4.6`, `Codex 5.3`)
	- Idle/busy/paused activity text includes model label

4. `3133b24` — Redesign tab bar and simplify status line layout
	- Tab style changed toward `[1 .hal] 2 x 3 y.1`
	- Directory-based labels with `.1/.2` disambiguation
	- Active tab bright, inactive tabs grey
	- Removed ruler-style status line
	- Added tab activity marker support
	- Added `src/cli/tui/format/status-bar.ts`

5. `703fdb7` — Apply prompt echo styling to every line
	- Prompt echo style now applies to every line (not just bars)
	- Added `src/cli/tui/format/prompt.ts`

6. `b1932df` — Keep tool and queue prefixes consistently styled
	- Fixed inconsistent brightness on line prefixes for tool/queue/tab-like lines
	- Added `src/cli/tui/format/line-prefix.ts`

7. `ff9e104` — Stabilize chunk transitions to prevent bright word seams
	- Fixed chunk-boundary style seam causing brighter first words / odd cut points
	- Added `src/cli/tui/format/chunk-stability.ts`

8. `d46c2cc` — Fix syntax errors in tab sync and title rendering
	- Follow-up compile fix after refactor

9. `8058dc5` — Apply chunk style across wrapped lines consistently
	- Ensures chunk style applies consistently across wrapped lines
	- Added `src/cli/tui/format/line-style.ts`

## Validation

- Repeated `bun run test:quick` during changes
- Final full suite passed: `bun test`
	- `303 pass`
	- `0 fail`
	- `2 todo`

## File organization changes

Formatting logic was moved into `src/cli/tui/format/` helpers to reduce `tui.ts` bloat:

- `status-bar.ts`
- `prompt.ts`
- `line-prefix.ts`
- `chunk-stability.ts`
- `line-style.ts`

## Working tree note

User-local files left untouched:

- `TODO.md` (modified)
- `img.png` (untracked)

## Suggested next review steps

1. Run the TUI and visually verify spacing/colors for tabs and activity marker.
2. Tune glyph/spacing if desired (`*` vs `•`, extra spaces).
3. Adjust theme values in `themes/hal.ason` after live look.
