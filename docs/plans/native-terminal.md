# Native Terminal TUI (drop alternate screen)

## Summary

Replace Hal's alternate-screen TUI with a Pi-style diff-rendered approach.
No alternate screen, no scroll regions, no absolute row positioning. The entire
UI is a flat `string[]` — content lines + tab bar + prompt — diff-rendered with
relative cursor moves. The terminal handles scrolling, text selection, and link
hover natively.

This eliminates ~550 LOC of mouse handling, custom selection, custom scrolling,
hover-link detection, and alternate screen management. It enables Pi-style
in-place tool block expansion (the main motivation).

## What we gain

- **In-place tool block expansion**: tool output blocks grow while subsequent
  blocks sit below them. The diff renderer rewrites only changed lines;
  everything else stays in place.
- **Native text selection**: terminal handles it, no mouse capture needed.
- **Native scrolling**: trackpad/scrollbar, no scroll offset tracking.
- **Native link hover**: Cmd+hover on OSC-8 links works in Ghostty/kitty.
- **Content survives in scrollback** within a tab session.
- **Simpler render loop**: diff changed lines, not full-frame repaint.

## What we lose (acceptable)

- **Title bar**: remove it. Use terminal title (OSC sequence) for session info.
- **Custom mouse selection**: replaced by native selection (better).
- **Custom hover underline**: replaced by native OSC-8 hover (same or better).
- **Custom scroll offset**: replaced by native scrollback (better).
- **Clean viewport on exit**: content stays in scrollback (feature, not bug).

## Architecture

### Diff renderer (proven in cli-test.ts)

The core rendering approach, adapted from Pi's `doRender()`:

1. `buildLines()` produces the **entire UI** as a flat `string[]` — content
   lines, tab bar, borders, prompt. No split between "content area" and
   "fixed area."
2. `doRender()` diffs `newLines` vs `previousLines`, finds `firstChanged` /
   `lastChanged`, uses **relative cursor moves** (`\x1b[NA` / `\x1b[NB`) to
   navigate to the changed region, rewrites only those lines.
3. First render writes everything inline from the current cursor position.
   No screen clearing — starts right after the shell prompt.
4. **Viewport overflow**: when `firstChanged` is above the visible viewport
   (content scrolled into terminal scrollback), falls back to full clear +
   render (`\x1b[3J\x1b[2J\x1b[H`). This handles tab switching when the
   previous tab had more content than the screen height.
5. **Single `stdout.write` per render** — entire buffer built as a string,
   wrapped in synchronized output (`\x1b[?2026h` / `\x1b[?2026l`).
6. Cursor tracking: `hardwareCursorRow` tracks actual terminal cursor position.
   All movement is relative from this. Never absolute row positioning.

### Tab switching

Tabs are handled entirely by the diff renderer. Switching tabs changes
`activeIdx`, then `doRender()` diffs the new tab's content against the old
tab's rendered lines. When content exceeds screen height, the viewport-overflow
check triggers a full clear + render.

Content padding: shorter tabs are padded with empty lines to match the tallest
tab, so the prompt area stays at the same vertical position when switching.

### Prompt area

The prompt is not a "fixed region" — it's just the last few lines of the
`buildLines()` array:

```
[content lines...]
[empty padding to match tallest tab]
tabs: [ 1 ]  2    3
────────────────────────────────────
> user input here
──────── ctrl-t new tab │ ... ──────
```

When content grows, the prompt shifts down naturally via `\r\n`. The diff
renderer handles this without special cases.

### In-place block expansion (Pi's killer feature)

When streaming tool results, each tool call is a "block" in the content lines.
As output streams in, the block's lines grow. `buildLines()` returns more lines
than before. The diff renderer finds the changed range and appends the new lines
with `\r\n` — everything below (tab bar, prompt) shifts down naturally.

Multiple tool calls running: all blocks exist in the content array. Only the
active block grows; the diff renderer rewrites just the changed region.

### OSC-8 links

All file paths and URLs emitted as OSC-8 hyperlinks:
`\x1b]8;;URL\x07display text\x1b]8;;\x07`. The terminal handles hover
underline and Cmd+click. File paths use `file:///absolute/path`.

## Prototype status

`cli-test.ts` (213 LOC) — fully working prototype demonstrating:
- Pi-style diff renderer with relative cursor moves
- Tab switching with content padding (prompt stays in place)
- Inline start (no screen clearing, starts after shell prompt)
- Viewport overflow fallback (full clear when changes above viewport)
- Single `stdout.write` per render with synchronized output
- Help text embedded in bottom border
- Input editing with cursor on prompt line

## Prototype next steps

Features to prototype before building the real TUI:

1. **Advanced prompt editing**: cursor movement (left/right/home/end), word
   jump, selection, delete word, history — verify this works within the diff
   renderer (only the prompt line changes on keystroke).

2. **Fake cursors in output**: a secondary cursor (blinking block/bar) rendered
   in the content area to show "model is thinking" / streaming position. Also
   mini status indicators in the tab bar (e.g. spinner per tab). These are just
   characters in the `buildLines()` output that change on a timer — the diff
   renderer handles the update efficiently (single line change).

3. **Block renderer with line diffing**: render tool call blocks (bash output,
   file edits, etc.) as structured content. Test in-place expansion — a block
   starts as a header line, then grows as output streams. The diff renderer
   should handle this naturally since it's just the content lines array growing.
   Test editing blocks in place (e.g. updating a progress line within a block).

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

### Net result

~550 deleted. New diff-renderer TUI estimated at ~300 LOC (cli-test.ts is
213 LOC with fake content generation). **Net ~250 LOC saved**, plus the
Pi-style block expansion feature and dramatically simpler rendering.

## Build sequence

1. ✅ Prototype diff renderer (cli-test.ts — done, working)
2. Prototype advanced prompt editing in cli-test.ts
3. Prototype fake cursors (output cursor, tab spinners)
4. Prototype block renderer with in-place expansion
5. Build `src/cli/tui2.ts` from prototype — wire to IPC client
6. Migrate `client.ts` to new renderer
7. Delete old TUI code (tui.ts mouse/selection/scroll, clipboard.ts, tui-links.ts)
8. Update docs/tui.md
