# Dynamic Provider/Model Architecture Plan (Ollama + DeepSeek + Kimi)

Date: 2026-02-28

## Goal

Make adding a new model backend (Ollama, DeepSeek, Kimi, OpenRouter-like endpoints) a config/auth change, not a TypeScript change.

Target outcome:

- After one-time refactor, adding a provider is ~5 lines in config.
- No hardcoded global model list in code.
- API-key providers are easy to add and rotate.
- OpenAI-compatible endpoints work through one shared implementation.

## Why this is needed (current pain)

Current HAL is partly provider-agnostic at runtime, but model/provider setup is still hardcoded in key places:

1. `src/config.ts`
	- `parseModel()` infers provider from hardcoded prefixes.
	- model aliases are compile-time constants (`MODEL_ALIASES`).
2. `src/auth.ts`
	- auth storage is hardcoded to `anthropic` and `openai` fields.
3. provider registration (`main.ts`)
	- providers are explicitly imported + registered in code.
4. protocol logic is mixed with provider-specific auth/endpoints (`src/providers/openai.ts`).

Result: adding a new OpenAI-compatible provider still means coding a provider class.

## What we learned from examples

- **pi-mono** has the right shape for this problem:
	- data-driven provider registry from `models.json`
	- one shared OpenAI Completions path for many vendors
	- provider-level config (`baseUrl`, `api`, `apiKey`, headers) + model-level entries
- **OpenCode** also treats custom providers as first-class config/UI objects, not hardcoded source edits.

We should adopt the same core idea, but keep HAL implementation minimal.

## Target architecture

## 1) Split "protocol" from "provider instance"

Introduce a small protocol layer:

- `anthropic-messages`
- `openai-responses`
- `openai-completions` (new; used by Ollama/DeepSeek/Kimi-compatible endpoints)

Then provider instances become mostly config:

- provider ID (`ollama`, `deepseek`, `kimi`, etc.)
- protocol name
- base URL
- headers/auth strategy

This lets many providers share one protocol implementation.

## 2) Data-driven provider config

Add to `config.ason`:

```ason
{
	providers: {
		ollama: {
			protocol: 'openai-completions',
			baseUrl: 'http://localhost:11434/v1',
			auth: 'none'
		},
		deepseek: {
			protocol: 'openai-completions',
			baseUrl: 'https://api.deepseek.com/v1',
			auth: 'apiKey'
		}
	},
	modelAliases: {
		local: 'ollama/qwen2.5-coder:14b',
		ds: 'deepseek/deepseek-chat'
	}
}
```

This is the "5 lines" path for new OpenAI-compatible providers.

## 3) Generic auth map (secrets remain in `auth.ason`)

Extend auth schema to support arbitrary providers:

```ason
{
	providers: {
		deepseek: { apiKey: 'sk-...' },
		kimi: { apiKey: 'sk-...' }
	}
}
```

Keep backward compatibility by reading legacy `auth.openai` / `auth.anthropic` too.

## 4) Provider factory at startup

Instead of hardcoding all providers in `main.ts`:

- register built-ins (anthropic/openai/mock)
- then read `config.providers`
- instantiate and register providers dynamically via a small factory

No code change needed for each new provider.

## 5) Model resolution without provider heuristics

Move away from hardcoded prefix inference (`gpt`, `claude`, etc.) for extensibility:

Resolution order:

1. alias from merged aliases (`built-in + config.modelAliases`)
2. explicit `provider/model`
3. bare model ID -> attach current default provider (from `defaultModel` provider)

This keeps bare names usable while avoiding world-scale hardcoding.

## 6) Minimal OpenAI-compatible protocol adapter

Add one shared `openai-completions` adapter with:

- request mapping from HAL message blocks -> Chat Completions messages
- SSE parsing for deltas + tool calls
- stop-reason + usage normalization

This is the one-time complexity cost that removes future per-provider code.

## 7) Prompt-driven onboarding flow

User asked for adding by prompting. Minimal path:

- assistant edits `config.ason` + `auth.ason` directly (already possible)
- optional helper command later: `/provider add <id> <baseUrl> <protocol>` + `/provider key <id>`

Do not block on adding new commands. Config-first works immediately.

## Implementation phases

## Phase A (foundation)

1. Add provider config types in `src/config.ts`
	- `providers?: Record<string, ProviderConfig>`
	- `modelAliases?: Record<string, string>`
	- helper to get merged aliases
2. Add generic auth map in `src/auth.ts`
	- `providers?: Record<string, ProviderAuth>`
	- `getProviderAuth(provider)` checks dynamic map first, then legacy fields
3. Add `openai-completions` provider implementation (shared)
4. Add provider factory (`src/providers/factory.ts`)
5. Wire dynamic registration in `main.ts`
6. Update `runModel` listing to include dynamic aliases

Deliverable: Ollama/DeepSeek/Kimi can be added via config+auth only.

## Phase B (stability + compat)

1. Add minimal compat flags for OpenAI-compatible quirks:
	- `maxTokensField` (`max_tokens` vs `max_completion_tokens`)
	- `supportsUsageInStreaming` (bool)
	- optional extra headers
2. Request-scoped stream state for OpenAI-style providers (avoid cross-session bleed)

Deliverable: reliable multi-tab concurrent usage.

## Phase C (UX polish)

1. `/provider` command group (list/add/remove/set-key)
2. Better `/model` output:
	- built-ins + configured aliases
	- quick copy/paste examples

Deliverable: no manual file edits needed for common setup.

## Test plan

Add/extend tests for:

1. config parsing:
	- dynamic providers and aliases
	- model resolution order
2. auth:
	- dynamic provider keys
	- legacy auth fallback still works
3. protocol:
	- OpenAI Completions streaming parser (text/tool calls/stop)
4. integration:
	- provider registration from config
	- `/model` with `provider/model` for dynamic providers

## Migration strategy

- Keep existing `MODEL_ALIASES` as built-in defaults.
- Merge `config.modelAliases` over defaults.
- Keep existing `auth.openai` and `auth.anthropic` fields readable.
- New writes for dynamic providers go to `auth.providers.<id>`.

No forced migration file rewrite required.

## Effort estimate

One-time refactor: medium (not 5 lines).

- Foundation (Phase A): ~0.5-1.5 days
- Stability (Phase B): ~0.5 day
- UX polish (Phase C): optional

After Phase A, each new OpenAI-compatible provider is a small config/auth entry (typically 5-10 lines total, zero TS changes).

## Example outcomes

Ollama (local):

```ason
providers: {
	ollama: { protocol: 'openai-completions', baseUrl: 'http://localhost:11434/v1', auth: 'none' }
}
```

DeepSeek:

```ason
providers: {
	deepseek: { protocol: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', auth: 'apiKey' }
}
```

auth.ason:

```ason
providers: {
	deepseek: { apiKey: 'sk-...' }
}
```

Then use:

- `ollama/qwen2.5-coder:14b`
- `deepseek/deepseek-chat`
- `kimi/kimi-k2` (if configured similarly)
