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

### Terminal buffer, writable screen, scrollback buffer, and viewport

Terminal terminology is not perfectly standardized. In this document, the
**terminal buffer** means the complete ordered sequence of physical rows that
Hal has put in the terminal. It comprises:

- the **scrollback buffer**: older rows above the cursor-addressable screen; and
- the **writable screen**: the final `process.stdout.rows` rows, which cursor
  movement can address.

The **viewport** is only the window the user is currently looking through. It
usually shows the writable screen, but moves over the terminal buffer when the
user scrolls. Moving the viewport does not move the scrollback/writable boundary.

This example has 25 rows in the terminal buffer and a 10-row-tall terminal. The
user has scrolled 5 rows up, so the viewport shows rows 11 through 20 instead of
the live-bottom rows 16 through 25:

```
       TERMINAL BUFFER: all 25 stored physical rows

       scrollback buffer
 01 | older history        MUST STAY IMMUTABLE
 02 | older history        MUST STAY IMMUTABLE
 03 | older history        MUST STAY IMMUTABLE
 04 | older history        MUST STAY IMMUTABLE
 05 | older history        MUST STAY IMMUTABLE
 06 | older history        MUST STAY IMMUTABLE
 07 | older history        MUST STAY IMMUTABLE
 08 | older history        MUST STAY IMMUTABLE
 09 | older history        MUST STAY IMMUTABLE
 10 | older history        MUST STAY IMMUTABLE
     +----- viewport starts: user scrolled 5 rows up -----+
 11 | history              MUST STAY IMMUTABLE             | viewport row 01
 12 | history              MUST STAY IMMUTABLE             | viewport row 02
 13 | history              MUST STAY IMMUTABLE             | viewport row 03
 14 | history              MUST STAY IMMUTABLE             | viewport row 04
 15 | history              MUST STAY IMMUTABLE             | viewport row 05
-----+--------- scrollback / writable boundary ------------+-------------
       writable screen: bottom 10 rows of the terminal buffer
 16 | tool output          SAFE TO MODIFY                  | viewport row 06
 17 | tool output          SAFE TO MODIFY                  | viewport row 07
 18 | tool output          SAFE TO MODIFY                  | viewport row 08
 19 | tab bar              SAFE TO MODIFY                  | viewport row 09
 20 | prompt top           SAFE TO MODIFY                  | viewport row 10
     +----- viewport ends ----------------------------------+
 21 | prompt               SAFE TO MODIFY
 22 | prompt continuation  SAFE TO MODIFY
 23 | prompt bottom        SAFE TO MODIFY
 24 | status               SAFE TO MODIFY
 25 | help                 SAFE TO MODIFY
```

It does **not** matter whether the user has scrolled up. What matters is which
rows are in the bottom `process.stdout.rows` rows of the terminal buffer. In the
example, rows 16-25 remain writable even though the viewport currently shows
only rows 16-20 of them; rows 11-15 remain immutable even though the user can see
them.

“Safe to modify” means cursor-addressable without forcing a snap or scroll.
Before a writable-screen row is pushed across the boundary into scrollback, it
must be canonical and final. Scrollback rows cannot be selectively rewritten and
must remain immutable between canonical rebuilds. Before fullscreen begins, Hal
must preserve the terminal contents that predate Hal. Once fullscreen begins, a
canonical rebuild may clear the entire scrollback buffer, including those pre-Hal
contents, when snapping the viewport is known to be acceptable.

### Horizontal box model

Transcript blocks and chrome normally have one blank column on each side. For a
terminal of `cols` columns:

```
col 0          left padding (normally blank)
col 1..cols-2  content
col cols-1     right padding (normally blank)
```

Ctrl-G toggles copy-friendly output padding. With padding off, transcript rows
remove only their left blank and gain that content column; their unobtrusive
right parking column remains. The tab, status, and help rows remove both outer
blanks, allowing their right-aligned text to reach the edge. The editable prompt
keeps its inset on both sides.

An over-width source line containing only a plain HTTP(S) URL is the deliberate
exception: it has no horizontal margins and may exceed `cols`, so the terminal
soft-wraps and copies it as one logical line. Backgrounds still paint every
physical row, including the final wrapped row's unused columns.

Two painters deliberately use different background-fill strategies:

- `bgLine()` in `src/client/terminal/blocks.ts` fills the rest of a transcript
  row with `CSI K` (erase to end of line) while the background color is active.
  This is far cheaper than emitting explicit spaces.
- `paddedLine()` in `src/client/terminal/render-status.ts` pads chrome rows with
  real spaces because those rows compose segments with different backgrounds;
  `CSI K` would flood the row with whichever background happened to be active.

`bodyLine()` in `src/client/terminal/blocks.ts` handles the standalone-URL
exception: one OSC 8 link stays open across native wraps, then it delegates to
`bgLine()` to paint the remainder of the final physical row before resetting the
background.

Do not unify the two painters behind a mode flag: it adds code and slows the
hottest repaint path. Do keep their widths in agreement.

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

The first actual tab focus transition permanently enters full mode before its
canonical force repaint. This deliberately gives ordinary single-tab REPL use
normal shell scrollback, but makes every tab-switch repaint authoritative: it
clears native scrollback and rebuilds the focused tab's complete frame.

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

The frame has exceeded the terminal height at some point in the past, or the
user has switched tabs. Our content may now be in the terminal's scrollback
buffer, which is immutable (see below), or belong to another tab. We MUST clear
scrollback (`CSI 3J`) before canonical force repaints, or the user will see
stale content interleaved with the current tab.

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
get rewritten). A full-mode force repaint clears scrollback and writes everything
fresh; a grow-mode force repaint preserves scrollback.

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

`cursorRow` tracks the physical row on which the terminal cursor sits. Every code
path that moves the cursor — force repaint, diff repaint, or cursor-only
repositioning — MUST update `cursorRow` to the final physical row.

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
You CANNOT use `CSI B` past the bottom of the writable screen because the terminal
clamps it. Move to the last existing **physical** row, then use `\r\n` to append
and scroll naturally.

For non-fullscreen frame shrink, compare physical heights. After writing new
content, use `CR`, `CSI 1B`, then `CSI J` to erase leftover rows. Do not use
`\r\n` there: at the writable-screen bottom it scrolls and creates a stray blank
row.

### 9. Automatic fullscreen recovery preserves inspected scrollback when possible

A fullscreen shrink changes the scrollback/writable boundary. If every changed old
row is still on the writable screen, automatic repaint must avoid the fullscreen
force path: `CSI 3J` destroys scrollback and snaps a user who is inspecting it to
the live bottom. Derive the writable-screen physical rows, return to column one,
and use a relative cursor-up move by the terminal height (which clamps at the
writable-screen top), then rewrite each row with `CSI 2K`; do not append a final
CRLF. Do **not** use `CSI H`, which also makes Ghostty follow live output.

If the first changed physical row has already entered immutable scrollback, a
correct in-place repaint is impossible. In that case correctness wins: clear the
screen and scrollback with the canonical fullscreen repaint and rewrite the
complete frame. The visible snap and lost inspected scrollback are preferable to
leaving duplicated or interleaved transcript rows.

The writable-screen recovery temporarily hard-wraps a native-wrapped URL into
independently addressable OSC 8 rows, just as popup layout does. Ordinary rendering
must still leave completed standalone URLs native-wrapped for copy/paste.

This rule also covers popup open/close, which changes the URL layout. Explicit full
rebuilds—Ctrl-L, tab switch, terminal resize, or an editing key that reduces the
prompt's physical height—may always use the canonical path. Automatic prompt
clearing, streaming, tool, animation, and popup updates use writable-screen
recovery unless their first changed row is already immutable.

Fullscreen growth is straightforward only for a pure append. If an existing
logical line also changes, use the same clamped relative move to the writable-
screen top, repaint independently addressable logical lines, then append the
suffix with `\r\n`. If a soft-wrapped URL begins above the writable screen, leave
its unchanged writable-screen tail alone and start at the next complete logical
line.

Streaming Markdown must not paint one- or two-backtick fragments of a code-fence
delimiter. The completed third backtick removes that transient logical row; if the
row has reached scrollback, the removal instead appears as duplicated transcript
content. Hide the partial delimiter until it either completes or becomes ordinary
text.

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

**Fix**: `draw()` in `src/client/terminal/cli.ts` uses a leading-edge throttle with
trailing coalescing. The first non-force draw paints immediately; further requests
within 16ms are combined into one trailing paint. Force draws (tab switch, resize,
Ctrl-L) execute immediately.

**NEVER remove this throttle.** If you think a draw needs to be synchronous,
you are wrong — use `draw(true)` for a force paint, which already bypasses
the throttle. If you add a new `onChange()` call site, it automatically
benefits from the throttle.

Background-tab `stream-delta` / `stream-end` updates should also skip repaint
entirely. Their history is invisible until tab switch, so redrawing the active
tab is wasted work.

Parallel tools all start immediately, and their cards appear in call order 100ms apart.
Hal shows as many full cards as the terminal can safely hold; later cards stay as
one-line summaries. It reserves the full ten rows for every full card even while the
card is still short. That way one card can grow without pushing an earlier running card
out of the writable screen. A tall terminal can therefore stream several cards at once,
and finishing an earlier tool frees room for another. Tool cards never exceed ten rows.

Every tool header reserves one fixed-width status cell immediately before its title.
A revealed running tool cycles `◐ ◓ ◑ ◒`; when it finishes, the same cell becomes
`✓`. The history renderer supplies the phase rather than deriving time inside the
block renderer, keeping card geometry constant and allowing a future output-driven
mode to advance the spinner once per produced line.

This was discovered the hard way: without throttling, keypresses were
completely unresponsive during assistant output.

## Terminal scrollback: how it actually works

This section exists because we've been bitten by wrong assumptions about
scrollback multiple times. Read it. Understand it. Refer back to it.

### Scrollback is immutable

When output exceeds the terminal height, lines scroll off the top of the
**writable screen** into the **scrollback buffer**. Once there, they are frozen.
You cannot modify them. Period.

`CSI nA` (cursor up) is **clamped at row 1 of the writable screen**. It will
never move the cursor into the scrollback buffer. If you try `CSI 49A` when
the cursor is 25 rows from the top of the writable screen, it moves up 25
rows — not 49. The remaining 24 rows of movement are silently discarded.

This means: if you wrote 50 lines and 24 scrolled into scrollback, you can
only overwrite the 26 lines still on the writable screen. The 24 in scrollback
are permanent until explicitly cleared.

Verified experimentally — write 50 lines then try `CSI 49A` and rewrite
them all:
- **Tall terminal** (all 50 lines on the writable screen): all 50 rewritten.
- **Short terminal** (24 lines in scrollback): only the writable 26 are
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

- **Force repaint in full mode**: the frame has exceeded terminal height or the
  user has switched tabs. Must `CSI 3J` to clear scrollback, then rewrite ALL
  lines.

- **Tab switches**: enter full mode permanently, then always force repaint. This
  discards native scrollback so stale rows from another tab cannot survive.
