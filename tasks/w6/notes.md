# w6 notes

- The raw-byte scan also fires inside a bracketed paste: a pasted
  literal 0x03/0x1a/0x12 quits, suspends or restarts. That's deliberate
  (an endless paste must not trap the user), but don't "fix" it by
  skipping paste content — that breaks the invariant.
- Scanning C0 bytes anywhere is safe: UTF-8 continuation bytes are
  always >= 0x80, so no multi-byte character contains 0x03/0x12/0x1a.
- Kitty modifier bits include caps lock (64) and num lock (128). Ignore
  them, or Ctrl-C with caps lock on sends `ESC[99;69u` and is missed.
- keys.ts still decodes C-c/C-z/C-r as ordinary events. terminal.ts
  filters them out after the scan; anything reading keys.feed directly
  must do the same or the key gets handled twice.
- With a faked exit (tests), quit/restart return. onData must stop
  delivering the rest of the chunk after one, or tests see ghost keys.
- Manual pty check without touching your own terminal:
  `(sleep 1; printf '\x03') | script -q /dev/null ./run | od -c`.
- The old run's exit code 42 (auto-update pull) was dropped on purpose;
  only 100 restarts.
