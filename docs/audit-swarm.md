# Audit swarm prompt

Use this when you want Hal to fan out a broad code-quality pass into parallel subagents.

## When to use this

Use it for a coordinated multi-pass cleanup where each subagent owns one narrow concern, does research first, then only implements high-confidence fixes.

Good fit:
- code-quality cleanup
- consolidation / dedupe pass
- type tightening
- dead code removal
- legacy path cleanup

Bad fit:
- one small bugfix
- large cross-cutting refactors that must land atomically
- tasks where subagents would constantly conflict on the same files

## Coordinator prompt

```text
I want to clean up the codebase and improve code quality. This is a complex task, so use 8 subagents. Make one subagent for each of the following:
1. Deduplicate and consolidate code, and implement DRY where it reduces complexity
2. Find type definitions and consolidate any that should be shared
3. Use tools like knip to find unused code and remove it, but only when it is clearly unreferenced
4. Untangle circular dependencies, using tools like madge when useful
5. Remove weak types like any / unknown where high-confidence stronger types can be established
6. Remove unnecessary try/catch and defensive fallbacks that only hide errors
7. Find deprecated, legacy, compatibility, or fallback code and remove the high-confidence dead paths
8. Find low-value comments, AI slop, stubs, and noisy narration; keep helpful explanatory comments

For each subagent:
- do detailed research first
- write a critical assessment of the current state
- list recommendations
- implement all high-confidence recommendations
- avoid speculative rewrites
- run ./test first, and after each meaningful step
- run bun cloc before finishing
- commit only its own changes
- do not autoclose; I want to inspect the tabs later
- send a handoff back with summary, files changed, verification, risks, and open questions

Coordinator rules:
- keep the tasks scoped so they do not fight over the same files when possible
- after handoffs arrive, verify each claimed commit before trusting it
- distinguish clearly between "implemented in this tab" and "reported by a subagent"
```

## Shared subagent brief

Give each subagent the task-specific section below plus this shared brief.

```text
You are doing a focused audit pass in the current repo.

Process:
1. Run ./test first.
2. Research the assigned area before editing.
3. Write down a critical assessment and recommendations.
4. Implement only the high-confidence fixes.
5. Keep changes minimal and focused.
6. Run ./test after each meaningful step.
7. Run bun cloc before finishing.
8. Commit your work.
9. Send a handoff back with:
	- summary
	- findings / assessment
	- files changed
	- verification
	- risks
	- open questions

Constraints:
- do not touch unrelated dirty files
- do not autoclose
- prefer grep / tests / targeted tooling over broad guesses
- if a candidate change is ambiguous, leave it alone and report it instead
```

## Task-specific prompts

### 1) DRY / dedupe audit

```text
Audit the repo for duplicated code and repeated local helper logic.

Focus on:
- repeated helper functions that should be shared
- repeated parsing / formatting / truncation logic
- repeated tiny wrappers that increase maintenance cost

Do not chase abstract purity. Only consolidate duplication when it clearly reduces complexity.
```

### 2) Shared types audit

```text
Audit the repo for duplicated or near-duplicated type definitions that should be shared.

Focus on:
- identical unions repeated across modules
- repeated data-shape interfaces used by multiple layers
- consumer-side consolidation onto existing shared types when possible

Avoid merging types that only look similar but encode different responsibilities.
```

### 3) Unused code audit

```text
Audit the repo for truly unused code.

Use tools like knip when useful, but verify manually before deleting anything.

Focus on:
- orphan modules with no imports or runtime references
- dead exports with no callers
- dead tests / scripts only if they are clearly not part of intended workflow

Do not remove manual entrypoints, intentionally failing fixtures, or public-ish surface area unless you verify they are dead.
```

### 4) Circular dependency audit

```text
Audit the repo for circular dependencies.

Use tools like madge when useful.

Focus on:
- breaking real import cycles with small structural fixes
- moving shared helpers into leaf modules when that cleanly breaks cycles
- keeping loaders / registries thin

Prefer minimal module-boundary fixes over broad rewrites.
```

### 5) Strong typing audit

```text
Audit the repo for weak typing.

Focus on replacing unsafe any / unknown patterns where high-confidence stronger typing can be established.

Priority:
- dynamic boundaries that need validation and narrowing
- tool inputs
- parsed file / protocol payloads
- helpers that spread loose types across the codebase

Do not invent giant speculative schemas. Prefer unknown + validation over fake certainty.
```

### 6) Error-handling audit

```text
Audit try/catch, fallback behavior, and defensive programming.

Focus on:
- catches that hide local invariant failures
- silent persistence failures
- silent startup failures
- success events emitted after failed writes

Keep boundary-safe catches where soft failure is intentional, such as missing-file probes, shutdown cleanup, watcher races, or optional platform integrations.
```

### 7) Legacy / fallback audit

```text
Audit the repo for deprecated, legacy, compatibility, duplicate-path, and fallback code.

Focus on:
- dead shims
- obsolete command aliases
- duplicate code paths where one path is already authoritative
- synthetic event handling or compatibility layers that no longer have real producers

Only remove high-confidence dead paths. Report lower-confidence fallback code separately.
```

### 8) Comment / slop audit

```text
Audit comments and low-signal code text.

Focus on:
- obvious narration comments
- stale migration / archaeology comments
- noisy section banners in small files
- placeholder or future-tense comments
- AI slop, stubs, and low-value wording

Keep comments that explain non-obvious behavior, tricky invariants, platform quirks, or protocol details.
```

## Expected handoff format

Use this exact structure so the coordinator can verify quickly.

```text
Committed: <hash> <title>

Summary
- ...

Findings / assessment
- ...

Files changed
- ...

Verification
- ./test: ...
- bun cloc: ...

Risks
- ...

Open questions
- ...
```

## Coordinator verification checklist

After handoffs arrive, verify before trusting claims:

- `git show --stat <commit>`
- read the touched files
- grep for the claimed removed / added references
- check whether the handoff overstates what actually landed in the commit
- note when a doc mentions broader branch context than the commit itself

If the repo is dirty, be explicit about it when summarizing subagent results.
