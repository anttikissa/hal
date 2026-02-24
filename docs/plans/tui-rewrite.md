# TUI Rewrite Plan

## Goals
1. Fix scrolling bugs (title bar disappears when scrolling up)
2. Full mouse text selection (click, double-click word, triple-click line, drag)
3. State-driven rendering (full redraw each frame — no scroll region races)
4. Proper Ctrl-Z suspend / SIGCONT restore
5. Alternate screen buffer (clean exit restores terminal)
6. Mouse wheel scrolling through output

## Non-Goals
- Kitty keyboard protocol (Ghostty doesn't need it)
- OSC 8 hyperlinks (can add later)
- Hal cursor / second cursor
- Class-based refactor (keep module-level functions for minimal API diff)

## Current Architecture Problems

1. **Scroll regions**: `setScrollRegion(2, bottom)` for title bar at row 1. The output cursor
   is saved/restored with `\x1b7`/`\x1b8`. During concurrent output + typing, the saved
   cursor position can point into the footer area. Resize tries to rewrite from transcript
   but transcript stores pre-wrapped text.

2. **Output storage**: `transcript` is a single string containing pre-wrapped, ANSI-colored text.
   On resize, it's re-split by newlines and tail-sliced, but this loses the original logical
   line structure (a wrapped line becomes multiple lines after split).

3. **No mouse**: No SGR mouse reporting, no selection, no wheel scroll.

4. **Ctrl-Z**: Leaves scroll region set, no alt screen to restore.

## New Architecture

### Core Idea
Single `render()` function that redraws every row from state. No scroll regions.
Alternate screen buffer isolates us from terminal scrollback.

### State Variables
```
outputLines: string[]        // logical lines (unwrapped, with ANSI)
scrollOffset: number         // visual lines scrolled up from bottom (0 = at bottom)
titleBarStr: string
activityStr: string
statusTabsStr, statusRightStr, headerFlash: string
inputBuf, inputCursor: number
// Mouse selection
selAnchor, selCurrent: {row, col} | null
selMode: 'char' | 'word' | 'line'
selActive: boolean
clickCount, lastClickTime, lastClickPos: for multi-click detection
// Render cache
lastVisibleOutput: string[]  // for mouse coordinate mapping
lastOutputHeight: number
wrappedLineCount: number     // cached, invalidated on resize
lastWrapCols: number
```

### Screen Layout
```
Row 1                              = title bar (dim text)
Rows 2..(rows - footerH)          = output viewport (word-wrapped logical lines)
Row (rows - footerH + 1)          = activity line (dim)
Row (rows - footerH + 2)          = status line (─[tabs]── context ─)
Row (rows - footerH + 3)          = dark pad top
Rows (rows - footerH + 4)..       = input lines (dark bg)
Row rows                           = dark pad bottom
```

Footer height = 4 + promptLineCount (same as current).

### render() Flow
1. Hide cursor
2. For each row 1..rows:
   - Row 1: title bar
   - Rows 2..outputBottom: get visible wrapped output lines, draw with selection overlay
   - Activity row: draw activity
   - Status row: draw status/divider
   - Prompt area: dark pads + input lines
3. Position cursor at input
4. Show cursor

### Output Storage
- `outputLines: string[]` — one entry per logical line (no wrapping applied)
- `appendOutput(text)` parses text character by character:
  - `\n` → push new empty line
  - `\r` → clear current line (for progress bars)
  - other → append to current line
- Cap at 10,000 logical lines
- Invalidate wrapped line count cache on append

### Wrapping
- `wrapAnsi(line, maxCols)` → string[] of visual lines
  - Walks character by character, passes ANSI escapes through
  - Tracks visible column count
  - Breaks at spaces when possible (word wrap)
  - Carries ANSI state (SGR sequences) across wrapped lines
  - Falls back to hard break for long words

### Viewport Extraction
- `getVisibleWrapped(outputHeight)` walks `outputLines` backwards,
  wrapping each, collecting visual lines until we have `outputHeight + scrollOffset`
- Slice to get the visible window

### Mouse
- Enable: `\x1b[?1000h\x1b[?1002h\x1b[?1006h` (press + drag + SGR extended)
- Parse SGR mouse: `\x1b[<button;x;y[Mm]`
  - Button 64/65 = wheel up/down → `scroll(±3)`
  - Button 0 = left click/drag/release → selection
- Selection rendering: reverse video (`\x1b[7m`/`\x1b[27m`) overlaid on existing ANSI
- Copy on release via `pbcopy`

### Bracketed Paste
- Enable: `\x1b[?2004h`
- Parse `\x1b[200~`...`\x1b[201~` sequences
- Multi-chunk accumulation (large pastes span multiple data events)

### Suspend/Resume
- Ctrl-Z: disable mouse, leave alt screen, setRawMode(false), SIGSTOP
- SIGCONT: re-enter alt screen, enable mouse, setRawMode(true), render()

## API Surface (all maintained)

### Used by client.ts via `tui.*`:
- `init()`, `cleanup()`
- `write(text)`, `input(promptStr)`, `prompt(message, promptStr)`
- `cancelInput()`
- `clearOutput()`, `replaceOutput(snapshot)`
- `getOutputSnapshot()`, `setOutputSnapshot(snapshot)`

### Used by client.ts via named imports:
- `CTRL_C`
- `flashHeader(text, durationMs)`
- `getInputDraft()`, `setInputDraft(text, cursor)`
- `getInputHistory()`, `setInputHistory(history)`
- `setActivityLine(text)`
- `setEscHandler(handler)`, `setDoubleEnterHandler(handler)`
- `setInputKeyHandler(handler)`, `setInputEchoFilter(handler)`
- `setMaxPromptLines(n)`
- `setStatusLine(tabsStr, rightStr)`
- `setTitleBar(text)`
- `setTabCompleter(fn)`

### Compat wrappers (used internally):
- `setHeader(text)`, `setStatus(text, rightText)`
- `log(...args)`
- `stripAnsi` (re-export)

## Snapshot Format Change

Current: `transcript` is pre-rendered ANSI text with `\r\n` line breaks.
New: `outputLines.join('\n')` — logical lines joined by `\n`.

This is consumed by:
- `captureActiveOutput()` → `tab.output = getOutputSnapshot()`
- `applyActiveTabSnapshot()` → `setOutputSnapshot(tab.output)` or `replaceOutput(tab.output)`
- `hydrateTabsFromRecentLines()` → `tab.output = lines.join('')`
- `Client.getTranscript()` → returns snapshot for debug log
- `renderEventToTab()` → `tab.output += text` (appends formatted text)

The format is internal — `tab.output` is only ever produced by `getOutputSnapshot()`
and consumed by `setOutputSnapshot()`/`replaceOutput()`. The `+= text` path in
`renderEventToTab` appends the same formatted text that would go through `write()`.
So the contract is: snapshot = what `write()` would have received, concatenated.

For `setOutputSnapshot(s)` we need to parse `s` back into logical lines.
Since the snapshot is just the concatenation of all `write()` calls, we use
the same `appendOutput()` parser.

## Implementation Strategy

Do it as a single rewrite of `tui.ts`. The module boundary (exports) stays the same,
so client.ts needs zero changes. Write the whole thing, test manually, commit.
