# TUI Rewrite — Implementation Notes

## What Changed

### Commit: `Rewrite TUI: alt screen, state-driven render, mouse selection`

Rewrote `src/cli/tui.ts` from 1098 lines (scroll-region based) to ~1460 lines (state-driven).

### Architecture Changes
1. **Alternate screen buffer** — `\x1b[?1049h` on init, `\x1b[?1049l` on cleanup.
   Terminal scrollback is preserved and restored on exit.

2. **State-driven rendering** — Single `render()` function redraws every row.
   No scroll regions, no cursor save/restore for output tracking.
   All state mutations end with `render()` or `scheduleRender()`.

3. **Output storage** — Changed from `transcript: string` (pre-wrapped) to
   `outputLines: string[]` (logical lines, unwrapped). Lines are word-wrapped
   with ANSI preservation during render via `wrapAnsi()`.

4. **Mouse support** — SGR extended mouse reporting for:
   - Wheel scroll (±3 lines per tick)
   - Click+drag text selection (char/word/line modes)
   - Auto-copy to clipboard on release

5. **Keyboard scrolling** — PageUp/PageDown, Shift+Up/Down

6. **Bracketed paste** — Multi-chunk accumulation, handles large pastes

7. **Ctrl-Z** — Properly leaves alt screen, disables mouse. SIGCONT re-enters.

### API Surface
Zero changes to exports. All functions maintain same signatures.
`client.ts` requires no modifications.

### Snapshot Format
Old: pre-wrapped text with `\r\n` (from `rawWrite`).
New: logical lines joined by `\n`.

This is fully internal — tab output is only produced by `getOutputSnapshot()`
and consumed by `setOutputSnapshot()`/`replaceOutput()`. The `tab.output += text`
path in `renderEventToTab` appends the same formatted text that `write()` receives.

### Dead Code Removed
- `ANSI_ESC_RE` regex (replaced by `readEscapeSequence` char-by-char parsing)
- `wrapCol` streaming wrap state (replaced by logical-line storage + render-time wrapping)
- `rawWrite` (no longer needed — alt screen handles line endings)
- `outputCursorRow`/`outputCursorSaved` (no cursor tracking needed)
- All scroll region management (`setScrollRegion`, `resetScrollRegion`, etc.)

### Dead Code Kept (API compat)
- `inputEchoFilter` — set by client.ts but never read. Keeping the setter for API compat.

## Questions

1. **Performance on large output**: `render()` does `getVisibleWrapped()` which walks
   `outputLines` backwards, wrapping each line. For 10k lines this could be slow on
   every keystroke. The mitigation is that it stops early once it has enough lines for
   the viewport + scroll offset. Should we add a render frame budget / skip check?

2. **Scroll offset units**: Scroll offset is in visual (wrapped) lines. When the terminal
   is resized, the same scroll offset may point to a different logical position since
   lines re-wrap. The reference impl does the same. Is this acceptable, or should we
   try to maintain logical-line scroll position across resizes?

3. **Mouse selection in footer area**: Currently clicks in the footer area (activity,
   status, prompt) just clear any active selection. Should we eventually allow selecting
   text from the status line or activity line?

4. **`inputEchoFilter`**: It's set by client.ts to filter `/q` and `/exit` from being
   echoed, but the TUI never reads it. Was this intended for something? Should I wire
   it up (e.g., don't echo the input on submit if filter returns false)?

5. **Alt screen + scrollback loss**: With alternate screen, users lose access to terminal
   scrollback while in the TUI. The mouse wheel + keyboard scrolling compensate, but
   the scrollback is limited to `MAX_OUTPUT_LINES` (10k). Is this sufficient? Should
   we show a hint about PageUp/Down on first use?
