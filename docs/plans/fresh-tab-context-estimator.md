# Fresh-tab context estimator + calibration split

## Goal

Show context usage in the status line immediately for new/fresh tabs (before first user prompt), and keep autocompact based only on real API token counts.

## Problems observed

1. New tabs can miss context in the separator (`host · <id>` with no `%/max`).
2. Fresh sessions start at `0.0%` even though system prompt + tools already consume context.
3. Calibration logic lives inside `context.ts`; old architecture had a dedicated token-calibration module.

## Plan

1. **Bring back dedicated calibration module**
	- Add `src/runtime/token-calibration.ts`.
	- Move bytes→tokens calibration storage/lookup there (`state/calibration.ason`).
	- Keep `context.ts` as context math + message sizing.

2. **Estimate baseline context for fresh tabs**
	- Include bytes from:
		- preprocessed system prompt (`loadSystemPrompt(...).bytes`)
		- tool schema payload (`TOOLS` JSON bytes)
		- current message history (usually empty for fresh tab)
	- Use calibration ratio for model-specific estimate.

3. **Fix client new-tab context loss**
	- In `Client.syncTabs()`, when creating a new tab from `sessions` event, carry `info.context` into `tab.context`.

4. **Tests (red-green)**
	- Runtime test: fresh session has non-zero estimated context.
	- Client test: new tab created via `sessions` event keeps provided context.

5. **Validation**
	- Run `./test`.
	- Run `bun scripts/cloc.ts`.
