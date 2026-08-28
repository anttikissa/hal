# Terminal scrollback corruption: findings and decision record

Status: reproduced, root mechanism understood, correctness fallback and bounded tool
presentation implemented. Mutable tool geometry is reduced by eight-text-row cards,
call-order expansion, and 100ms card reveals. If a changed row has nevertheless entered
native scrollback, Hal deliberately clears scrollback and canonically rebuilds instead
of leaving corruption. A bounded live-turn region remains a possible future refinement.

## Executive summary

Hal's terminal UI renders a complete logical transcript plus bottom chrome. During
a live turn, thinking, tool cards, and assistant Markdown can change height. The
terminal's visible screen can be rewritten, but rows that have scrolled above it
into native scrollback cannot be rewritten or have new rows inserted before them.

The corruption occurs when a later block is painted and enters native scrollback,
then an earlier block grows or reflows above it. Hal's logical frame remains
correct, but no terminal escape sequence can transform the already-frozen physical
scrollback into that new frame while also preserving it. Different output chunking
and repaint timing freeze different intermediate frames, so repeated identical
runs can leave different mixtures of duplicated, missing, or interleaved rows.

This is not primarily a Google, Read, Bash, Markdown, cursor-offset, or manual
scrolling bug. Those are triggers or ways of exposing one architectural conflict.

## The four contradictory assumptions

The current behavior tries to maintain all four of these properties:

1. **Native terminal scrollback is immutable and should be preserved.**
   Automatic paints must not clear it, so users can scroll up without losing old
   output or being snapped away from the position they are inspecting.
2. **Already-visible live blocks may grow, shrink, or reflow asynchronously.**
   Tool results expand, streaming Markdown changes layout, and tables recalculate
   column widths as more text arrives.
3. **Parallel live cards must update independently.**
   A lower tool may show output immediately while an earlier, slower tool is still
   running. Publication must not be serialized merely to make terminal layout
   easier.
4. **The physical terminal must always represent the current logical transcript.**
   Automatic repaints should preserve transcript order and show each row exactly
   once, even while preserving native scrollback and the user's inspected position.

Once a mutable block can change above content that has entered native scrollback,
these assumptions cannot all be true. A terminal can edit visible screen cells,
but it cannot insert newly produced TOP rows before BOTTOM rows that are already in
scrollback. Better cursor arithmetic does not create that missing capability.

This contradiction is the main problem to solve. The eventual fix must explicitly
relax at least one assumption rather than hide the trade-off in another rendering
heuristic.

## Controlled reproduction

Commit `568afe0` replaced the old `/model scroll` Markdown scenario with a minimal
live-tool reproduction in the built-in HAL provider.

### Steps

1. Run a Hal version containing `568afe0` and reload it if necessary.
2. Make the terminal approximately 26 rows tall. A taller terminal may keep every
   row on the mutable visible screen and therefore appear correct.
3. Open a fresh tab.
4. Select `/model scroll`.
5. Send any prompt, for example `test`.
6. Do not manually scroll while the tools run.
7. After completion, scroll up and inspect the Bash cards.

The provider emits only two tool calls in this order:

```bash
sleep 1; for i in {1..20}; do echo "TOP-$i"; done
for i in {1..20}; do echo "BOTTOM-$i"; done
```

The tools execute concurrently. The lower BOTTOM card expands first. One second
later, the earlier TOP card expands above it.

### Observed results

The reproduction first appeared correct in a taller terminal. At 26 rows it
reproduced repeatedly. Three runs with the same steps produced three different
physical transcripts, including:

- a BOTTOM card whose body began with `BOTTOM-1` through `BOTTOM-4` and then
  continued with `TOP-9` through `TOP-20`;
- repeated `BOTTOM-1` through `BOTTOM-4`, followed by only the tail of TOP;
- repeated `BOTTOM-3` and `BOTTOM-4`, followed by a different TOP tail;
- a second copy of the BOTTOM card header stranded below the first card;
- missing prefixes of the TOP result.

The persisted logical history was not duplicated. The duplicate and mixed rows
were physical terminal residue.

### Why the output varies

Bash reports a running preview as pipe chunks arrive and later reports the final
result. Paints are also coalesced on a short timer. OS pipe chunk boundaries,
process scheduling, tool completion, and paint-timer alignment are not identical
between runs. A different intermediate frame can cross the visible-screen boundary
on each run. That frame becomes immutable scrollback, so later attempts to reconcile
it leave different residue.

The apparent randomness is evidence for the scrollback-boundary mechanism, not a
reason to suspect random duplicate history events.

## Manual scrolling versus terminal scrolling

Manual scrolling is **not required** to create the corruption. The controlled
reproduction failed while the user stayed at the live bottom and simply waited.

Automatic terminal scrolling **is required** in this reproduction. When Hal prints
past the bottom of the screen, the terminal moves top rows into native scrollback.
Those rows are then outside the writable screen buffer. Manually scrolling up later
only reveals the damage and tests whether Hal preserves the inspected position.

Screen height is therefore an important reproduction variable. If the whole
changing frame fits on the visible screen, Hal can rewrite it and the bug may not
appear. A short terminal forces mutable content across the boundary.

## Exact failure sequence

For the two-card reproduction, the relevant sequence is:

1. TOP and BOTTOM headers exist in transcript order.
2. BOTTOM finishes first and grows downward by 20 rows.
3. Painting BOTTOM makes the terminal scroll; some BOTTOM rows become native
   scrollback.
4. TOP finishes later and grows above BOTTOM by 20 rows in Hal's logical frame.
5. The correct new frame requires inserting TOP rows before BOTTOM rows that are
   already frozen in scrollback.
6. The renderer can rewrite only the visible suffix. It cannot repair the frozen
   prefix, so old BOTTOM rows combine with newly painted TOP/BOTTOM rows.

The renderer is not missing a special escape sequence. Standard terminal cursor
movement, line insertion, deletion, and scrolling regions affect only the active
screen. Native scrollback is owned by the terminal emulator and cannot be edited
selectively.

## The original Google/Read incident

The incident that motivated this investigation showed an earlier Read card copied
physically, with part of a Google result cutting through one copy. Persisted session
history contained one Google call and one instance of each Read call; it did not
contain the duplicated display sequence.

Google and Read were initially suspicious because they expand differently:

- Read often finishes locally and produces a large result at once;
- Google has network timing and a differently shaped rendered card;
- their completion order can differ from transcript order.

The Bash reproduction proves neither tool implementation is fundamental. Two plain
local Bash cards can produce the same duplication and interleaving. Google and Read
merely supplied a favorable timing and geometry.

Hashline suffixes such as `:Qkk`, `:BbX`, and similar references are intentional
Read output and are not themselves corruption.

## Streaming tables and the visible "trembling"

Tables are another trigger in the same class. During streaming Markdown rendering,
a table's chosen column widths can change when later cells arrive. Earlier rows may
then rewrap, grow, shrink, or change spacing. While all affected rows remain on the
visible screen, repeated repairs appear as trembling or jumping. If any affected
rows have entered native scrollback, the temporary layout can become permanent
corruption.

A table-specific stabilization rule might reduce that trigger, but it would not fix
tools, thinking blocks, prompt shrink, or other earlier-block height changes. The
architectural question remains wherever layout above the scrollback boundary is
mutable.

## Relevant recent work and what it established

Several fixes from the preceding week were useful but narrower than the general
problem.

### Parallel tool publication

Commit `3da6a94` published visible parallel tool output in call order. This avoided
the dangerous geometry by delaying later cards behind earlier cards. It was a valid
terminal workaround, but violated the product requirement that parallel cards
update independently.

Commit `719da78` restored concurrent tool-card updates, and `e482ac6` recorded that
concurrent updates are required. No replacement rendering architecture accompanied
the revert. The controlled reproduction now demonstrates the unresolved consequence.

Do not reintroduce serialization accidentally as a "fix" unless the product decision
explicitly changes assumption 3.

### Fullscreen anchoring and shrink fixes

Commits including `83b7011`, `1d11377`, `17879e4`, `fa698cf`, `0adbabd`, and
`4fbb539` improved anchoring, inspected-scrollback preservation, frame growth, and
frame shrink behavior. They appear successful for their targeted cases. They cannot
insert content before immutable scrollback and therefore do not resolve this case.

### Transient Markdown fence fix

Commit `d97b2dc` fixed a demonstrated corruption trigger where a streamed code fence
arrived one backtick at a time. A one- or two-backtick transient row was briefly
rendered as ordinary text, changing layout at the boundary. The original
`hal/scroll` scenario was built to prove that fix.

That work successfully removed the transient-fence trigger; it did not establish
that all mutable live layouts were safe. Commit `568afe0` repurposed `hal/scroll` for
the simpler two-tool reproduction after the broader issue was identified.

### Separate cross-tab scrollback bug

A newly opened empty tab could expose rows from the previously focused tab when the
user scrolled up. This was separate from live-card corruption:

- `609186d` makes an asynchronous session-list focus change, including Ctrl-T's new
  tab, request the same canonical forced repaint as ordinary tab switching.
- `1df2fb8` keeps initial single-tab REPL use in grow mode, then permanently enters
  Hal's internal full mode on the first real tab focus transition. Canonical tab
  repaints then clear native scrollback and rebuild the focused tab.

These commits prevent cross-tab scrollback leakage. They do not fix asynchronous
live blocks within one tab.

## Terminology: Hal full mode is not alternate-screen mode

Hal's `fullscreen` flag is an internal, one-way renderer state. It means the frame
has crossed the terminal height or tab switching has made old native scrollback
unsafe. Canonical forced repaints in this mode clear and rebuild the terminal with
sequences including `CSI 3J`.

Hal does not enter the terminal's alternate screen for this. Native scrollback is
still used during ordinary automatic painting. Merely setting `fullscreen = true`
does not make arbitrary live reflow safe; automatic paints deliberately try to
preserve scrollback rather than clearing it on every delta.

## Why another cursor-offset patch is the wrong level

A cursor or anchoring bug can cause corruption even when a correct physical update
is possible. Those bugs should be fixed. This reproduction is stronger: after the
boundary crossing, the requested update is physically impossible without discarding
or avoiding native scrollback.

The following approaches can reduce symptoms but cannot solve the class by
themselves:

- adjust the number of cursor-up rows;
- special-case Google, Read, Bash, tables, or backticks;
- deduplicate rendered rows after the fact;
- tune the repaint throttle;
- retry the diff from a different logical line;
- use insert/delete-line escape sequences on the visible screen;
- detect one known completion ordering.

Deduplicating would also be especially harmful: identical output rows are valid, and
physical residue is not duplicated server data. The root cause is producing a
physical frame that later requires mutation outside the writable screen.

## Solution space and explicit trade-offs

No solution preserves all four assumptions. The product decision is which property
to relax and how visibly.

### Option A: serialize visible publication

Do not reveal a later parallel card's output until every earlier card has stabilized.
The transcript grows monotonically, so native scrollback remains usable.

Advantages:

- conceptually small;
- compatible with native scrollback;
- final ordering is naturally correct.

Costs:

- violates independent parallel updates;
- makes fast tools appear blocked by slow tools;
- was already tried and deliberately reverted.

### Option B: canonical rebuild whenever live reflow is unsafe

Detect a height/layout change above rows that may be in native scrollback. Clear
scrollback and redraw the complete canonical frame.

Advantages:

- relatively small;
- makes the final physical display correct;
- useful as an immediate safety fallback.

Costs:

- destroys native scrollback on each unsafe change;
- snaps or invalidates a user's inspected position;
- tables and frequently streaming tools could cause disruptive repeated rebuilds;
- relaxes assumption 1.

This is a reasonable first safety phase if the priority is "never show corruption"
before a more polished architecture exists.

### Option C: make all live layouts monotonic or fixed-height

Reserve capacity for running cards, clip output into it, avoid shrinking, and freeze
streaming table widths so earlier rows never reflow.

Advantages:

- can preserve native scrollback;
- smaller than a fully application-owned scrollback system;
- independent cards can fill reserved rows concurrently.

Costs:

- deciding a sufficient reservation is impossible for unbounded output;
- large reservations waste terminal space;
- clipping requires its own navigation or omission policy;
- every live renderer must obey strict monotonic-layout rules;
- streamed assistant prose and tables still need constraints.

This can be a useful component of a live-region design, but is fragile as the sole
architectural invariant.

### Option D: bounded mutable live-turn region

Treat completed history and the active turn differently:

- completed turns are committed to native scrollback and never change;
- the current thinking/tools/assistant turn lives in a bounded repaintable region at
  the bottom of the visible screen;
- parallel cards update independently within that region;
- if the active turn is taller than the region, show a clipped window or tail and an
  explicit hidden-row count;
- once the turn stabilizes, replace the temporary region and append its canonical
  final representation exactly once.

Advantages:

- preserves stable historical native scrollback;
- preserves independent concurrent updates;
- prevents mutable rows from entering native scrollback;
- handles tools, tables, thinking, and assistant streaming under one invariant;
- commits a correct, complete final transcript.

Costs:

- users cannot use native terminal scrolling to inspect the entire unfinished turn;
- a tall active turn needs clipping, paging, or tail-following UI;
- committing the final turn must be carefully designed so temporary rows do not also
  remain in scrollback;
- this is a larger rendering change.

This is the recommended direction because it directly enforces the missing invariant:

> No row belonging to a mutable turn may enter native terminal scrollback.

A useful conceptual model is **an immutable committed transcript plus a bounded
mutable live region**.

### Option E: application-owned scrollback or alternate screen

Own the entire viewport and transcript navigation inside Hal instead of relying on
native terminal scrollback.

Advantages:

- arbitrary updates are possible;
- tab state and inspected position can be exact;
- familiar model for full-screen TUIs.

Costs:

- largest implementation and interaction change;
- native terminal selection, searching, scrollback, and shell integration may suffer;
- contradicts Hal's established preference for ordinary terminal scrollback;
- alternate-screen behavior is not currently desired.

## Adopted staged approach

Phase one is implemented: unsafe reflow clears scrollback and canonically rebuilds.
Tool cards reduce how often this is necessary by never exceeding ten rows. Hal reserves
all ten rows before allowing a card to expand, so several cards may stream together when
the writable screen is tall enough without one card's growth pushing another off-screen.

The fallback is intentionally a safety net, not an invisible heuristic. If the bounded
tool presentation is still taller than the writable screen, correctness explicitly
wins over preserving the user's inspected scrollback position.

A bounded mutable live-turn region remains a possible phase two. If pursued, its open
questions are its height, tail/head/paging policy, final commit boundary, and treatment
of streaming tables. The current rule already preserves the important invariant: the
full reserved size of mutable cards must fit on the writable screen.

## Proof and regression criteria

A convincing fix should test deterministic rendering and wiring rather than exact
LLM output.

At minimum, preserve the two-tool scenario:

1. create TOP before BOTTOM;
2. expand BOTTOM enough to exceed a 26-row terminal;
3. later expand TOP above it;
4. vary output callback chunking and paint boundaries;
5. verify the physical transcript contains each canonical TOP and BOTTOM row exactly
   once after stabilization;
6. verify the logical persisted history was never duplicated;
7. repeat both while the user remains at the bottom and while the user is inspecting
   older scrollback.

Also cover:

- a streaming table whose later cell widens an earlier column;
- a live block shrinking as well as growing;
- three or more tools completing out of order;
- a live turn much taller than the terminal;
- terminal resize during the live turn;
- forced tab switching during a live turn;
- final commit followed by scrolling through the complete canonical turn.

A test that only compares Hal's logical frame is insufficient. The failure occurs in
the stateful terminal interpretation of emitted escape sequences. The harness must
model the visible screen and immutable native scrollback boundary faithfully enough
to expose stranded physical rows.

## Current state for the next session

As of 27 August 2026:

- `hal/scroll` provides a minimal reproducible two-Bash-card case (`568afe0`).
- The case reproduces at 26 terminal rows without manual scrolling.
- Repeated identical runs can produce different corrupt physical transcripts.
- Persisted history is not the source of duplication.
- Concurrent card updates remain an explicit requirement (`e482ac6`).
- Cross-tab stale scrollback has separate fixes (`609186d`, `1df2fb8`).
- No architectural fix for mutable live rows entering native scrollback has been
  implemented.
- The primary decision is which of the four contradictory assumptions Hal should
  relax, with the bounded mutable live-turn region currently recommended.
