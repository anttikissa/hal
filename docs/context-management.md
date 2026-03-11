# Context Management

Two mechanisms keep context from blowing up: **pruning** (strip old heavy content each turn) and **compaction** (rotate the session when context gets too large).

Core code: `src/session/prune.ts` (pruning), `src/runtime/commands.ts` (compact/autocompact), `src/runtime/context.ts` (window sizes, estimation).

## Pruning

API messages are pruned before sending to reduce token cost. Without pruning, every past tool result, image, and thinking block would be re-sent on every turn — quadratic cost growth.

`pruneApiMessages()` runs after `loadApiMessages()` builds the message array. Three independent passes strip old heavy content:

### Tool results & inputs

- Finds the **last tool batch** (most recent assistant message with `tool_use` blocks + corresponding `tool_result` messages).
- Keeps that batch in full; clears all older tool results and inputs.
- If the last batch is **stale** (>4 completed turns after it), clears it too.
- Cleared tool results → `[tool result omitted from context — blob <blob-id>; use read_blob if needed]`.
- Cleared tool inputs → `{}` (API requires the field to exist).

### Images

- Keeps images in the **last 4 completed turns**.
- Older images → `[image omitted from context — blob <blob-id>; use read_blob if needed]`.
- Works for images in both regular user messages and `tool_result` messages.
- The `_blobId` field is threaded from blob storage through `loadApiMessages()` so the placeholder can reference the original payload.

### Thinking blocks

- Keeps thinking blocks in the **last 10 user turns**.
- Older thinking blocks are **silently dropped** (no placeholder — thinking is internal reasoning).

### Prune thresholds

| Content | Threshold | Cleared form |
|---------|-----------|-------------|
| Tool results | Last batch only; stale after 4 turns | `[tool result omitted ...]` |
| Tool inputs | Same as results | `{}` |
| Images | 4 completed turns | `[image omitted ...]` |
| Thinking | 10 completed turns | Silently dropped |

Tunable at runtime via `pruneConfig` in `src/session/prune.ts`.

### Why these numbers

- **Images & tool results** (4 turns): Both are heavy (images ~2-3K tokens, tool results 1-10K). Aligned so they clear together — one cache bust instead of staggered ones.
- **Thinking** (10 turns): Hardest to reconstruct. Carries reasoning chain. 200-700 tokens each on average, but compounds across many turns.

## Compaction

When pruning isn't enough and the context window fills up, compaction rotates the session: archive the history file and start fresh with a deterministic summary injected.

### /compact (manual)

1. Rotate `history.asonl` → `historyN.asonl` (N = highest existing + 1).
2. Inject two user messages into the new history:
   - System note: `[system] Session was manually compacted. Previous conversation: <old log>`
   - Context summary: first 10 + last 10 user prompts from the previous session (or all if ≤20).
3. Clear runtime caches.

### Autocompact

Triggers automatically when real API usage reaches **70%** of the model's context window.

- Only fires on real API token counts (never estimates).
- Warning at **65%**: `[context] 65% used — will autocompact at 70%`.
- At 70%: rotates and injects context, then retries the current prompt in the new session.

The context summary (`buildCompactionContext()`) includes:
- A note that context was compacted and to verify before assuming.
- The first line (up to 200 chars) of each user prompt, numbered.
- If >20 prompts: first 10 + last 10 with indices preserved.
- Path to full history files for reference.

### Properties

- **Instant** — no LLM call.
- **Free** — no API cost.
- **Deterministic** — same input always produces same summary.

### Compaction thresholds

| Trigger | Threshold | Source |
|---------|-----------|--------|
| Warning | 65% context used | `runtime.ts` onStatus callback |
| Autocompact | 70% context used | `commands.ts` prompt handler |
| Manual | `/compact` command | `commands.ts` compact handler |

## Cost model

Content in conversation history is **quadratic** — each piece gets re-sent every turn. Prompt caching (90% cheaper) reduces the constant but not the O(n²) shape.

Pruning makes heavy content O(n) by clearing it after a fixed number of turns. Compaction resets the entire context, bounding total accumulation.

What remains quadratic is lightweight text (user messages, assistant responses, placeholders) — small per turn (~500 tokens vs ~5K for a tool result).

In practice, pruning removes **95%+** of tool result bytes across a typical 50-turn session. Compaction prevents the remaining linear growth from eventually exceeding the window.
