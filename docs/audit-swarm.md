# Audit swarm prompt

Use this prompt when you want Hal to split a broad cleanup into 8 subagents.

```text
I want to clean up my codebase and improve code quality. This is a complex task, so we'll need 8 subagents. Make a sub agent for each of the following:
1. Deduplicate and consolidate all code, and implement DRY where it reduces complexity
2. Find all type definitions and consolidate any that should be shared
3. Use tools like knip to find all unused code and remove, ensuring that it's actually not referenced anywhere
4. Untangle any circular dependencies, using tools like madge
5. Remove any weak types, for example 'unknown' and 'any' (and the equivalent in other languages), research what the types should be, research in the codebase and related packages to make sure that the replacements are strong types and there are no type issues
6. Remove all try catch and equivalent defensive programming if it doesn't serve a specific role of handling unknown or unsanitized input or otherwise has a reason to be there, with clear error handling and no error hiding or fallback patterns
7. Find any deprecated, legacy or fallback code, remove, and make sure all code paths are clean, concise and as singular as possible
8. Find any AI slop, stubs, larp, unnecessary comments and remove. Any comments that describe in-motion work, replacements of previous work with new work, or otherwise are not helpful should be either removed or replaced with helpful comments for a new user trying to understand the codebase-- but if you do edit, be concise

I want each to do detailed research on their task, write a critical assessment of the current code and recommendations, and then implement all high confidence recommendations.
```

Small practical additions:
- Don’t autoclose the subagents if you want to inspect their tabs later.
- Have each subagent commit only its own changes.
- Verify each handoff before trusting the summary.

Suggested audit cadence:
- Every 50 commits: unused code, legacy/fallback, error handling
- Every 100 commits: circular deps, strong typing, DRY/dedupe
- Every 200 commits: shared types, comment/slop
- Also run immediately after major provider/protocol changes, big module moves, or feature removals

Notes from the first audit run:
- `bunx` can run suggested external tools like `knip` and `madge` even when they are not in `package.json`. Ask first if you do not want ad-hoc external tools fetched on demand.
- Raw `knip` on the whole repo was noisy because of `examples/` and manual scripts. Scoped `knip` was much more useful.
- `madge` was useful for catching real cycles in `src/` when run with a focused TypeScript-only scope.
- Shared-type audit had overlap with strong-typing work; consider merging those into one pass unless you specifically want type-sharing reviewed on its own.
- Comment/slop audit had the lowest payoff. Keep it as a late polish pass, not an early maintenance pass.
- DRY cleanup was useful when it stayed small and helper-oriented. Broad dedupe passes risk churn and over-abstraction.
- Error-handling audit was valuable when it targeted silent failures and hidden fallbacks, not boundary catches that intentionally absorb missing files, shutdown noise, or OS integration issues.
- Legacy/fallback and unused-code audits gave high-confidence wins and are good candidates for regular recurring maintenance.
- Circular-deps audit was one of the highest-value focused passes because it found a real structural issue and fixed it cleanly.
- Strong-typing audit worked best at dynamic boundaries with validation and narrowing, not by inventing deep wire-payload types speculatively.
