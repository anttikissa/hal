# Notes from implementing 7f

- The shared.ts artifact's SSE splitter only matched `data: ` (with the
  space), ignored `event:` and multi-line data, and treated a trailing
  `\r` as a line end. A chunk can end between `\r` and `\n`, so hold a
  trailing `\r` back until more bytes arrive, or you get a spurious
  blank line that dispatches the message early.
- Passing the signal to fetch is not enough to stop a read that is
  already waiting on the body (at least not with a test-built stream).
  Race each `reader.read()` against abort and the stall timeout, and
  cancel the reader in `finally`.
- bun-types' `body.getReader()` return type doesn't match the global
  `ReadableStreamDefaultReader` (missing `readMany`), so tsc needs a
  cast.
- Cancelling is an `error` event with `cancelled: true`, not a separate
  event kind; history/turn code has to check that flag to record a
  cancelled rather than failed turn.
- OpenAI Responses can send a reasoning signature with no summary text,
  so a `signature` event with no open thinking block makes an empty
  thinking block. Replay must not drop empty-text thinking blocks that
  carry a signature.
- Dropped from the artifact: retry-after parsing and ASON-based tool
  argument parsing. Providers parse tool arguments themselves.
