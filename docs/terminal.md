# Terminal Rendering Rules

Requirements for anyone who touches terminal code.
Implementation: `term.ts` (will move to `src/` later).

These are HOLY TRUTHS that you must obey. You often have a hard time
understanding how terminals work, and especially what the user wants from a
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

## Terminal scrollback: how it actually works

This section exists because we've been bitten by wrong assumptions about
scrollback multiple times. Read it. Understand it. Refer back to it.

### Scrollback is immutable

When output exceeds the terminal height, lines scroll off the top of the
visible screen into the **scrollback buffer**. Once there, they are frozen.
You cannot modify them. Period.

`CSI nA` (cursor up) is **clamped at row 1 of the visible screen**. It will
never move the cursor into the scrollback buffer. If you try `CSI 49A` when
the cursor is 25 rows from the top of the visible screen, it moves up 25
rows — not 49. The remaining 24 rows of movement are silently discarded.

This means: if you wrote 50 lines and 24 scrolled into scrollback, you can
only overwrite the 26 lines still on the visible screen. The 24 in scrollback
are permanent until explicitly cleared.

Verified with `scroll.ts` — a test that writes 50 lines then tries to
`CSI 49A` and rewrite them all:
- **Tall terminal** (all 50 lines visible): all 50 rewritten. Works.
- **Short terminal** (24 lines in scrollback): only the visible 26 are
  rewritten. The 24 in scrollback show the original content.

### Clearing scrollback

The ONLY way to remove content from scrollback is `CSI 3J` (xterm extension,
widely supported). This nukes the entire scrollback buffer — there is no
way to selectively clear parts of it.

### Implications for our renderer

- **Normal diff path**: works fine. New lines are appended via `\r\n` and
  scroll naturally. The diff engine only touches lines on the visible screen
  (recently changed lines near the prompt). Lines in scrollback are old
  history that doesn't need updating.

- **Force repaint (Ctrl-L, tab switch, resize)**: must clear scrollback with
  `CSI 3J` and rewrite ALL lines from scratch. If we don't clear scrollback,
  old content from a previous tab or render will remain there and create a
  confusing interleaved mess when the user scrolls up.

- **Tab switches**: always force repaint. The previous tab's history is in
  scrollback and cannot be overwritten. We must clear it and write the new
  tab's history fresh.
