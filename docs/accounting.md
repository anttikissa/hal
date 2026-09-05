# Usage accounting

Session `history*.asonl` files contain `type: 'usage'` receipts. Each is one
stopped generation loop (completion, pause, wait, abort or failure), or one
`/what` summary. A resumed loop writes only its new usage. These records are
accounting metadata, not conversation text sent back to the model.

- `model`: resolved model identifier; `purpose`: `turn` or `summary`.
- `usage`: provider-reported uncached input, output, cache reads and cache writes.
- `requests`: logical provider generation calls, including agent-loop retries;
  not an exact HTTP request count (transports can retry internally).
- `apiUsd`: API-equivalent estimate captured using Hal's prices/cache assumptions
  at receipt time, not a subscription bill. Absent when unpriced or no usage was
  reported. `incomplete: true` means at least one call lacked reported usage;
  token totals and any dollar estimate then cover only the known portion.
- `ts`: receipt time; `durationMs`: loop wall time, including tools/retry waits.

Sum **usage receipts only** for new accounting. Old assistant/turn-end usage
fields overlap; pending-tools usage is operational state, not another charge.
Undone/canceled work still incurred usage. Do not count inherited fork history as child spending. Use session metadata's
`parentSessionId` to roll child expenses into a task total. If scanning archived
logs after rebases, count each history entry ID once, not each physical copy.
Old sessions cannot be retroactively given complete receipts. A process crash
before the loop's final write can lose the in-progress aggregate.

`state/subscription-usage.asonl` is a separate, shared account observation log.
It records fresh changed quota observations: timestamp, provider, pseudonymous
account identifier and window percentages/reset times (`resetAt` is Unix
milliseconds; `durationMinutes` identifies the window). Cached reads and fetch
failures are not observations. Account identity follows auth keys; when no
provider identity is available, the slot-based fallback is sensitive to reordering. It does not add polling. Align observations with
session activity to study drain rates, but do not attribute account-wide changes
to individual sessions: other Hal sessions and external clients may contribute.
