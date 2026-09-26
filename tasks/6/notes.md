# Notes from implementing task 6

- The artifacts are the old Hal's file-IPC contract: about 20 commands,
  tool and provider types, event ids. Almost none of it applies. Use
  them only as a reference for naming, and start from the five commands
  the task needs.
- There is no replay because the snapshot and the subscription happen
  in one synchronous step (`follow`). Any `await` between loading
  history and adding the client to followers opens a gap where events
  are lost or counted twice. Durable (async) history must keep that
  step synchronous.
- The snapshot's `turn` holds only blocks not yet in history, and
  assistant blocks are recorded at turn end. If output were persisted
  mid-turn, snapshots would show it twice unless `turn` changed to
  match.
- `create` has no sessionId. The client learns the id from the
  snapshot that answers it. This is the one exception to "every message
  names its session".
- On cancel, break out of the stream loop on `signal.aborted` too. Do
  not rely on the provider stopping, or a late delta can be broadcast
  after the cancel.
- Pass the in-memory connection through ASON both ways. That catches
  non-serializable events and clients mutating host state through
  shared references. A test depends on it.
