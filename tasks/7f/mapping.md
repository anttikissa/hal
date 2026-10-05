# Neutral blocks and events vs. the three wire APIs

Written before the code (task 7f) to check that one shape covers
Anthropic Messages, OpenAI Responses and OpenAI-compatible Chat
Completions. Types live in `src/common/blocks.ts`; the provider
interface and shared HTTP/SSE code in `src/host/provider.ts`.

## Model id

`provider/model`, split on the first slash only:
`anthropic/claude-sonnet-4-5`, `openai/gpt-5`,
`openrouter/anthropic/claude-sonnet-4.5` (model keeps its slash).

## Request

| neutral                 | Anthropic Messages      | OpenAI Responses            | Chat Completions               |
|-------------------------|-------------------------|-----------------------------|--------------------------------|
| `system`                | `system` (text blocks)  | `instructions`              | first `{role:'system'}` msg    |
| `tools[]` name/desc/schema | `{name, description, input_schema}` | `{type:'function', name, description, parameters}` | `{type:'function', function:{name, description, parameters}}` |
| `maxTokens`             | `max_tokens` (required) | `max_output_tokens`         | `max_tokens`                   |
| always streams          | `stream: true`          | `stream: true`              | `stream: true`, `stream_options.include_usage` |

## Messages → input

| neutral block            | Anthropic                                  | Responses                                        | Chat Completions |
|--------------------------|--------------------------------------------|--------------------------------------------------|------------------|
| user `text`              | user `{type:'text'}`                       | `{role:'user', content:[{type:'input_text'}]}`   | `{role:'user', content}` |
| user `image` (task 2a)  | user `{type:'image', source:{type:'base64', media_type, data}}` | `{type:'input_image', image_url: data URL}` | `content:[{type:'text'}, {type:'image_url', image_url:{url: data URL}}]`; an endpoint with `images: false` gets a text note |
| user `tool_result`       | user `{type:'tool_result', tool_use_id, content, is_error}` | item `{type:'function_call_output', call_id, output}` (no error flag: prefix text) | `{role:'tool', tool_call_id, content}` (no error flag) |
| assistant `text`         | assistant `{type:'text'}`                  | `{role:'assistant', content:[{type:'output_text'}]}` | assistant `content` (texts joined) |
| assistant `thinking`     | `{type:'thinking', thinking, signature}`; replay only own signature | reasoning item from signature (`{type:'reasoning', id, encrypted_content}`, summary rebuilt from text) | dropped (no reasoning input) |
| assistant `tool_call`    | `{type:'tool_use', id, name, input}`       | item `{type:'function_call', call_id, name, arguments: JSON}` | `tool_calls:[{id, type:'function', function:{name, arguments: JSON}}]` |

Consequences for the neutral shape:
- Tool result output is a string plus `isError`; APIs without an error
  flag fold it into the text.
- The thinking signature is an opaque string owned by one provider. The
  block records which provider produced it (`provider`); other
  providers must not send it (Anthropic rejects foreign signatures,
  Responses needs its own encrypted item). They may drop the block or
  replay its text as plain text.
- Anthropic `redacted_thinking` has no text, only `data`: the Anthropic
  provider stores it as a thinking block with empty text and a
  signature it can recognize (e.g. JSON `{redacted: data}`).
- Responses reasoning can arrive with no summary text: a signature with
  no preceding thinking delta still makes an (empty) thinking block.
- Tool call input is a parsed object. Chat Completions and Responses
  send arguments as JSON text; providers parse it at the end of the
  call, Anthropic's `input_json_delta` likewise.

## Stream → events

Shared code does fetch, non-2xx handling, SSE framing (`event:`,
multi-line `data:`, CRLF, comments) and abort; providers see
`{event, data}` messages with `data` still a string (Chat Completions
ends with a non-JSON `[DONE]`).

| event             | Anthropic                                  | Responses                                   | Chat Completions |
|-------------------|--------------------------------------------|---------------------------------------------|------------------|
| `text` delta      | `content_block_delta` `text_delta`         | `response.output_text.delta` (+ refusal)    | `choices[0].delta.content` |
| `thinking` delta  | `content_block_delta` `thinking_delta`     | `response.reasoning_summary_text.delta`     | `delta.reasoning`/`reasoning_content` (some servers) |
| `signature`       | `signature_delta` (end of thinking block)  | `response.output_item.done` of a reasoning item | — |
| `tool_call` (complete) | `content_block_start` tool_use + `input_json_delta`… + `content_block_stop` | `output_item.added` function_call + `function_call_arguments.delta`… + `output_item.done` | `delta.tool_calls[index]` fragments, emitted at `finish_reason` |
| `usage`           | `message_start.message.usage` (input, cache) then `message_delta.usage` (output, cumulative) | `response.completed.response.usage` | final chunk `usage` (needs include_usage) |
| `done`            | `message_stop`; reason from `message_delta.stop_reason` | `response.completed` / `response.incomplete` | `finish_reason` then `[DONE]` |
| `error`           | `event: error` or HTTP status              | `error`, `response.failed`, HTTP status     | HTTP status, `{error}` chunk |

Stop reasons: `end` (end_turn / stop / completed), `tool_use`
(tool_use / tool_calls / completed with function calls), `max_tokens`
(max_tokens / length / incomplete: max_output_tokens), `refusal`
(refusal / content_filter).

Usage fields are cumulative, so each `usage` event overwrites the
fields it carries: `input` (uncached input), `output`, `cacheRead`,
`cacheWrite`. OpenAI reports cached tokens inside `input_tokens`;
the provider subtracts them.

Every stream ends with exactly one terminal event, `done` or `error`;
shared code adds an error when a provider stops without one, drops
anything after it, and turns an abort into `error` with
`canceled: true`.
