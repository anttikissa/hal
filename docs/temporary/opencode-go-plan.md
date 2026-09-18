# Plan: make OpenCode Go work, with usage bars

Ephemeral working doc. Delete when shipped.

Goal: `/model opencode-go/kimi-k3` works, and the status bar and `/status` show
`Sub: 5h 81%, 7d 80%` like they do for Claude and ChatGPT.

## Key simplification: stop hardcoding providers

models.dev's `api.json` — which we already download and cache — carries `api`
(base URL) and `env` (env var names) for **195 providers**. We hardcode 3 in
`compatEndpoints` and 6 in `auth.envKeys`, duplicating it.

Persisting those two fields costs **17 KB in a 1.6 MB cache file**. So instead of
adding `opencode-go` to two tables, read the registry:

1. `server/models.ts modelsDevMetadata()` — collect `{api, env}` per provider into
   the cache; expose `serverModels.providerInfo(id)`   (~6 lines)
2. `shared.ts compatEndpoints` + `auth.ts envKeys` — fall back to the registry when
   there is no hardcoded entry   (~6 lines)

~12 lines wires up 195 providers with correct URLs and correct env var names —
including the hyphen case that makes the default `OPENCODE-GO_API_KEY` wrong. Keep
the existing hardcoded entries as seeds so a cold cache still works; that is why
this is "fall back to" and not "replace with".

Also fixes: `compatCredentialMessage` should use `auth.envKeyNames()` rather than
`toUpperCase()` (2 lines), and `generateCompat` should send
`User-Agent: hal/<version>` plus `x-opencode-session: <sessionId>` for opencode-go
(~4 lines) — their docs ask for both.

## Usage bars (the required half)

`GET https://opencode.ai/zen/go/v1/usage`, same Bearer key, returns
`{ usage: { rolling, weekly, monthly } }`, each `{ status, percent, resetsAt }`.
401 = bad key, 403 = no Go subscription.

Two blockers, both real:

**a. `isApiKey` gates the bar off.** `render-status.ts:398` computes
`isSub = !isApiKey(provider)`, so any API-key provider shows no plan label. Go is a
subscription behind an API key, so the bar would never appear. Replace
`subscriptions.isApiKey` with `subscriptions.isSubscription(provider)`: anthropic or
openai with a `token` credential, or opencode-go with any credential. Touches
`auth.ts`, `client/backend.ts`, `main.ts`, `render-status.ts`   (~10 lines).
(`models.ts:173`'s 272k ChatGPT cap keeps `type === 'token'` — it genuinely is
asking about the token, not about billing.)

**b. A usage module is needed.** New `server/opencode-usage.ts`, ~95 lines:
liveFile cache (peer processes read it), fetch+parse, `current()` → windows,
`formatStatusText()`, `renderStatus()`, and the accounts map.

**Multi-account, like the other two.** The docs' "only one member per workspace can
subscribe" (`packages/web/src/content/docs/go.mdx:57`) limits one subscriber per
*workspace*, not per person. The usage endpoint resolves `(workspaceID, userID)`
from the API key itself (`routes/zen/go/v1/usage.ts:37-52, 90-91`), so two
workspaces means two keys with independent quotas. Two subscriptions therefore work,
and `auth.ason`'s existing array form plus `accountRotation` already handle them —
so the accounts map stays and rotation comes for free.

Windows map rolling→`5h`, weekly→`7d`, monthly→`30d`.

Wiring: `main.ts subscriptionStatus()`, `accountUsageWindows()`, `currentKey()` and
`onChange` (~10), `commands.ts` `/status` section and hint (~5), refresh after
generation in `generateCompat` (~2).

### Debt: extract a usage-module base
`anthropic-usage.ts` (342) and `openai-usage.ts` (351) are near-identical — liveFile
state, fix/init/save/onChange, keyOf, current/all, setCurrentCredential, the markdown
table, refreshAll. This adds a third. **TODO: extract the shared machinery into
`server/subscription-usage-store.ts` before a fourth subscription lands** — est. ~200
shared, each provider module shrinks by ~150, net negative. Doing it now would
dominate this task; doing it later gets harder with each copy. cloc is 23234 against
a 21000 budget, so this is a real cost. Leave the TODO in all three modules.

## Total

~130 lines: 12 registry + 10 isSubscription + 95 usage module + 17 wiring.

## Deferred

- **`/login <provider>` API-key entry** (~15 lines). Meanwhile the key goes in
  `OPENCODE_API_KEY` or by hand in auth.ason. When doing it: `runtime.ts:187`
  hardcodes `finishAnthropic()` for *every* login question and must dispatch on
  `question.source.provider` first. Menu = ~10 curated + anything with a credential;
  `/login <name>` Tab-completes the rest.
- **Better error when a Go quota window is spent.** Go 429s with `retry-after` and
  `metadata.limitName` (`5 hour`|`weekly`|`monthly`), so we can say exactly which
  window ran out and when it resets, then name an alternative route for the same
  model — but *only* one the user already holds a credential for:

  ```
  OpenCode Go 5-hour limit reached (resets 14:20).
  Also available: /model openrouter/moonshotai/kimi-k3
  ```

  Policy settled: **never auto-switch provider.** Silently moving from a spent
  subscription to pay-per-token is a surprise invoice. This is just a better error
  string (~15 lines), not a routing engine. Ranking by raw models.dev cost would
  surface providers like `crof`/`vancine` that the user has never heard of and has
  no key for, hence the credential filter.

## Order

1. registry + headers → `OPENCODE_API_KEY=... /model opencode-go/kimi-k3` works
2. isSubscription
3. usage module + wiring

Baseline `./test`: **1466 pass, 0 fail** (clean, before any edits).
