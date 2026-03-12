# Structured session events for model timeline (2026-03-12)

## Goal
Store model transitions as structured history entries and stop relying on `[model] ...` text parsing.

## Constraints
- Keep backwards-compat/migration logic minimal (old sessions may break).
- Preserve current UI info lines.
- Keep changes focused.

## Plan
1. Add `type: 'session'` history entry shape for model events (`model-set`, `model-change`).
2. Add `history.ensureModelEvent(sessionId, model)`:
	- append `model-set` if no model event exists
	- append `model-change` when model differs from last known model.
3. Call `ensureModelEvent` before `loadApiMessages` in prompt/continue and startup handoff-continue paths.
4. Update `loadApiMessages` to track model timeline from structured session events and annotate thinking blocks with `_model` when known.
5. Update prune model-change detection to use structured events only (no `[model]` parsing).
6. Update provider foreign-thinking text prefix to include source model when available (`[model <id> thinking]`).
7. Add/adjust tests:
	- structured model-change prune detection
	- thinking block model attribution from timeline
	- provider conversion prefix includes model.
8. Run targeted tests, full `./test`, `bun scripts/cloc.ts`, commit.
