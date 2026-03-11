# Context Pruning

API messages are pruned before sending to reduce token cost. Without pruning, every past tool result, image, and thinking block would be re-sent on every turn — quadratic cost growth.

Core logic: `src/session/prune.ts`, called from `loadApiMessages()` in `src/session/history.ts`.

## How It Works

`pruneApiMessages()` processes the message array after `loadApiMessages()` builds it. Three independent passes strip old heavy content:

### 1. Tool results & inputs (`pruneApiMessages`)

- Finds the **last tool batch** (most recent assistant message with `tool_use` blocks + corresponding `tool_result` messages).
- Keeps that batch in full; clears all older tool results and inputs.
- If the last batch is **stale** (>4 completed turns after it), clears it too.
- Cleared tool results become `[tool result omitted from context — blob <blob-id>; use read_blob if needed]`.
- Cleared tool inputs become `{}` (API requires the field to exist).

### 2. Images (`stripOldImages`)

- Keeps images in the **last 4 completed turns**.
- Older images become `{ type: 'text', text: '[image omitted from context — blob <blob-id>; use read_blob if needed]' }`.
- Works for images in both regular user messages and `tool_result` messages.
- The `_blobId` field is threaded from blob storage through `loadApiMessages()` so the cleared placeholder can reference the original payload.

### 3. Thinking blocks (`stripOldThinking`)

- Keeps thinking blocks in the **last 10 user turns**.
- Older thinking blocks are **silently dropped** (removed from the assistant message content array). No placeholder — thinking is internal reasoning, not something to reference later.

## Thresholds

| Content | Threshold | Cleared form |
|---------|-----------|-------------|
| Tool results | Last batch only; stale after 4 completed turns | `[tool result omitted from context — blob ...; use read_blob if needed]` |
| Tool inputs | Same as results | `{}` |
| Images | 4 completed turns | `[image omitted from context — blob ...; use read_blob if needed]` |
| Thinking | 10 completed turns | Silently dropped |

## Why These Numbers

- **Images & tool results** (4 turns): Both are heavy (images ~2-3K tokens, tool results 1-10K tokens). Aligned at the same threshold so they get cleared together, causing one cache bust instead of staggered ones.
- **Thinking** (10 turns): Hardest to reconstruct. Carries reasoning chain. 200-700 tokens each on average, but compounds across many turns.

## Cost Model

Content in conversation history is **quadratic** — each piece gets re-sent on every subsequent turn. Prompt caching (90% cheaper) reduces the constant but doesn't change the O(n²) shape. Compaction changes it: cleared content stops compounding, making the effective cost closer to O(n) for heavy content.

What remains quadratic is the lightweight conversation text (user messages, assistant responses, cleared placeholders) — but that's small per turn (~500 tokens vs ~5K for a tool result).

In practice, compaction removes **95%+** of tool result bytes across a typical 50-turn session.
