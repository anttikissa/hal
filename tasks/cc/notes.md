# Notes from implementing cc

- The artifact's wordWrap had bugs: it kept the breaking space
  ("the quick "), and it measured tabs from the start of the source
  line, not of the wrapped row, so a tab could make a row too wide.
  The src version measures columns per row and tests widths as an
  invariant over many widths; keep that test when touching wrapping.
- frame.clean() must keep UTF-16 offsets unchanged (no CRLF folding
  there), because the prompt cursor is an offset into the raw text.
  Line-ending normalisation happens only in wrap(), for display text.
- Bun emits 'exit' on uncaught errors and rejections, but not on
  SIGTERM/SIGHUP; realIO installs handlers that call process.exit so
  the restore runs. A new exit path must go through 'exit' or leave().
- A forced grow-mode repaint is only safe while our top is still on
  screen. If the terminal got shorter than cursorRow, render switches
  to full mode rather than leaving stale rows above.
- Shrink bugs hide: a one-row fullscreen shrink repainted in place
  happens to look right. The test shrinks the prompt by two rows and
  then edits every row; keep tests at that strength.
- Every frame line is at most one terminal row, so frame rows equal
  terminal rows. Adding the standalone-URL soft-wrap exception from
  terminal.md means adding physical-row bookkeeping (lineTops) back.
- render.test.ts has a small terminal emulator (scrollback, clamped
  cursor moves, CSI J/K/G/H/3J). Reuse it for later terminal work; it
  throws on sequences it doesn't know, which catches accidental ones.
