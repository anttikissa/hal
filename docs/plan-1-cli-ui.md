# Plan 1/7: CLI/UI Remaining

## Overview
Finish the visual layer: tab completion, help bar, tool output formatting, and polish.
Budget: ~350 lines added. Current total: 2,985. Target after: ~3,335.

## Subplans

### 1a. Tab Completion (~120 lines)

**File:** `src/cli/completion.ts`

Port from `prev/src/cli/completion.ts` (210 lines), simplify.

Completions needed:
- `/commands` — match against known slash command names
- Model names — match against known model strings
- File paths — complete relative paths from cwd

Architecture:
- `complete(text: string, cursor: number): CompletionResult | null`
  Returns { items: string[], prefix: string, start: number }
- `applyCompletion(text: string, cursor: number, item: string): { text: string, cursor: number }`
- Display: render completion popup as overlay lines in the prompt area

**Wire into keys.ts (~30 lines):**
- Tab key triggers completion
- Arrow keys / Tab cycle through items
- Enter / Space accepts completion
- Escape cancels

**Reference:** `prev/src/cli/completion.ts` for the logic.

### 1b. Help Bar (~50 lines)

**File:** `src/cli/help-bar.ts`

Bottom status bar showing context-sensitive keybindings.
Port from `prev/src/cli/help-bar.ts` (70 lines), simplify.

- Shows available keybindings based on current mode (normal, completion, etc.)
- Rendered as a single line below the tab bar, above the prompt
- Format: `^T new  ^W close  ^N/P tabs  ^R restart  ^L redraw`
- Uses colors.ts for dimmed styling

**Wire into render.ts (~5 lines):**
- Add help bar line to the chrome section between status bar and prompt

### 1c. Tool Output Formatting (~80 lines)

**Expand `blockContent()` in `src/cli/blocks.ts` (~60 lines):**

Currently blocks.ts handles basic text blocks. Add formatting for tool call results:
- Bash output: show command, exit code, truncated output with line numbers
- Read: show file path, line range, syntax-colored content (basic)
- Write/Edit: show file path, diff-style coloring (+ green, - red)
- Truncation: cap at configurable max lines, show "[N more lines]"

**Command status indicators (~20 lines):**
- Spinner for in-progress tool calls (rotating chars: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
- Elapsed time counter
- Exit code display (green 0, red non-zero)

**Reference:** `prev/src/cli/tool-format.ts` (89 lines) for formatting logic.

### 1d. Polish (~70 lines)

**Queue indicator (~20 lines) in blocks.ts or render.ts:**
- Show "⏳ 2 pending" when messages are queued but not yet processed
- Port from `prev/src/cli/queue.ts` (62 lines), simplify to just the indicator

**Key usage display (~30 lines):**
- Show token count and cost in the status bar
- Format: "1.2k tokens · $0.03"
- Port from `prev/src/cli/key-usage.ts` (74 lines)
- Wire: add to status bar in render.ts

**Draft save/restore (~20 lines):**
- When switching tabs, save current prompt text
- When switching back, restore it
- Port from `prev/src/cli/draft.ts` (52 lines)
- Store drafts as Map<sessionId, string> in prompt module

## Module convention reminder
All new files must export a single mutable namespace object.
```ts
export const completion = { complete, applyCompletion, ... }
```

## Testing
- After implementation, run `bun test` to ensure existing 198 tests pass
- Run `bun cloc` to verify line count stays within budget
