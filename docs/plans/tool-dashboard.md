# Tool Dashboard for Parallel Tool Calls

## Problem

When multiple tool calls run in parallel (`Promise.all`), their output interleaves
unpredictably in the sequential output stream. No visual grouping or status tracking.

## Solution

When ≥2 tool calls run in parallel, render a compact dashboard in the main output
window. Each tool gets 3 lines that update in-place as tools execute.

### Format

```
  grep  … 2.3s  1.2KB
  │ src/cli/tui.ts:320: render()
  │ src/cli/tui.ts:700: scheduleRender()
  read  ✓ 0.1s  340B
  │ (12 lines read)
  │
  bash  … 5.1s  4.5KB
  │ Running tests...
  │ ✓ 14 passed, 2 failed
```

- Line 1: tool name, status icon (… running, ✓ done, ✗ error), elapsed, bytes
- Lines 2-3: last 2 lines of tool output (dim `│` prefix)
- Dashboard freezes when all tools complete; subsequent output appends below

### In-place updates

Use cursor-up-erase sequences (`\x1b[NA\x1b[J`) already supported by
`appendOutput` in tui.ts. Each dashboard update erases the previous dashboard
and rewrites it. Since tool output is buffered (not published via `publishLine`),
no other output interleaves during parallel tool execution.

## Changes

### 1. protocol.ts

Add `ToolProgressEntry` type and `tool_progress` event to `RuntimeEvent`.

```ts
export interface ToolProgressEntry {
    name: string
    status: 'running' | 'done' | 'error'
    elapsed: number  // ms
    bytes: number
    lastLines: string[]  // last 2 lines of output
}
```

### 2. event-publisher.ts

Add `publishToolProgress(sessionId, tools[])`.

### 3. agent-loop.ts

For ≥2 tool calls:
- Buffer per-tool output (don't `publishLine`)
- Track per-tool state (start time, bytes, last lines)
- Emit `tool_progress` events (throttled to 100ms)
- Still collect `toolLines` for the tool_log entry

Single tool calls: unchanged behavior.

### 4. format/index.ts

- Add `toolDashboardLines: number` to `FormatState`
- Handle `tool_progress` in `pushEvent`:
  - First event: render N×3 lines, set `toolDashboardLines = N*3`
  - Update events: prepend cursor-up-erase, render new dashboard
  - Final event (all done): render final state, set `toolDashboardLines = 0`

### 5. client.ts

Route `tool_progress` events to tabs (add to the findOrCreateTab condition).
No other changes needed — cursor-up-erase already handled by `appendOutput`.
