# Lean tab loading (Hal web + terminal clients)

## Problem (measured 2026-10-31 on a host with 202 open tabs)

- 202 open tabs; 177 histories exceed the 256 KB snapshot budget.
- Every client opens every tab in the background, one at a time
  (src/web/tabs.ts, src/client/tab-switch.ts `backgroundStep`), and
  then follows all of them forever (live events for 200 sessions).
- On reconnect, `connection.attach` (src/common/connection.ts:131)
  re-opens all followed sessions at once: ~200 x ~250 KB = ~50 MB
  burst. Bun's 16 MB backpressure limit closes the socket
  (closeOnBackpressureLimit, task p2p), the client reconnects, and
  the loop repeats every ~5 s (state/diag.log: "send buffer full").
  A truncated message shows as a parse warning: the flicker.
- A snapshot tail is ~250 KB but a phone screen shows ~10 one-line
  rows (~1 KB of visible text). Tail bytes by record type (4 sessions,
  882 KB): output 40%, user (tool results) 38%, assistant 17%,
  rest 5%. Average output record 1.7 KB, user record 2.5 KB.
- Host diagnostics (server CPU, measured): building the tail ("tail")
  averages 414 ms, max 1.3 s; encoding 3.4 ms avg. Client (iPhone,
  measured): parse 2 ms avg, apply 2 ms avg, max 66 ms. So bytes on
  the network and the host's tail read dominate, not client parsing.
- The `tabs` event resends the whole tab list on every tab state
  change (tabs.publish on state/turn-start/prompt/turn-end/...).
  ~150 B per tab (estimate): 1000 tabs = ~150 KB per change, several
  per turn per running session.
- The greeting sends every session id (1783 ids, 18 KB now).

## Goal

Assume 1000 tabs. Anything a client loads before it can show the
selected tab must load and process within 0.1 s on the user's phone
(estimate: ~30-50 ms RTT on 5G leaves ~50 ms of transfer; target
<= 16 KB on the wire for the first screen). Switching to a tab the
user is about to open must still be instant.

## Design

### 1. Bounded follow set

A client follows at most F sessions (F = 8): the shown tab plus a
prefetch set. It closes (`close` command) any other. Hidden cached
views beyond the follow set are evicted LRU; a cache entry for a
non-followed tab is dropped (it would go stale).

Replaces: "open every tab in the background" and "Never poll or cap
the pace after startup" (web/tabs.ts, client/tab-switch.ts).

### 2. Prefetch by likely next tab

Each client keeps a ranked list of candidates and keeps the top
F-1 followed:

1. A tab under the pointer or finger (pointerenter / pointerdown on a
   tab link): open at once, before the click lands (~100 ms head start).
2. The neighbors Ctrl-N / Ctrl-P / swipe reach (shown +-1).
3. Tabs visible in the strip: web reports `visible()` start..end from
   Tabs.tsx (already measured for edge buttons); the terminal its
   tab-bar page (tab-bar.ts `page`). Nearest to the shown tab first.
4. Tabs wanting attention (`attention`), most recent first.
5. Recently shown tabs (MRU).

Alt-1..0 targets tabs 1-10; they are not prefetched unless in a rank
above (pressing Alt-digit is followed by a one-screen load).

Prefetch runs only after the shown tab painted, one open at a time
(next after the previous snapshot), and never on a hidden page.

### 3. A snapshot is one screen, not 256 KB

Snapshot = the newest records filling about 2 screens of rows
(record count cap, e.g. 60 display records, and byte cap 24 KB),
with large strings clipped:

- Host clips tool-result outputs, `output` record text, tool call
  inputs and long assistant/user texts to a preview (enough for the
  closed card on the widest client: first ~8 lines / 600 chars) and
  marks the field `clipped: <full length>`.
- Opening a card, copying it or finding in it fetches the full
  record: new command `record { sessionId, n }` -> event `record`.
- Older pages (`history` command) use the same clipping and budget;
  the web keeps fetching on scroll-up, the terminal fetches the full
  history of the shown tab only (as today), never of prefetched tabs.
- Host reads only the bytes it sends: the tail read stops at the
  record budget (pages.ts), so building gets cheaper too.
- State, inbox and stats keep coming from host marks (already
  independent of the tail).

The turn-boundary rule ("start at a prompt so no turn is cut") is
replaced by `earlier` stand-ins, which already exist.

### 4. Reconnect re-opens only the shown tab

`connection.attach` re-opens the shown session first; the prefetch
set follows paced by the client (section 2). The connection layer
stops re-opening everything it ever saw.

Host defense in depth: per connection, a snapshot is built and sent
only while the socket's buffered amount is under 256 KB; otherwise
it waits for Bun's `drain`. The 16 MB close stays as the last resort.

### 5. Tab list deltas

- Connect: full list once, compact (only non-default fields).
- Changes: `tabs-update { changed: Tab[], order?: string[] }`; order
  only when tabs move, open or close.
- Session ids for linking: send none; a client links ids by pattern
  and the host answers an unknown id with "no such session".

### 6. Compression

Turn on permessage-deflate on the web socket (Bun `perMessageDeflate:
true`). Measured on 3 histories (deflate-raw): a 24 KB tail compresses
to 4.2-8.2 KB, a 256 KB tail to 33-74 KB (3.5-8x).

## Budgets (to verify with web diagnostics)

| What                  | Now (measured)     | Target              |
| --------------------- | ------------------ | ------------------- |
| First tab snapshot    | ~230 KB raw        | <= 24 KB raw, ~4 KB deflated |
| Connect burst         | ~50 MB (all tabs)  | tabs list + 1 tab   |
| Followed sessions     | all (202)          | <= 8                |
| tabs event per change | ~30 KB (est.)      | ~200 B delta        |
| Host tail build       | 414 ms avg         | < 20 ms             |

## Failure modes considered

- Switching to a non-prefetched tab (Alt-7, tab sheet): one screen
  load, ~1 RTT + ~4 KB. Acceptable; shows the card skeleton meanwhile.
- Clipped text copied or searched as if whole: copy/find fetch the
  full record first; clipped cards show a "N KB more" marker.
- Evicted cache loses scroll position: keep scroll positions (tiny)
  for all tabs; only views are evicted.
- Old clients against a new host: protocol bump; the host already
  closes stale pages with 4000 (reload).
- Notifications for hidden tabs: already host-side (attention marks,
  push), independent of following.

## Revised after Astra review (31-ilk)

Accepted, all eight findings:

1. Connect burst still holds the full tab list and 1000 DOM links:
   greet with the shown tab and the strip window first, the rest of
   the metadata after paint; virtualize the strip and the tab sheet.
2. Never evict (close) a session with an open queue edit, prompt
   edit, half-filled form or pending command: these are pinned. Keep
   drafts outside evictable views.
3. Clipped text never reaches the editor, copy or a `long` card: they
   hydrate the record first. Find stays host-side.
4. The cap covers the whole serialized snapshot (earlier, inbox,
   draft, live turn, tool output, rebase data). The live turn and
   streamed output are sent whole; only finished records get clipped.
5. Host cost: ASONL must be parsed whole. Add a per-session preview
   index (clipped records written beside history at append time) so
   a snapshot reads only preview bytes. Rebased histories fall back
   to today's path until measured.
6. Reconnect reopens the shown tab plus every session with pending
   commands, before replaying them; prefetch state resets.
7. Scroll position is saved as a record anchor + offset; reopening
   an evicted tab loads around the anchor.
8. New events need an explicit protocol bump; manual-update pages
   get the existing `web-update` notice, not a silent break.

Simplified prefetch: pointer/finger down, shown +-1, visible strip.
Attention/MRU ranking dropped until measured.

## Phases

1. Bounded follow set + reconnect fix (sections 1, 2, 4; findings
   2, 6, 7). Ends the 16 MB loop and the flicker. Done in task qrd:
   reconnect still reopens every followed session, but that set is
   now at most 8 plus busy ones. A reader away from the bottom keeps
   the tab followed instead of a record anchor (finding 7).
2. First paint: tab-list window, virtualized strip/sheet, tab deltas,
   permessage-deflate (sections 5, 6; finding 1).
3. Preview snapshots with clipping and a preview index (section 3;
   findings 3, 4, 5).

## Decisions (user, 2026-10-31)

1. F = 8 followed tabs.
2. Drop the session id list; link ids by pattern.
3. The terminal follows the same rules.
