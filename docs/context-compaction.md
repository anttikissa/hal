# Context Compaction

API messages are compacted before sending to reduce token cost. Without compaction, every past tool result, image, and thinking block would be re-sent on every turn — quadratic cost growth.

Core logic: `src/session/compact.ts`, called from `loadApiMessages()` in `src/session/messages.ts`.

## How It Works

`compactApiMessages()` processes the message array after `loadApiMessages()` builds it. Three independent passes strip old heavy content:

### 1. Tool results & inputs (`compactApiMessages`)

- Finds the **last tool batch** (most recent assistant message with `tool_use` blocks + corresponding `tool_result` messages).
- Keeps that batch in full; clears all older tool results and inputs.
- If the last batch is **stale** (>5 user turns after it), clears it too.
- Cleared tool results become `[cleared — ref: <block-ref>]` — the model can still read the block file if needed.
- Cleared tool inputs become `{}` (API requires the field to exist).

### 2. Images (`stripOldImages`)

- Keeps images in the **last 3 user turns**.
- Older images become `{ type: 'text', text: '[image cleared — ref: <ref>]' }`.
- Works for images in both regular user messages and `tool_result` messages.
- The `_ref` field is threaded from block storage through `loadApiMessages` so the cleared placeholder can reference the original.

### 3. Thinking blocks (`stripOldThinking`)

- Keeps thinking blocks in the **last 10 user turns**.
- Older thinking blocks are **silently dropped** (removed from the assistant message content array). No placeholder — thinking is internal reasoning, not something to reference later.

## Thresholds

| Content | Threshold | Cleared form |
|---------|-----------|-------------|
| Tool results | Last batch only; stale after 5 user turns | `[cleared — ref: ...]` |
| Tool inputs | Same as results | `{}` |
| Images | 3 user turns | `[image cleared — ref: ...]` |
| Thinking | 10 user turns | Silently dropped |

## Why These Numbers

- **Images** (3 turns): Supplementary context. Typical use: paste screenshot, ask 2-3 questions. ~2-3K tokens each.
- **Tool results** (5 turns / last batch): Working data the model needs for follow-up. Can be large (1-10K tokens each). Cleared aggressively because sessions typically have 150-280 tool calls.
- **Thinking** (10 turns): Hardest to reconstruct. Carries reasoning chain. 200-700 tokens each on average, but compounds across many turns. On Opus 4.5+, thinking is retained in context (not auto-stripped like pre-4.5).

## Cost Model

Content in conversation history is **quadratic** — each piece gets re-sent on every subsequent turn. Prompt caching (90% cheaper) reduces the constant but doesn't change the O(n²) shape. Compaction changes it: cleared content stops compounding, making the effective cost closer to O(n) for heavy content.

What remains quadratic is the lightweight conversation text (user messages, assistant responses, cleared placeholders) — but that's small per turn (~500 tokens vs ~5K for a tool result).

In practice, compaction removes **95%+** of tool result bytes across a typical 50-turn session.
