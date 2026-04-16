# Dependency audit — 2026-04-16

Checked with:

- `bunx madge --extensions ts --circular --json src`
- targeted import inspection around the reported provider modules

## Current result

`src/` is now cycle-free according to madge.

Before this change, madge reported two cycles:

1. `providers/provider.ts -> providers/anthropic.ts -> providers/provider.ts`
2. `providers/provider.ts -> providers/openai.ts -> providers/provider.ts`

## What was wrong

`providers/provider.ts` had two jobs:

- lazy-loading concrete providers
- hosting shared stream/retry helpers used by those same providers

That creates a classic loader cycle:

- the loader dynamically imports `anthropic.ts` / `openai.ts`
- those provider modules statically imported the loader for `readWithTimeout()` and `parseRetryDelay()`

This was a low-grade architectural trap. It happened to work, but it makes initialization order harder to reason about and makes the loader a magnet for unrelated helper code.

## Fix applied

Shared helper logic moved to `src/providers/shared.ts`.

- `providers/provider.ts` now only loads and caches providers
- `providers/anthropic.ts` and `providers/openai.ts` import `providerShared`
- no init-time behavior changed
- mutable-namespace convention is preserved via `export const providerShared = { ... }`

## Dependency graph assessment

The graph is much healthier than the old codebase: after the provider split, the core `src/` graph is acyclic.

Still, a few modules are structural hotspots:

- `config.ts` has high fan-out and knows about UI, runtime, and usage modules
- `client/render.ts`, `server/runtime.ts`, and `main.ts` are large composition points
- `tools/tool.ts`, `server/sessions.ts`, `utils/ason.ts`, `state.ts`, and `models.ts` have high fan-in

That is not a bug by itself, but these are the places most likely to regrow cycles if responsibilities drift.

## Recommendations

1. Keep loader modules thin.
   - A loader/registry should load implementations, not host shared helper logic used by those implementations.

2. Split `config.ts` if it grows further.
   - Today it mixes config registry, config loading, watcher reactions, and UI invalidation.
   - A future split into `config-registry.ts` and `config-runtime.ts` would reduce fan-out pressure.

3. Protect the hot hubs.
   - Treat `tools/tool.ts`, `server/sessions.ts`, and `models.ts` as low-level leaves.
   - Avoid importing higher-level runtime/client modules back into them.

4. Watch dynamic-import edges explicitly.
   - Madge caught the provider cycles even though one side used dynamic imports.
   - Any module using `await import()` should be reviewed as a potential boundary module.

5. Consider adding a CI cycle check.
   - A small script or test that runs madge on `src/` would stop regressions early.
   - If we do this, keep it optional or cached so it does not slow local red-green loops too much.

## Open question

`streamTimeoutMs` lives in `providerShared.config`, but provider config is still not wired into `config.ason`. That predates this change. Decide whether provider stream timeouts should be user-configurable or kept internal.
