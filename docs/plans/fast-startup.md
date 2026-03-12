# Fast startup optimization log + plan (2026-03-12)

## Goal

Make restart feel instant for the user, with the metric:

`press Enter after 'hal'` → `current tab is visible and input is usable`.

Current startup perf line format:

`[perf] startup: ready <readyMs>ms (runtime <r>ms + cli <c>ms) · tab <tabMs>ms (hydrate <h>ms + render <rr>ms) (target <100ms tab)`

- `ready`: process + owner/runtime + first CLI frame
- `tab`: active tab replayed and rendered
- `hydrate`: history/draft replay work before that render
- `render`: first active-tab paint cost

---

## What we have optimized so far (chronological)

### 1) Added startup epoch measurement from launcher (`run`) and exposed it to runtime/client

Commits: `e3c7708`, follow-ups in later commits.

- `run` now sets `HAL_STARTUP_EPOCH_MS` right before launching `bun src/main.ts`.
- `src/main.ts` parses that env var and stores it in shared `globalThis.__hal`.
- This made startup timing include real process launch overhead, not only client bootstrap.

Why:
- Needed a common timestamp that survives host/client role differences.

---

### 2) Measured "ready" at first usable frame (not at arbitrary bootstrap point)

Commit: `a2a0b7a` (+ later shape updates).

- `src/cli/cli.ts` now calls `markStartupReady()` right after first `doRender()`.
- This timestamp corresponds to: screen visible + prompt/input loop active.

Why:
- Matches user-visible readiness better than "client object started".

---

### 3) Made startup perf line print when a tab is actually available

Commit: `a2a0b7a`.

- Startup perf is kept as pending state in `Client`.
- It is appended only when an active tab exists.
- Handles startup race where sessions/tabs are not available yet.

Why:
- Fixed missing perf line when startup had no immediate tab object.

---

### 4) Split startup into `ready` and `tab`, and prioritized active-tab hydration

Commit: `fb25f38`.

- Startup line changed to include:
	- `ready ...`
	- `tab ...`
	- `(hydrate ... + render ...)`
- Client hydrates active tab first and renders it before hydrating other tabs.
- Warning threshold moved to tab restore target (`<100ms tab`) because that is user-perceived latency.

Why:
- "Process up" was not enough; user cares when current tab is back.

---

### 5) Added `ready` split into host runtime and CLI

Commit: `7422e55`.

- `src/main.ts` records `startupHostRuntimeElapsedMs` immediately after `startup.startRuntime()` returns.
- Client derives and prints:
	- `runtime`: launcher epoch → runtime ready
	- `cli`: runtime ready → first CLI-ready frame

Why:
- Isolated expensive host startup from lightweight CLI startup.

---

### 6) Safe #3: unified hydration data on server side (single local history read path)

Commit: `7422e55`.

- Added `history.loadHydrationData(sessionId)`:
	- reads local session history once
	- returns:
		- `replayMessages` (fork-aware)
		- `inputHistory` (local session only)
- Added `Transport.hydrateSession()` and implemented in `LocalTransport`.
- `Client.hydrateTab()` now uses transport hydration data + draft load.

Why:
- Removed duplicate client/server history-loading logic for hydration path.
- Preserved semantics (important): input history remains local-session scoped.

Notes:
- This addressed suspected missing-history bugs from split logic.

---

### 7) Parallelized tool blob work in replay (global prefetch)

Commit: `6c7ebd0`.

- `replayToBlocks()` now:
	1. scans assistant tool references across replay messages
	2. prefetches all needed blob IDs with concurrency (`replayConfig.blobReadConcurrency`, default 16)
	3. builds tool blocks from prefetched map
- This replaced more serialized per-message blob waiting behavior.

Why:
- Hydrate hotspots were mostly tool blob reads in tool-heavy tabs.

---

### 8) Removed startup-wide interrupted-tool scan over all sessions

Commit: `6c7ebd0`.

- Deleted `Runtime.resumeInterruptedSession()` and the startup loop that called it for every restored session.
- Interrupted tool handling still exists in command paths and handoff continue path.

Why:
- Reduced host runtime startup work (`runtime` segment was often dominant).

---

## Observed bottlenecks from recent measurements

Example user measurement:

`⚠ [perf] startup: ready 131ms (runtime 120ms + cli 11ms) · tab 269ms (hydrate 91ms + render 45ms)`

Interpretation:

1. **Runtime dominates ready**
	- `runtime 120ms` is the biggest startup chunk before CLI paint.
2. **Hydrate dominates tab restore**
	- `hydrate 91ms` is larger than render in this sample.
3. **Render is non-trivial but secondary in this case**
	- `render 45ms` still matters, but hydrate+runtime are larger first wins.

---

## Next optimization plan

### Phase A — Runtime startup (highest leverage right now)

1. **Lazy context restoration for non-active sessions**
	- Today `startRuntime()` restores context for every session and may call history-heavy paths.
	- Plan: restore metadata immediately, but only compute heavy context for active session at startup.
	- Non-active session context computed lazily when tab becomes active or generation starts.

2. **Avoid startup `loadApiMessages()` fallback for context estimation on non-active sessions**
	- In `startRuntime()`, fallback context estimation can parse full history.
	- Plan: skip this fallback at startup for non-active tabs; use lightweight placeholder/unknown context.

3. **Keep publish early**
	- Ensure first `publish()` is not blocked by optional per-tab context work.

Expected effect:
- Reduce `ready` mainly via smaller `runtime` segment.

---

### Phase B — Hydrate for active tab

1. **Profile hydrate sub-steps on heavy tabs (active tab only)**
	- Split timing into:
		- history read (`loadHydrationData`)
		- replay transform (`replayToBlocks` compute)
		- draft load
		- final block attach cost
	- Keep instrumentation temporary or behind a simple debug guard.

2. **If replay compute dominates after blob prefetch**
	- Optimize `replayToBlocks` CPU path (string/block conversions) with minimal behavior change.

3. **If file I/O dominates**
	- Consider session-level replay cache keyed by history file fingerprint (size+mtime) to skip full replay when unchanged.
	- This is bigger scope; only after runtime wins and profiling confirms I/O bottleneck.

Expected effect:
- Reduce `tab` mainly via smaller `hydrate` segment.

---

### Phase C — Render

1. **Measure render on active tab by block class mix**
	- Identify whether long tool blocks, wide lines, or diff cost dominates.

2. **Only then optimize render path**
	- Render is likely harder to shrink than runtime/hydrate without UX trade-offs.

Expected effect:
- Secondary gains once runtime/hydrate are improved.

---

## Measurement matrix for next run (user)

Please collect startup lines from a few representative tabs:

- light tab (short conversation, few/no tools)
- medium tab
- heavy tool-output tab
- heavy long-text tab
- forked tab (if available)

For each sample, record:

- session ID
- startup line (`ready/runtime/cli/tab/hydrate/render`)
- rough tab shape (tool-heavy vs text-heavy)

With those numbers we can pick Phase A vs B order precisely per real workload.

---

## Guardrails

- Keep behavior the same unless explicitly called out.
- Prefer deleting duplicate paths over adding fallback layers.
- Keep code minimal; remove dead startup/hydration branches as we optimize.
