# Notes from implementing n

- The artifact contradicts the task in two places: it swallows parse
  errors (resets to defaults) and its test expects ASON comments to be
  preserved. Our ASON has no `comments` option and drops comments, so
  any save of a hand-edited file loses them. Don't promise otherwise.
- ASON parse errors quote the offending source line. For files holding
  secrets (auth.ason) only surface the first line of the message.
- The artifact's "own write" detection (a 100 ms flag after writing)
  races with the watcher. Comparing the reloaded text with the last
  text we wrote/read (`synced`) is reliable and needs no timer.
- The artifact creates a fresh proxy on every nested get, so
  `a.x === a.x` is false and assigning a proxy back stores a proxy in
  the data. Cache proxies per target and unwrap on set.
- Watch the directory (atomic rename swaps the inode), filter events by
  basename, and unref/clear the debounce timer: conventions.test.ts
  fails on leftover timers or watchers, and `close()` must clean both.
- Defaults are deep-copied through ASON; otherwise nested mutations
  leak into the caller's defaults object (and defaults may be proxies).
- An external edit wins over a local change not yet flushed; a deleted
  file keeps the in-memory data. Tests should override
  `liveFiles.onError` to capture errors instead of logging to diag.
