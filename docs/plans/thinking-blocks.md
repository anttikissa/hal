# Fix: Send thinking blocks back to API

## Problem

We store `thinkingText` in message log but never send it back in API messages.
This breaks tool-use reasoning continuity and may degrade model quality.

## What the API requires

1. **Tool use**: thinking block MUST be sent back for the assistant turn whose tools are being executed (the one right before tool_result messages).
2. **Signature**: thinking blocks have an encrypted `signature` field that must be preserved and sent back verbatim. Without it, the API rejects the thinking block.
3. **Prior turns**: the API auto-strips thinking from older turns (pre-Opus 4.5). Opus 4.5+ retains them in context. Either way, we should send them.

## Changes needed

### 1. Capture signature in anthropic-provider.ts

The stream emits `signature_delta` inside `content_block_delta` just before `content_block_stop`.
We need to capture it and include in the `thinking` event.

ProviderEvent `thinking` type needs a `signature` field.

### 2. Store signature in block or message

Currently `thinkingText` is a plain string on AssistantMessage.
Options:
- a) Store as block file (like tool calls) — `{ thinking: text, signature }` 
- b) Add `thinkingSignature` field to AssistantMessage

Option (b) is simpler — thinkingText is already inline, just add the signature alongside.

### 3. loadApiMessages: include thinking blocks

In the assistant message builder (line 291-300), prepend a thinking block:
```ts
if (msg.thinkingText) {
    content.unshift({ type: 'thinking', thinking: msg.thinkingText, signature: msg.thinkingSignature })
}
```

### 4. agent-loop.ts: capture signature from stream, store it

Already captures `thinkingText`. Just need to also capture signature.

### 5. Compact: clear old thinking blocks

Like images, thinking blocks compound quadratically. We should clear old thinking too.
The API auto-strips old thinking (pre-4.5) so this is mainly for 4.5+.
Use same pattern: `[thinking cleared — ref: ...]` or just omit the block.

Actually — since the API handles this for pre-4.5, and for 4.5+ it wants them, 
maybe just send them all and let the API handle it? Check token accounting.

For now: send all thinking blocks. Optimize later if needed.

## Implementation order

1. Add `signature` to ProviderEvent thinking type
2. Capture signature_delta in anthropic-provider.ts parseStream
3. Add `thinkingSignature` to AssistantMessage
4. Store signature in agent-loop.ts 
5. Include thinking in loadApiMessages
6. Tests
