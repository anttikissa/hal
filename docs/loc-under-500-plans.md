# Keep large modules under 500 LOC

Date: 2026-05-12

This is a planning document only. It proposes architecture/reduction options for review before implementation.

## Current measurements

Baseline commands run before updating these plans:

- `./test` → **701 pass, 0 fail**
- `bun cloc src/client.ts src/server/runtime.ts src/cli/prompt.ts`
- full `bun cloc` total from the same run → **14981 LOC**

Requested targets:

- `src/client.ts` — **1029 LOC**
- `src/server/runtime.ts` — **697 LOC**
- `src/cli/prompt.ts` — **580 LOC**

Other production files currently above 500:

- `src/cli/blocks.ts` — **621 LOC**
- `src/runtime/commands.ts` — **593 LOC**
- `src/runtime/agent-loop.ts` — **584 LOC**

The detailed plans below cover the three files the user asked about. The other three should get follow-up planning or a small guardrail cleanup pass after this review.

## Why the same files keep growing

1. **Central files collect feature edges.**
	`client.ts` and `server/runtime.ts` can see most state, so they are the path of least resistance for new behavior.

2. **Old reduction plans solved old hot spots, not the new growth.**
	Previous rounds removed prompt mirroring, live-event duplication, command metadata duplication, etc. Current growth is from newer features: richer startup cards, return-to-tab behavior, preferred-cwd startup, retry/continue state, auth/sensitive-tool work, more command surfaces, and prompt correctness fixes.

3. **There is no automatic 500-LOC guardrail.**
	A file can be reduced under 500 and later quietly regrow.

4. **Some modules have names that invite broad ownership.**
	`client.ts`, `runtime.ts`, and `prompt.ts` describe entire subsystems rather than small responsibilities.

## Implementation acceptance rules

For every future implementation pass:

1. Run `./test` first and record baseline.
2. Re-measure target LOC and repo LOC from the live branch.
3. Prefer deletion, simplification, and real cross-file dedupe.
4. Extraction is acceptable only if it creates a real owner and does not materially grow repo LOC.
5. Stop after each meaningful chunk and re-measure.
6. Do not push code into another file already near/over 500.
7. If the target is still over 500, do another current-state plan/review pass instead of forcing stale ideas.
8. Add or update tests before risky behavior changes.

## Guardrail recommendation

After the reviewed reductions land, add a `./test` guard or dedicated script:

- production `.ts` files should stay below **500 bun-cloc LOC**
- allow a short explicit exception list only while a module is actively being paid down
- print the offender list and fail with a clear message

This would have caught the regressions since the previous LOC campaign.

---

# Plan 1: `src/client.ts`

See the dedicated plan: `docs/module-reduction-plans/src/client.ts.md`.

Summary:

- Current size: **1029 LOC**.
- Hard because it owns tab state, session loading, event handling, startup, persistence, drafts, command construction, and UI policy.
- Recommended architecture: keep `client.ts` as state owner for now, but extract cohesive helpers:
	1. startup summary text
	2. session snapshot loading
	3. tab-list reconciliation planning
	4. client persistence/watch startup
	5. event-family handlers only if still needed
- Reliable under-500 likely requires several steps, not one tiny cleanup.

---

# Plan 2: `src/server/runtime.ts`

See the dedicated plan: `docs/module-reduction-plans/src/server/runtime.ts.md`.

Summary:

- Current size: **697 LOC**.
- Hard because it owns server orchestration: sessions, commands, generation, spawn, model refresh, startup recovery, MCP/inbox, shared state.
- Recommended architecture: runtime remains orchestrator; extract side domains:
	1. model metadata refresh
	2. spawn-agent lifecycle
	3. reset/compact maintenance
	4. runtime startup/recovery/services
	5. command dispatch cleanup after domain extraction
- Under-500 is realistic without pushing code into `runtime/commands.ts`.

---

# Plan 3: `src/cli/prompt.ts`

See the dedicated plan: `docs/module-reduction-plans/src/cli/prompt.ts.md`.

Summary:

- Current size: **580 LOC**.
- Hard because it owns editor state plus wrapped layout/cursor mapping plus rendering plus clipboard/history/undo/key handling.
- Recommended architecture:
	1. tests first for prompt correctness
	2. extract layout/cursor mapping to `src/cli/prompt-layout.ts`
	3. compact word-movement scanner logic
	4. move clipboard write to `src/cli/clipboard.ts`
	5. only then do remaining key dispatch cleanup
- Under-500 should be reachable without moving prompt ownership into `client.ts`.

---

# Suggested review order

1. `src/cli/prompt.ts`
	- smallest architectural surface and clearest first win.
2. `src/server/runtime.ts`
	- several cohesive side domains can move out safely.
3. `src/client.ts`
	- biggest and most architectural; review after the smaller plans so lessons carry over.

# Follow-up after these three

Plan or clean these current offenders next:

- `src/cli/blocks.ts` — 621
- `src/runtime/commands.ts` — 593
- `src/runtime/agent-loop.ts` — 584
