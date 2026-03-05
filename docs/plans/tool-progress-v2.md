# Tool Progress v2: Direct outputLines mutation

## Problem

Cursor-up-erase (`\x1b[NA\x1b[J`) for in-place tool progress updates is fragile:
- `screenFmt.toolProgressLines` gets reset by tab switches, hydration
- Line count must exactly match outputLines entries (off-by-one = permanent drift)
- No recovery once out of sync

## Solution

Replace cursor-up-erase with direct `outputLines` mutation via tracked indices.

### TUI API addition

```ts
// Replace specific lines in outputLines by index range, then re-render
export function updateOutputLines(startIndex: number, lines: string[]): void
```

### Flow

1. First tool_progress event:
   - Append N lines to output normally (no escape sequences)
   - Record the starting outputLines index
   - Store index on the event/format state

2. Subsequent tool_progress events:
   - Use stored index to directly overwrite those outputLines entries
   - Call render()

3. All tools done:
   - Final overwrite with done state
   - Clear stored index

### Where to store the index

The client already tracks per-tab state. Add `toolBlockStart: number | null`
to track where in outputLines the current tool block begins. Since the client
knows both the TUI outputLines and the format state, it can coordinate.

### Changes

1. **tui.ts**: Add `updateOutputLines(start, lines)` + `getOutputLineCount()`
2. **format/index.ts**: Remove cursor-up-erase logic. Return rendered lines.
   `toolProgressLines` becomes just the count (for knowing how many to replace).
3. **client.ts**: Handle tool_progress specially in renderEventToTab —
   first event appends, subsequent events call updateOutputLines.
   Track `toolBlockStart` per tab.
