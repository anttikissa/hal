# TUI Planning

## Current Architecture

The TUI uses a scroll region with a managed footer:
- Rows 1..(rows - footerH) = output scroll region (append-only)
- Footer = activity line + status line + input area
- No alternate screen buffer — output goes to normal terminal scrollback
- Raw mode for input only, not for screen management

## Theme Hot-Reload

Theme system is in place (`themes/*.ason`, loaded at startup via `config.theme`).
Currently themes apply on restart because `tab.output` stores pre-rendered ANSI strings.
To re-theme on the fly, we'd need either:
- Managed mode (alternate screen, we own all rendering) — can redraw everything
- Or accept that theme changes apply to new output only (current behavior)

## Title Bar

A fixed title bar at the top does NOT require managed mode. The scroll region
can be set to `\x1b[2;bottom r` instead of `\x1b[1;bottom r`, reserving row 1
as a pinned title bar. Content scrolls in the middle, title stays put.

## Hal Cursor (Second Cursor)

Goal: show a visible cursor where Hal is outputting, separate from the user's
input cursor.

### Terminal Support for Multiple Cursors

- **Kitty** (v0.43.0+): has a native multiple cursors protocol. Extra cursors
  get real terminal rendering (animation, color auto-adjust, blinking). Protocol
  is still under public discussion (#8927) and subject to change. Extra cursors
  share color/opacity/blink with the main cursor.
- **Ghostty**: no multi-cursor support. Docs explicitly state the terminal API
  "only supports a single cursor at any given moment."
- **Other terminals**: no known support.

### Practical Approach

Since we're on Ghostty, the Hal cursor must be faked:
- Reverse video block (`\x1b[7m▊\x1b[27m`) or similar styled character
- Updated on each output chunk via cursor save/restore (`\x1b[s`/`\x1b[u`)
- In managed mode this is straightforward (redraw on every frame)
- In inline mode it's possible but risks flicker during fast streaming

## Prior Art: .hal9001 TUI History

The older `.hal9001` project went through the full managed-mode journey and back.
Key commits (Feb 16-18, 2026):

### Alternate Screen + Mouse Reporting
- `8c9f07f` — Alternate screen buffer (`\x1b[?1049h`), proper suspend/resume
- `b2cda94` — SGR mouse reporting (`\x1b[?1000h\x1b[?1006h`) for touchpad scroll
  - Batch-processes wheel events for smooth scrolling
  - Text selection via Option/Alt hold on Mac

### Full Mouse Text Selection (~300 lines)
- `8aa918c` — Complete mouse selection implementation:
  - Single click+drag for character selection
  - Double-click for word selection (with word boundary expansion)
  - Triple-click for line selection
  - Drag to extend in any mode
  - Selection rendered with reverse video overlay (`\x1b[7m`/`\x1b[27m`)
  - Preserves underlying ANSI colors during selection rendering
  - Auto-copy to clipboard via `pbcopy` on mouse release
  - Selection clears on any keypress or new output
  - Bracketed paste support (`\x1b[?2004h`)
  - Multi-chunk paste accumulation for large pastes

### OSC 8 Hyperlinks + Cmd-Click
- `d7bbcfc` — URLs in output wrapped with OSC 8 (`\x1b]8;;URL\x07text\x1b]8;;\x07`)
  - Walks string skipping ANSI escapes, linkifies plain text URLs
- `97736b4` — Modifier+click (Cmd/Ctrl/Shift) to open URLs
  - Parses SGR mouse button modifier flags (shift=4, meta=8, ctrl=16)
  - Maps click position to visible output line, strips ANSI, finds URL at column
  - Opens via `open` command
- `494cf25` — Double-click on URLs to open in browser

### Essential Escape Sequences Reference
```
\x1b[?1049h/l          — alternate screen on/off
\x1b[?1000h            — mouse press/release reporting
\x1b[?1002h            — mouse motion (drag) reporting
\x1b[?1006h            — SGR extended mouse mode (coords > 223)
\x1b[?2004h/l          — bracketed paste on/off
\x1b[7m / \x1b[27m     — reverse video on/off (for selection)
\x1b]8;;URL\x07        — OSC 8 hyperlink start
\x1b]8;;\x07           — OSC 8 hyperlink end
\x1b[s / \x1b[u        — cursor save/restore
\x1b[top;bottom r      — set scroll region (DECSTBM)
```

### Why It Was Reverted

The project pivoted away from managed mode in commits `48bcbe4` → `cb654b7`:
- Preserving terminal scrollback was valued over owning the screen
- The "unmanaged transcript + footer" architecture was simpler and inherited by `.hal`

### If We Go Back to Managed Mode

The full implementation exists in `.hal9001` git history and can be adapted.
The main cost is reimplementing: mouse scroll, text selection, clipboard,
link clicking, and bracketed paste. The `.hal9001` code is ~300 lines for
selection alone, plus ~50 for hyperlinks and ~30 for mouse/paste setup.

Total additional code estimate: ~400-500 lines for full managed mode with
all the niceties.
