# Plan 4/7: Providers

## Overview
LLM provider implementations: shared base, Anthropic, OpenAI + compatible endpoints.
Budget: ~500 lines added. Target after: ~5,435.

## Subplans

### 4a. Shared provider base (~75 lines)

**File:** `src/providers/provider.ts`

Port from `prev/src/providers/provider.ts` (75 lines) + `prev/src/providers/loader.ts` (26 lines).

Provider interface:
```ts
interface Provider {
	name: string
	stream(params: StreamParams): AsyncGenerator<StreamEvent>
	abort(): void
}

interface StreamParams {
	model: string
	messages: Message[]
	systemPrompt: string
	tools?: ToolDef[]
	maxTokens?: number
	temperature?: number
}

type StreamEvent =
	| { type: 'text', text: string }
	| { type: 'tool_use', id: string, name: string, input: any }
	| { type: 'usage', inputTokens: number, outputTokens: number }
	| { type: 'error', error: string }
	| { type: 'end' }
```

Provider loader:
- `getProvider(model: Model): Provider` — return Anthropic or OpenAI provider based on model
- Cache provider instances

Token calibration (~25 lines): rough estimation
- `estimateTokens(text: string): number` — ~4 chars per token approximation
- Used for context window management before sending to provider

### 4b. Anthropic provider (~200 lines)

**File:** `src/providers/anthropic.ts`

Port from `prev/src/providers/anthropic.ts` (243 lines).

- Uses `@anthropic-ai/sdk` (already in package.json? check)
- Streaming via `client.messages.stream()`
- Handle content blocks: text, tool_use
- Prompt caching: send cache_control headers for system prompt + recent messages
- Error handling: rate limits (429), overloaded (529), auth errors
- API key from env: `ANTHROPIC_API_KEY`

Key implementation details:
- Convert our Message format → Anthropic API format
- Stream SSE events → yield StreamEvent objects
- Handle stop_reason: end_turn, tool_use, max_tokens
- Support images in messages (base64)

### 4c. OpenAI + compat (~200 lines)

**File:** `src/providers/openai.ts`

Merge `prev/src/providers/openai.ts` (329 lines) + `prev/src/providers/openai-compat.ts` (214 lines).

Single provider with a compat flag for alternative endpoints:
- OpenAI native: api.openai.com
- Groq: api.groq.com
- Deepseek: api.deepseek.com
- Local (ollama, etc.): configurable base URL

- Streaming via fetch + SSE parsing (no SDK dependency for compat)
- Convert our Message format → OpenAI chat format
- Handle tool_calls in responses
- API keys from env: `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`

Constructor takes:
- `baseUrl: string`
- `apiKey: string`
- `compatMode: boolean` — relaxes some OpenAI-specific features

## Dependencies
- 4a first (interface needed by 4b, 4c)
- 4b and 4c can be done in parallel after 4a
- All depend on protocol types (plan 2) and models (plan 2)

## Testing
- `bun test` after each subplan
- `bun cloc` to verify budget
