# Context Compaction

API messages are compacted before sending to reduce token cost. Without compaction, every past tool result, image, and thinking block would be re-sent on every turn — quadratic cost growth.

Core logic: `src/session/compact.ts`, called from `loadApiMessages()` in `src/session/messages.ts`.

## How It Works

`compactApiMessages()` processes the message array after `loadApiMessages()` builds it. Three independent passes strip old heavy content:

### 1. Tool results & inputs (`compactApiMessages`)

- Finds the **last tool batch** (most recent assistant message with `tool_use` blocks + corresponding `tool_result` messages).
- Keeps that batch in full; clears all older tool results and inputs.
- If the last batch is **stale** (>4 user turns after it), clears it too.
- Cleared tool results become `[cleared — ref: <block-ref>]` — the model can still read the block file if needed.
- Cleared tool inputs become `{}` (API requires the field to exist).

### 2. Images (`stripOldImages`)

- Keeps images in the **last 4 user turns**.
- Older images become `{ type: 'text', text: '[image cleared — ref: <ref>]' }`.
- Works for images in both regular user messages and `tool_result` messages.
- The `_ref` field is threaded from block storage through `loadApiMessages` so the cleared placeholder can reference the original.

### 3. Thinking blocks (`stripOldThinking`)

- Keeps thinking blocks in the **last 10 user turns**.
- Older thinking blocks are **silently dropped** (removed from the assistant message content array). No placeholder — thinking is internal reasoning, not something to reference later.

## Thresholds

| Content | Threshold | Cleared form |
|---------|-----------|-------------|
| Tool results | Last batch only; stale after 4 user turns | `[cleared — ref: ...]` |
| Tool inputs | Same as results | `{}` |
| Images | 4 user turns | `[image cleared — ref: ...]` |
| Thinking | 10 user turns | Silently dropped |

## Why These Numbers

- **Images & tool results** (4 turns): Both are heavy (images ~2-3K tokens, tool results 1-10K tokens). Aligned at the same threshold so they get cleared together, causing one cache bust instead of staggered ones.
- **Thinking** (10 turns): Hardest to reconstruct. Carries reasoning chain. 200-700 tokens each on average, but compounds across many turns.

## Cost Model

Content in conversation history is **quadratic** — each piece gets re-sent on every subsequent turn. Prompt caching (90% cheaper) reduces the constant but doesn't change the O(n²) shape. Compaction changes it: cleared content stops compounding, making the effective cost closer to O(n) for heavy content.

What remains quadratic is the lightweight conversation text (user messages, assistant responses, cleared placeholders) — but that's small per turn (~500 tokens vs ~5K for a tool result).

In practice, compaction removes **95%+** of tool result bytes across a typical 50-turn session.
