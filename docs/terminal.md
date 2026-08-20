# Terminal Rendering Rules

Requirements for anyone who touches terminal code.
Implementation: `src/client/terminal/`.

These are HOLY TRUTHS that you must obey. You often have a hard time
understanding how terminals work, and especially what the USER wants from a
terminal UI. Read this document to understand the rules of the game.

## Layout

Bottom-anchored sections:

```
[history lines...]   — per-tab, append-only, ALL of them
[padding]            — blank lines to stabilize prompt position across tabs
[tab bar]            — " Tabs: [1]  2" plus tab-specific hints when they fit
[prompt top rule]    — one full-width rule on the prompt blue background; shows ↑N when prompt rows are hidden above
[prompt]             — user input, blue bg, padded one column on each side
[prompt bottom rule] — one full-width rule on the prompt blue background; shows ↓N when prompt rows are hidden below
[status bar]         — left: session/cwd/model/context; right: role/usage/subscription
[help bar]           — prompt-specific key hints, always one row (even when empty)
```

Chrome = tab bar + prompt box + status + help bar.

### Horizontal box model

Every ordinary section — history blocks, prompt, status, help — uses the same one
column of padding on each side. For a terminal of `cols` columns:

```
col 0          left padding (always blank)
col 1..cols-2  content — text starts and ends here
col cols-1     right padding (always blank)
```

Ordinary content width is `cols - 2`, and ordinary text must not occupy the last
column. An over-width source line containing only a plain HTTP(S) URL is the
deliberate exception: it has no horizontal margins and may exceed `cols`, so the
terminal soft-wraps and copies it as one logical line. Backgrounds still paint
every physical row, including the final wrapped row's unused columns.

Two painters implement this, and they are deliberately not shared:

- `bgLine()` in `src/client/terminal/blocks.ts` fills the rest of the row with `CSI K`
  (erase to end of line) while the background color is active. History is
  append-only and fully rewritten by the diff engine on every paint, so this
  is far cheaper than emitting explicit spaces.
- `paddedLine()` in `src/client/terminal/render-status.ts` pads with real spaces,
  because chrome rows compose segments with different backgrounds and `CSI K`
  would flood the row with whichever background happened to be active.
- `bodyLine()` in `src/client/terminal/blocks.ts` handles the standalone-URL
  exception: one OSC 8 link stays open across native wraps, then `CSI K` paints
  the remainder of its final physical row before the background is reset.

Do not "unify" these into one helper with a mode flag: it adds code and slows
down the hottest repaint path. Do keep their widths in agreement.

## Tabs

Each tab has its own history. Ctrl-T opens, Ctrl-W closes, Ctrl-N/P switches.
The tab bar uses compact numeric labels, brackets for the active tab, and a
one-character status indicator after the tab number when needed. With one tab,
it shows creation hints such as `ctrl-t: new`; with multiple tabs, it switches
to navigation hints such as `alt-#: goto` and `ctrl-n/p: switch`. It stays one
row: tab-specific hints are dropped from lowest to highest priority, then the
"Tabs:" label is dropped, rather than wrapping.

### Text tab characters

Prompt buffers preserve literal `\t` characters and display them at four-column
tab stops. Frame lines must contain the corresponding spaces, not raw terminal
tab controls; otherwise terminal state and selection styling can change their
physical width behind the renderer's back.

Source offsets and display columns are different coordinate systems. `.length`
is valid for slicing the source buffer, but never for cursor columns, wrapping,
clipping, or padding. Those calculations must use `visLen()` and the shared
width-aware string helpers. Vertical cursor movement keeps its visual column;
when that column falls inside a tab or another multi-column glyph, use the
nearest valid source boundary.

### Height management

`peak` is a high-water mark: the tallest any tab's history has ever been.
It grows but never shrinks (even if the tall tab is closed).

Padding = `min(peak, rows - chrome) - activeTab.historyPhysicalHeight`. Physical
height is derived from the current frame and terminal width; it is never stored
on history blocks or URL lines. This keeps the prompt stable across tabs.

### Tab switching

Always uses force repaint — the diff engine can't reach lines that have
scrolled into the terminal's scrollback buffer.

## Rendering: differential

We do NOT clear-and-redraw a viewport-sized window. That destroys scrollback.

Instead:

1. Build the full frame: all history logical lines + padding + chrome.
2. Diff its logical strings against the previously-painted frame.
3. Find the first changed logical line.
4. Derive its physical row from the unchanged prefix and rewrite to the end.

New logical lines are appended with `\r\n`, which lets the terminal scroll
naturally. A standalone URL may occupy several physical rows without internal
newlines. Old content enters scrollback for the user to inspect.

Key state:
- `prevLines[]` — the full logical frame painted last time, not a viewport slice.
- `cursorRow` — the terminal cursor's physical row within the rendered frame.
  Logical indices are translated by summing `physicalRows()` over their prefix.
  Update it after EVERY cursor move (see rule 6).

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

### 4. Only standalone plain URLs may exceed terminal width

Ordinary frame lines MUST be at most terminal width in visible columns. Use
`visLen()` to measure, `wordWrap()` to wrap, and `clipVisual()` to truncate.

A completed source line consisting solely of a plain HTTP(S) URL is the one
exception. Keep it as one logical frame string and let the terminal soft-wrap it,
so native selection copies the URL without inserted newlines. Streaming URLs
remain hard-wrapped until complete, ensuring a soft logical line is immutable.
`physicalRows()` derives its height using `ceil(visLen(line) / cols)`. This
assumes URL labels contain only single-column printable characters; do not extend
the exception to arbitrary prose, code, tabs, or wide characters.

Diffing remains logical, while cursor positioning, peak/padding, fullscreen
thresholds, and shrink/growth decisions always use derived physical heights.

### 4a. Terminal colors come from `colors.ason`

Do not hard-code RGB colors, 16/256-color ANSI codes, or named ANSI color
choices in terminal UI code. Define color choices as OKLCH triples in
`colors.ason`, load them through `src/client/terminal/colors.ts`, and use the exported
`colors` object at render time. Mixing raw ANSI colors with OKLCH-derived
colors makes the palette inconsistent and hard to tune.

ANSI reset/style/control sequences are different from color choices: use them
when needed to end styling or control the terminal, but do not use them to pick
foreground/background colors.

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

When the frame grows, appended logical lines may be beyond `prevLines.length`.
You CANNOT use `CSI B` past the bottom of the visible screen because the terminal
clamps it. Move to the last existing **physical** row, then use `\r\n` to append
and scroll naturally.

For non-fullscreen frame shrink, compare physical heights. After writing new
content, use `CR`, `CSI 1B`, then `CSI J` to erase leftover rows. Do not use
`\r\n` there: at the viewport bottom it scrolls and creates a stray blank row.

### 9. Automatic fullscreen recovery must preserve inspected scrollback

A fullscreen shrink changes the scrollback/visible boundary. An automatic repaint
must **never** call the fullscreen force-repaint path: it emits `CSI 2J` and
`CSI 3J`, and Ghostty snaps a user who is reading scrollback to the live bottom
(`CSI 3J` also destroys that scrollback). This bit us again when prompt clearing
on submit shrank a fullscreen frame.

Instead, derive the visible physical rows, return to column one, and use a relative
cursor-up move by the terminal height (which clamps at the physical viewport top),
then rewrite each row with `CSI 2K`; do not append a final CRLF. Do **not** use
`CSI H`: Ghostty follows cursor-home by returning an inspected viewport to live
output too. The recovery temporarily hard-wraps a native-wrapped URL into
independently addressable OSC 8 rows, just as popup layout does. Ordinary rendering must
still leave completed standalone URLs native-wrapped for copy/paste; the recovery is the
exceptional safe rewrite.

This rule also covers popup open/close, which changes the URL layout. Only an
explicit full rebuild — Ctrl-L, tab switch, or terminal resize — may use the
fullscreen force-repaint path. Never invoke that path from prompt, streaming,
tool, animation, or popup updates.

Fullscreen growth is straightforward only for a pure append. If an existing
logical line also changes, use the same clamped relative move to the physical
viewport top, repaint independently addressable logical lines, then append the
suffix with `\r\n`. If a soft-wrapped URL begins above the viewport, leave its
unchanged visible tail alone and start at the next complete logical line.

Parallel tool output/result events must become visible in original call order. If a
later card expands first and an earlier card expands afterward, the later copy may
already be immutable in scrollback; no ANSI repaint can then remove the duplicate.

### 10. Kitty keyboard protocol

Ghostty, Kitty, and iTerm intercept Cmd+C/X/V at the OS level. To receive
these keys, the app must opt into the Kitty keyboard protocol with
`CSI >17u` (mode 17 = disambiguate + report all keys; no release events).
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

**Fix**: `draw()` in `src/client/terminal/cli.ts` uses a trailing-edge throttle. Non-force draws
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
