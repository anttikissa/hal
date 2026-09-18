# OpenCode Go follow-up: credential-aware alias routing (deferred)

## What changed recently
- `/login opencode` now stores an OpenCode API key encrypted, like `/login claude`.
- `/model opencode-go/<id>` works.
- Tab completion and the model picker include `opencode-go/<id>` entries.

## Remaining gap (#3)
Aliases such as `/model kimi`, `/model glm`, or `/model deepseek` always resolve to
OpenRouter routes, even when the user has an OpenCode Go subscription key. The user
wants the subscription route preferred when it exists and has quota.

## Design questions to resolve before implementing

### 1. Scope of routing
Should credential-aware routing apply only to Go, or to any provider pair where the
same model is available?

Examples:
- `kimi` could route to `opencode-go/kimi-k3`, `openrouter/moonshotai/kimi-k3`, or direct `moonshotai/...` if the user has a Moonshot API key.
- `deepseek` could route to `opencode-go/deepseek-v4.1-flash`, `openrouter/deepseek/deepseek-v4.1-flash`, or direct DeepSeek.

Minimal scope: Go-only override for the curated aliases (`kimi`, `glm`, `qwen`,
`deepseek`, `minimax`, etc.) when the user has a Go key.

### 2. Policy when Go quota is exhausted
The user explicitly said: do not auto-switch providers when a subscription window is
spent. So if Go 429s, the call fails. The question is what `/model kimi` means *before*
the call:

- **Option A (static):** Resolve `kimi` to Go if a Go key exists, period. The user gets
the subscription until it hits a limit, then sees an error. Simple, matches the
"prefer subscription" rule.

- **Option B (dynamic):** Check Go usage at resolution time and fall back to OpenRouter
if the relevant window is already 100%. Violates the user's stated policy unless the
fallback is to another *subscription* route, not pay-per-token. We currently don't
model that.

- **Option C (ask):** Resolve to Go by default, but when Go is at 100% suggest the
OpenRouter equivalent with a message like: `OpenCode Go 5h limit reached. Try
/model openrouter/moonshotai/kimi-k3`. This is consistent with the deferred
"exhaustion hint" work.

Recommended default: **Option A**, with Option C's hint delivered at 429 time.

### 3. Where to store the preference
The resolution needs to know which providers have credentials. `common/models.ts` is
browser-safe and cannot read `auth.ason` or env vars. Two possibilities:

- Hydrate a `configuredProviders: string[]` from the server during `models.hydrate()`,
  updated whenever auth changes (similar to how `registryProviderModels` was added).

- Move resolution to the server side: `serverModels.resolveModel(alias)` consults
  credentials and usage, returning the routed fullId. The client would call the server
  for resolution, or the server would push the resolved default to the session model.

The first is smaller and keeps the client self-contained. The second is more powerful
because it can react to live quota.

### 4. How to express alias-to-provider preference in code
The hardcoded `CATALOG` entries pin aliases to one `fullId`. We could add an optional
`routes?: { provider: string; fullId: string }[]` to each `CatalogEntry`. Resolution
walks that list and picks the first provider that is configured (and, later, has
quota). For example:

```ts
{ group: 'OpenRouter', alias: 'kimi', fullId: 'openrouter/moonshotai/kimi-k3',
  routes: [
    { provider: 'opencode-go', fullId: 'opencode-go/kimi-k3' },
    { provider: 'openrouter', fullId: 'openrouter/moonshotai/kimi-k3' },
  ],
}
```

The existing `fullId` stays as the final fallback.

### 5. UX expectations
- `/model opencode-go/kimi-k3` always means exactly that (explicit route).
- `/model kimi` means "the best kimi-k3 route I can use".
- Status bar shows the actual resolved provider, so the user knows which bill they're
  on.
- If the user has both Go and OpenRouter keys, `kimi` goes to Go. If they only have
  OpenRouter, it goes to OpenRouter.

## Suggested implementation (when picked up)
1. Add `configuredProviders: string[]` to `models.hydrate()` (server derives from
   `auth.listCredentials()` + env vars).
2. Add `routes` to relevant `CATALOG` entries.
3. Modify `resolveModel()` so alias resolution consults `routes` in order, using
   `configuredProviders`.
4. Add tests for `kimi` resolving differently based on which keys are present.
5. Keep the 429 exhaustion hint separate: when Go fails with a known spent window,
   emit a hint naming the OpenRouter equivalent.

## Estimate
- Core routing logic: ~30 lines in `common/models.ts`.
- Server hydration of configured providers: ~10 lines in `server/models.ts`.
- Tests: ~40 lines.
- Total: ~80 lines, no new modules.

## Risks
- Changing alias resolution affects every `/model` command. Must preserve existing
  behavior for users without Go keys.
- `common/models.ts` is shared with the browser client; any new hydrated data must be
  serializable and small.
