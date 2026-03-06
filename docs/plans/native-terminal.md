# Native Terminal TUI (drop alternate screen)

## Summary

Replace Hal's alternate-screen TUI with a native terminal approach (like Pi).
Content flows into the normal scrollback buffer. The terminal handles scrolling,
text selection, and link hover natively. A scroll region pins the prompt/status
bar at the bottom.

This eliminates ~550 LOC of mouse handling, custom selection, custom scrolling,
hover-link detection, and alternate screen management. It enables Pi-style
in-place tool block expansion (the main motivation).

## What we gain

- **In-place tool block expansion**: tool output blocks grow while subsequent
  blocks sit below them. This is trivial when content is just appended lines —
  rewrite the changed region with cursor-up, everything below shifts naturally.
- **Native text selection**: terminal handles it, no mouse capture needed.
- **Native scrolling**: trackpad/scrollbar, no scroll offset tracking.
- **Native link hover**: Cmd+hover on OSC-8 links works in Ghostty/kitty.
- **Content survives in scrollback** within a tab session.
- **Simpler render loop**: append + diff, not full-frame repaint.

## What we lose (acceptable)

- **Title bar**: remove it. Use terminal title (OSC sequence) for session info.
- **Custom mouse selection**: replaced by native selection (better).
- **Custom hover underline**: replaced by native OSC-8 hover (same or better).
- **Custom scroll offset**: replaced by native scrollback (better).
- **Clean viewport on exit**: content stays in scrollback (feature, not bug).

## Architecture

### Scroll regions

`\x1b[1;Nr` where N = height - bottom_bar_rows. Content in the scroll region
scrolls naturally. Bottom bar (status + prompt) is painted at absolute row
positions outside the region. Verified in cli-test.ts prototype.

### Bottom bar

Painted with absolute cursor positioning (`\x1b[row;1H`). Save/restore cursor
(`\x1b7`/`\x1b8`) preserves the content write position. Two paint modes:

- `paintBottom()` — leaves cursor on prompt line (for user input).
- `paintBottomKeepContentCursor()` — restores content cursor (for background
  writes like streaming tool output).

### Tab switching

Clear scrollback + screen (`\x1b[3J\x1b[2J\x1b[H`), replay last 2× screen
height of the target tab's buffered lines. Each tab stores its `lines: string[]`.
User loses cross-tab scrollback — acceptable tradeoff.

### Content writing

No absolute positioning for content. Just `stdout.write(text + '\r\n')` at the
current cursor position. The scroll region handles overflow. This is the key
simplification vs the current approach.

### In-place tool block expansion (Pi's killer feature)

When streaming tool results:

1. Each tool call creates a "block" in the output — a header line + output lines.
2. As output streams in, rewrite the block using cursor-up (`\x1b[NA`) to the
   block start, then re-emit all lines. Content below shifts down naturally
   because the scroll region handles it.
3. Multiple parallel tool calls: all blocks are appended when the assistant
   message finishes streaming. Each block updates independently. Only the
   currently-executing block grows; others are static.
4. When a tool finishes, its block becomes static (no more rewrites).

This replaces the current `updateOutputLines()` hack + `toolBlockStart` tracking
in client.ts.

### OSC-8 links

All file paths and URLs emitted as OSC-8 hyperlinks:
`\x1b]8;;URL\x07display text\x1b]8;;\x07`. The terminal handles hover
underline and Cmd+click. File paths use `file:///absolute/path`. Verified
in cli-test.ts prototype — works for .ts, .txt, .png files.

### Tab stops

Set custom tab stops with `\x1b[3g` (clear all) + `\x1bH` at each N-column
position. Literal `\t` characters render at correct width and copy-paste
preserves them.

## Code impact

### Delete (~550 LOC)

| File | What | LOC |
|---|---|---|
| tui.ts | Mouse event handling (`handleMouseEvent`, `enableMouse`, `disableMouse`) | ~80 |
| tui.ts | Selection state + rendering (`renderLineWithSelection`, `getSelectionRange`, helpers) | ~120 |
| tui.ts | Hover link detection (`updateHoverLink`, `pointFromScreenCoords`) | ~25 |
| tui.ts | Scroll offset tracking (`scroll()`, `getTotalVisualLines`, `getVisibleWrapped`) | ~30 |
| tui.ts | Alternate screen enter/exit, `dumpAndLeaveAltScreen` | ~15 |
| tui.ts | Fixed-grid `render()` (title bar, viewport painting, absolute row positioning) | ~85 |
| tui-links.ts | URL detection, linkification, hit-testing (128 LOC, most of it) | ~100 |
| clipboard.ts | Selection-to-clipboard support | ~43 |
| client.ts | `updateOutputLines`, `toolBlockStart` tracking | ~30 |
| client.ts | Output save/restore (`getOutputSnapshot`/`setOutputSnapshot` for tab switch) | ~20 |

### Modify

| File | What |
|---|---|
| tui.ts | Replace `render()` with scroll-region-based approach. New `paintBottom()`. Remove `outputLines` flat buffer, replace with per-tab line arrays. |
| client.ts | Replace `renderEventToTab` tool_progress handling. Tab switch uses clear+replay. |
| format/index.ts | `renderToolBlock` simplified — just returns lines, no cursor-up-erase. Tool blocks managed by client. |
| tui-links.ts | Reduce to just `osc8()` helper (~5 LOC). Delete URL detection/hit-testing. |

### Add (~200-300 LOC)

- Scroll region setup/teardown
- `paintBottom()` / `paintBottomKeepContentCursor()`
- Tab switch clear+replay
- Tool block rewrite logic (cursor-up + re-emit)
- OSC-8 link wrapping for file paths

### Net result

~550 deleted, ~300 added = **~250 LOC saved**, plus dramatically simpler
rendering and the Pi-style tool expansion feature.

## Prototype

`cli-test.ts` in repo root. Demonstrates:
- Scroll regions with fixed bottom bar
- Tab switching with clear+replay
- Content flowing naturally into scrollback
- OSC-8 links (https + file://)
- Tab stops at custom width
- Input on bottom line with visible cursor
- Auto-tick lines (background content writes)

## Open questions

- **Cursor animation**: the Hal blinking cursor currently renders in the output
  area. In native terminal mode, we'd render it on the prompt line only (simpler).
  The "hal is thinking" indicator could be a spinner in the status bar instead.
- **Resize handling**: scroll region needs re-setting on resize. Bottom bar
  needs repaint. Content position may shift — acceptable if we just repaint
  the bar.
- **Wrap-aware line counting**: when replaying on tab switch, long lines wrap.
  The 2× screen height replay budget handles this generously.

## Sequence

1. Get cli-test.ts prototype solid (current state: mostly working).
2. Fork tui.ts — strip alternate screen, mouse, selection, scroll, hover.
3. Implement scroll region + `paintBottom()` in tui.ts.
4. Implement tab clear+replay in client.ts.
5. Implement tool block expansion (cursor-up rewrite).
6. Convert all file path output to OSC-8 links.
7. Delete dead code (tui-links.ts gutting, clipboard.ts removal).
8. Update docs/tui.md.
