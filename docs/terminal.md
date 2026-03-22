# Terminal Rendering Rules

Requirements for anyone who touches terminal code.
Implementation: `term.ts` (will move to `src/` later).

These are HOLY TRUTHS that you must obey. You often have a hard time
understanding how terminals work, and especially what the USER wants from a
terminal UI. Read this document to understand the rules of the game.

## Layout

Bottom-anchored, three sections:

```
[history lines...]
[status bar]
[prompt]
```

- **History**: a flat list of lines (user input echoes, assistant responses,
  debug output). Append-only. Each entry is one logical line.
- **Status bar**: single line, currently just shows line count.
- **Prompt**: single line, `> ` followed by user input.

## Rendering: differential

We do NOT clear-and-redraw a viewport-sized window. That destroys scrollback.

Instead:

1. Build the full frame: all history lines + status + prompt.
2. Diff against the previously-painted lines.
3. Find the first changed line.
4. Move the cursor there and rewrite from that point to the end.

New lines are appended with `\r\n`, which lets the terminal scroll naturally.
Old content enters scrollback — the user can scroll up and see everything.

Key state:
- `prevLines[]` — what we painted last time (the full logical array, not a
  viewport slice).
- `cursorRow` — which logical line the terminal cursor is on.

### Force repaint (Ctrl-L)

Clears the visible screen, resets `prevLines` and `cursorRow`, and repaints
everything. Needed when switching to a shorter tab (future) or recovering
from garbled output.

Does NOT clear scrollback.

## Rules

### 1. Don't clear the screen on start

Behave like any well-behaved REPL (perl, node). Output starts at the current
cursor position and flows downward.

### 2. Quit preserves the last frame

On Ctrl-C / Ctrl-D, keep the last rendered content visible for copy/paste.
Do not clear the screen or switch to alternate screen buffer.

### 3. ALWAYS write ALL history lines — NEVER slice to viewport

This is the most important rule. Read it twice.

EVERY render path — normal diff AND force repaint — must write ALL history
lines for the active tab. Not "the last N that fit on screen." Not "starting
from some clever offset." ALL of them. Every. Single. One.

The diff engine exists so that writing all lines is cheap (only changed lines
get rewritten). Force repaint clears scrollback and writes everything fresh.

If you slice history to viewport size, lines that don't fit are never written
to the terminal. They vanish from scrollback. The user scrolls up and sees
garbage from a previous tab mixed with the current one. This has happened
THREE TIMES already. It is the cardinal sin of this renderer.

Do not do it. Not in the normal path. Not in the force path. Not in a helper
function. Not behind a flag. Not "just for performance." NEVER.

### 4. Synchronized output

Wrap paint operations in DEC synchronized output markers (`?2026h` / `?2026l`)
to prevent flicker on terminals that support it. Hide cursor during paint,
show after.
