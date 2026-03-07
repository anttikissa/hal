# Anthropic Provider Plan

## Goal
Connect `new/` runtime to Anthropic API (Claude models) via the existing `Provider` interface.

## What exists
- `Provider` interface: `generate(params) → AsyncGenerator<ProviderEvent>`
- `ProviderEvent`: thinking | text | tool_call | done | error
- `GenerateParams`: messages, model, systemPrompt
- Agent loop: drives provider, executes tools, re-invokes for tool rounds
- Auth: `auth.ason` in HAL_DIR (shared with old code)
- Old `src/providers/anthropic.ts`: OAuth refresh, SSE parsing, cache breakpoints

## New file: `new/runtime/anthropic-provider.ts`

### Auth
- Read from `HAL_DIR/auth.ason` using ASON parser
- OAuth refresh: POST to console.anthropic.com/v1/oauth/token
- Same CLIENT_ID as old code

### Request building
- POST to `https://api.anthropic.com/v1/messages?beta=true`
- Headers: Authorization Bearer, anthropic-version, anthropic-beta
- Body: model, max_tokens, stream: true, system, messages, tools, thinking
- Adaptive thinking for opus/sonnet-4-6, else enabled with budget
- Cache breakpoints on last two user messages

### SSE streaming
- Read response body as stream
- Parse SSE format: `event:` + `data:` lines, `\n\n` delimited
- Map to ProviderEvent:
  - content_block_start(thinking) → ignore (track state)
  - thinking_delta → yield { type: 'thinking', text }
  - content_block_start(text) → ignore
  - text_delta → yield { type: 'text', text }
  - tool_use_start → start accumulating tool input
  - input_json_delta → accumulate JSON
  - content_block_stop (for tool) → yield { type: 'tool_call', ... }
  - message_delta(stop) → yield { type: 'done', usage }
  - error → yield { type: 'error', message }

### Tools
- GenerateParams needs tools list — add optional `tools` field
- Agent loop passes tool definitions
- For now: bash, read, write, grep, glob, ls, web_search, edit (same as old)
- Tool schemas can be imported from old code or defined fresh

### Changes needed
1. `GenerateParams` — add `tools?: ToolDef[]`
2. `new/runtime/anthropic-provider.ts` — the adapter
3. `new/runtime/agent-loop.ts` — pass tools to provider
4. Auth helper (read auth.ason from HAL_DIR)
5. Config: change defaultModel from mock/mock-1 to anthropic/claude-sonnet-4-20250514

## Not in scope (yet)
- OpenAI/Ollama providers
- Web search tool result handling
- Token calibration
- Context compaction
