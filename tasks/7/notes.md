# Notes from implementing task 7

- The artifacts can't be lifted: api-messages.ts and replay.ts are built
  on the old HistoryEntry shape (blobs, pending_tools, pruning, meta
  injection). Only repairToolPairing's idea carried over: every tool
  call needs a result before the next user message, and results with
  no call must be dropped, or providers reject the input.
- tasks/8's parseStream silently skipped a bad first line. On a
  whole-file read that hides corruption, so skipping is now opt-in
  (`midRecord`). A partial write only ever shows up as an unterminated
  *last* line (`onPartial`); a bad line that ends in a newline is
  corruption, so report it and never repair it.
- The fragment given to onPartial is decoded text and may have lost a
  cut-off multibyte character. Truncate the file by bytes at its last
  '\n', not by the fragment's length.
- A complete last record with no trailing newline is valid. Add the
  newline before appending, or the next record glues onto it.
- Closing an open turn as interrupted must skip sessions whose turn is
  streaming in this host (history.state.running). Otherwise a second
  open of a live session ends the turn under the stream.
