# Hot-patchable config knobs

## Goal

Make runtime tuning knobs hot-patchable without adding a config framework.

## Pattern

- Keep true constants as plain `const` values: regexes, paths, URLs, fixed schemas, enum-like tables.
- Move runtime tuning knobs into a mutable exported object.
- Read those values at call time, not once at module load.
- Expose the object from the module namespace too, so eval can patch it naturally.
- Keep per-call overrides (`opts`) on top of module defaults.

## Initial sweep

1. Convert `src/session/prune.ts` thresholds to mutable config.
2. Apply the same pattern to a few similar knobs in nearby runtime modules.
3. Add tests that mutate the config objects and prove behavior changes live.
4. Run targeted tests, `./test`, `bun scripts/cloc.ts`, then commit.
