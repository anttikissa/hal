# Terminal Rendering Rules

Requirements for anyone who touches terminal code.
Implementation: `term.ts` (will move to `src/` later).

These are HOLY TRUTHS that you must obey. You often have a hard time
understanding how terminals work, and especially what the USER wants from a
terminal UI. Read this document to understand the rules of the game.

## Layout

Bottom-anchored, five sections:

```
[history lines...]   — per-tab, append-only, ALL of them
[padding]            — blank lines to stabilize prompt position across tabs
[tab bar]            — [1]  2   3  — brackets for active, spaces for inactive
[status bar]         — line count, peak, mode
[prompt]             — "> " + user input
```

Chrome = tab bar + status + prompt (1+ lines, multiline editing).

## Tabs

Each tab has its own history. Ctrl-T opens, Ctrl-W closes, Ctrl-N/P switches.
Tab bar entries are same width: `[N]` for active, ` N ` for inactive.

### Height management

`peak` is a high-water mark: the tallest any tab's history has ever been.
It grows but never shrinks (even if the tall tab is closed).

Padding = `min(peak, rows - chrome) - activeTab.history.length`. This keeps
the prompt at a stable row when switching between tabs of different heights.

### Tab switching

Always uses force repaint — the diff engine can't reach lines that have
scrolled into the terminal's scrollback buffer.

## Rendering: differential

We do NOT clear-and-redraw a viewport-sized window. That destroys scrollback.

Instead:

1. Build the full frame: all history lines + padding + chrome.
2. Diff against the previously-painted lines.
3. Find the first changed line.
4. Move the cursor there and rewrite from that point to the end.

New lines are appended with `\r\n`, which lets the terminal scroll naturally.
Old content enters scrollback — the user can scroll up and see everything.

Key state:
- `prevLines[]` — what we painted last time (the full logical array, not a
  viewport slice).
- `cursorRow` — which frame line the terminal cursor is physically on.
  Updated after EVERY cursor move (see rule 6).

## Force repaint: two modes

Force repaint happens on Ctrl-L, tab switch, and terminal resize. It has
two modes controlled by the `fullscreen` flag.

### Grow mode (`fullscreen = false`)

The frame fits on screen. Move cursor to top of our content, clear from
there downward (`CSI J`), rewrite all lines. Scrollback is untouched —
pre-app shell history (ls output, etc.) survives. The app behaves like
a normal REPL.

### Full mode (`fullscreen = true`)

The frame has exceeded the terminal height at some point in the past.
Our content is now in the terminal's scrollback buffer, which is immutable
(see below). We MUST clear scrollback (`CSI 3J`) before rewriting, or
the user will see stale content from a previous tab interleaved with
the current one.

**This flag is one-way.** Once `fullscreen` flips true, it stays true
forever. There's no going back — old content is stuck in scrollback and
would create garbage if we tried to preserve it.

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

### 4. No line may exceed terminal width

Every line in the frame array MUST be <= terminal width in visible columns.
The diff engine assumes 1 array entry = 1 physical terminal row. A line
wider than the terminal auto-wraps to multiple rows, breaking cursor
positioning on every subsequent repaint. This causes cascading visual
corruption that gets worse with every paint cycle.

Use `visLen()` to measure, `wordWrap()` to wrap, `clipVisual()` to truncate.
No exceptions.

### 5. Synchronized output

Wrap paint operations in DEC synchronized output markers (`?2026h` / `?2026l`)
to prevent flicker on terminals that support it. Hide cursor during paint,
show after.

### 6. `cursorRow` must always reflect physical cursor position

`cursorRow` tracks which frame line the terminal cursor sits on. Every code
path that moves the cursor — force repaint, diff repaint, cursor-only
repositioning — MUST update `cursorRow` to the final position.

The diff engine uses `cursorRow` to compute how far to move the cursor on
the next paint. If `cursorRow` is stale (e.g. you moved the cursor up for a
multiline prompt but forgot to update the variable), the next paint moves
from the wrong starting position and corrupts the display.

Use `positionCursor(fromRow, target)` which updates `cursorRow` atomically.
Never move the cursor with raw CSI sequences without updating `cursorRow`.

### 7. Compute cursor target ONCE per draw

The cursor's frame position (row, col) should be computed once at the top of
`draw()` and passed to all paint paths. Do NOT compute it separately in each
path — that invites drift between the paths and makes the code harder to
audit.

### 8. Append vs rewrite in the diff engine

When the frame grows (e.g. prompt goes from 1 to 2 lines), the new lines
are beyond `prevLines.length`. You CANNOT use `CSI B` (cursor down) to
move past the bottom of the visible screen — the terminal clamps it. If
you try, the cursor stays on the last visible row and you overwrite the
wrong line.

For appends (`first >= prevLines.length`): move to the last existing line,
then `\r\n` to scroll into new territory.

For frame shrinks (`lines.length < prevLines.length`): after writing new
content, `\r\n` then `CSI J` to erase leftover rows.

### 9. Frame shrinks in fullscreen → force repaint

When the frame shrinks in fullscreen mode (e.g. multiline prompt collapses
to single line), the diff engine cannot recover. Lines that were in
scrollback shift into the visible area, but the diff's line→row mapping
is based on the old layout. The only safe fix is a force repaint that
clears scrollback and rewrites everything.

Frame growth in fullscreen is OK — new lines at the bottom scroll
naturally via `\r\n`, and changed lines are always in the visible area
(near the prompt).

### 10. Kitty keyboard protocol

Ghostty, Kitty, and iTerm intercept Cmd+C/X/V at the OS level. To receive
these keys, the app must opt into the Kitty keyboard protocol with
`CSI >19u` (mode 19 = disambiguate + report events + report all keys).
Disable with `CSI <u` on ALL exit paths, or the terminal stays in protocol
mode after the app exits.

Bracketed paste (`CSI ?2004h`) should also be enabled so multi-line pastes
arrive as a single token.

### 11. Paint throttle — NEVER draw synchronously from event handlers

During streaming, the server emits a `stream-delta` event for every token.
Each event triggers `onChange()`. If `onChange` calls `draw()` synchronously,
the event loop is saturated with frame builds + stdout writes, and stdin
events (keypresses) **never fire**. The user cannot type, abort, or even
Ctrl-C while the assistant is generating.

**Fix**: `draw()` in `cli.ts` uses a trailing-edge throttle. Non-force draws
are coalesced to at most one per 16ms (~60 fps). Force draws (tab switch,
resize, Ctrl-L) execute immediately.

**NEVER remove this throttle.** If you think a draw needs to be synchronous,
you are wrong — use `draw(true)` for a force paint, which already bypasses
the throttle. If you add a new `onChange()` call site, it automatically
benefits from the throttle.

Background-tab `stream-delta` / `stream-end` updates should also skip repaint
entirely. Their history is invisible until tab switch, so redrawing the active
tab is wasted work.

This was discovered the hard way: without throttling, keypresses were
completely unresponsive during assistant output.

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

Verified experimentally — write 50 lines then try `CSI 49A` and rewrite
them all:
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

- **Force repaint in grow mode**: frame fits on screen. Move up, clear down,
  rewrite. Scrollback untouched.

- **Force repaint in full mode**: frame has exceeded terminal height at some
  point. Must `CSI 3J` to clear scrollback, then rewrite ALL lines.

- **Tab switches**: always force repaint. The mode determines whether
  scrollback is cleared.
