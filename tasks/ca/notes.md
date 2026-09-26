# Notes from implementing ca

- The artifacts (history-projection.ts, live-event-blocks.ts) come from
  the old Hal's event model (stream-delta, tool-result, info, prompt
  labels, question rows). Almost none of it maps onto the task-6
  protocol. Treat them as background reading. Building on
  `blocks.apply` from task 6 was simpler and guarantees that live
  folding matches what the host records.
- `blocks.apply` mutates the turn in place, but only the last block and
  the usage. A pure fold only needs to copy those
  (`transcript.copyTurn`), not deep-clone the whole turn.
- A signature closes a thinking block, so thinking that comes after
  one becomes a separate item. Two thinking items in a row is expected,
  not a bug.
- `rejected` events never enter the transcript. Clients have to show
  them some other way.
- One Transcript follows one session. Once a transcript exists, a
  snapshot for a different session is ignored.
