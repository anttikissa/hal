# Plan: make OpenCode Go work

Ephemeral (docs/local is gitignored). Delete when shipped.
Goal: use the Go subscription today. Everything else is deferred.

## What Go needs

- OpenAI-compatible: `https://opencode.ai/zen/go/v1/chat/completions`, Bearer key.
  Our `createCompatProvider` already speaks this — no new provider code.
- Key comes from the Zen console (no OAuth). Env var `OPENCODE_API_KEY`.
- models.dev already tags 36 models with an `opencode-go` source, so context windows
  resolve with no extra work.
- Their docs ask clients to send a real User-Agent and a stable
  `x-opencode-session` per conversation.

## The change (4 edits, ~8 lines)

1. `server/providers/shared.ts` — `compatEndpoints`:
   `'opencode-go': 'https://opencode.ai/zen/go/v1'`   (1 line)
2. `server/auth.ts` — `envKeys`: `'opencode-go': ['OPENCODE_API_KEY']`   (1 line)
   Needed because the default derivation produces the broken `OPENCODE-GO_API_KEY`.
3. `server/providers/openai.ts` `compatCredentialMessage` — use `auth.envKeyNames()`
   instead of `toUpperCase()`   (2 lines). Same hyphen bug; fixes the error text.
4. `server/providers/openai.ts` `generateCompat` — add `User-Agent: hal/<version>`,
   and `x-opencode-session: <req.sessionId>` for opencode-go   (~4 lines).

Test: one case in `providers/openai.test.ts` asserting the compat request carries the
endpoint and both headers (deterministic wiring, no LLM output).

Then: `OPENCODE_API_KEY=... ` and `/model opencode-go/kimi-k3` works.

## Deferred (do not do now)

Written down so it is not re-derived later.

- **isApiKey → isSubscription.** `render-status.ts:398` uses `!isApiKey(provider)` to
  gate the "Sub: 5h 42%" label, so Go shows no plan label. Cosmetic; Go works without it.
- **Usage reader.** `GET https://opencode.ai/zen/go/v1/usage` (same Bearer key) returns
  `{ usage: { rolling, weekly, monthly } }`, each `{ status, percent, resetsAt }`;
  401 bad key, 403 = no Go subscription. Worth ~90 lines later; note that
  `anthropic-usage.ts` (342) and `openai-usage.ts` (351) are near-identical and should
  be deduped before a third one lands (cloc is 23234 vs a 21000 budget).
- **/login API-key entry.** Menu of ~10 curated providers + any with a credential,
  `/login <name>` Tab-completing the rest, `/help providers` for the full list.
  Uses the existing encrypted `secret` question. Note `runtime.ts handleAnswer`
  hardcodes `finishAnthropic()` for every login question — must dispatch on
  `question.source.provider` first.
- **models.dev provider registry.** api.json has 221 providers with base URL + env
  vars; 179 are OpenAI-compatible and would need zero code. Would make
  `compatEndpoints`/`envKeys` generated rather than hardcoded.
- **Quota exhaustion hint.** Go 429s with `retry-after` and `limitName`. Policy
  decided: never auto-switch provider; just name an alternative the user already has
  a credential for ("also available: /model openrouter/...").

## Note

`./test` baseline not yet established — run it before the first edit.
