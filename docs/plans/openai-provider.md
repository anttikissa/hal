# OpenAI Provider

## Overview

Add OpenAI Responses API support. Uses the same OAuth flow as old-src (chatgpt.com endpoint),
with API key fallback.

## Files to change

1. **`src/runtime/openai-provider.ts`** (new) — Provider implementation
   - OAuth refresh via `auth.openai` credentials (same as old-src)
   - Codex endpoint detection (chatgpt.com/backend-api/codex/responses vs api.openai.com)
   - Convert Anthropic-format messages → OpenAI Responses API format
   - Convert Anthropic-format tools → OpenAI function tools (skip web_search)
   - Parse OpenAI SSE stream → ProviderEvent stream
   - Handle reasoning summaries as thinking events

2. **`src/runtime/auth.ts`** — Add OpenAI token refresh
   - `refreshOpenAIAuth()` — form-encoded POST to auth.openai.com/oauth/token
   - JWT decode for accountId extraction
   - API key detection (skip refresh for sk-* tokens)

3. **`src/models.ts`** — Add aliases
   - `gpt54` / `gpt5.4` → `openai/gpt-5.4`
   - `gpt53` / `gpt5.3` → `openai/gpt-5.3`
   - `gpt52` / `gpt5.2` → `openai/gpt-5.2`
   - Display patterns for GPT models

4. **`src/runtime/context.ts`** — Add context windows for GPT models

## Message conversion (Anthropic → OpenAI)

- `user` with string content → `{ role: 'user', content: [{ type: 'input_text', text }] }`
- `user` with image blocks → `{ role: 'user', content: [{ type: 'input_image', ... }] }`
- `user` with tool_result → `{ type: 'function_call_output', call_id, output }`
- `assistant` text → `{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }`
- `assistant` tool_use → `{ type: 'function_call', call_id, name, arguments }`

## Tool conversion

- Custom tools: `{ name, input_schema }` → `{ type: 'function', name, description, parameters }`
- Skip `web_search_20250305` (Anthropic-specific)

## Auth

Stored in `auth.ason` under `openai` key (same as old-src):
```
{ openai: { accessToken, refreshToken, expires, accountId } }
```
