# Startup regression recovery (2026-03-13)

## Problem

Recent startup changes regressed host startup (`runtime` phase very high) and made the active tab sluggish for the first seconds after launch.

## Goals

1. Restore fast host startup.
2. Keep active tab responsive immediately after first usable frame.
3. Keep one server-side hydration path for replay + input history (no client fallback logic).
4. Reduce code, not add more startup mechanisms.

## Plan

1. Remove startup `ipc.events.trim(...)` from the critical path in `runtime/startup.ts`.
2. Simplify hydration transport:
	- Require `hydrateSession` in `Transport`.
	- Remove `replaySession` path.
	- Remove client-side fallback hydration logic.
	- Remove unused `history.loadInputHistory` API.
3. Make startup event tailing begin right after active-tab hydration/render, then hydrate non-active tabs in background (best effort, not blocking active live updates).
4. Reduce startup render churn from background history hydration:
	- Do not trigger `onUpdate()` per older-history chunk; only update at start/end.
5. Add/adjust tests for:
	- Active tab receives live events even when non-active tab hydration is blocked.
	- Transport/client hydration uses a single server hydration payload path.
6. Run full tests and cloc, then commit.
