# LOC reduction plan for `src/client/cli.ts`

## Review verdict

Mostly grounded, but the earlier version mixed real LOC cuts with several "move it elsewhere" ideas too early.

For this file, **under 400 in one pass is reachable without adding helper modules or new cross-module glue**. The best first pass is a tight delete/dedupe pass inside `src/client/cli.ts` itself, then a small `handleAppKey()` cleanup, then stop and re-measure.

Because repo `bun cloc` is currently **13,500 LOC**, the bar should be **repo-flat-or-down**, not "this one file got shorter".

## Current size

- Current `bun cloc` LOC for `src/client/cli.ts`: **417**
- Command run: `bun cloc src/client/cli.ts`
- Repo total from `bun cloc`: **13,500**
- Credible path under 400 in one pass: **yes**
- Credible first-pass landing zone: **~385-398** with low risk and repo LOC down
- Bigger one-pass landing zone like **~360-380**: possible, but only if `handleAppKey()` cleanup pays off cleanly or `/raw` is cut

## Files/read paths reviewed

- `src/client/cli.ts`
- `src/client/cli.test.ts`
- `src/main.ts`
- `src/client-startup.test.ts`
- `src/client/popup.ts`
- `src/cli/completion.ts`
- `src/cli/help-bar.ts`
- `tests/main.test.ts`
- `tests/tabs.test.ts`

## What is actually in `src/client/cli.ts`

This file is a coordination layer. It currently mixes:

1. terminal lifecycle
2. paint throttling
3. submit policy
4. local `/raw` debug mode
5. popup/completion/app/prompt key routing
6. prompt/client sync glue
7. startup wiring for drafts/history/rendering

That matters because some reductions are real deletion/dedupe, while others would only spread the coordination logic across more files.

## Grounded reduction ideas that are real first-pass wins

These are ordered by "best LOC return per risk", and the estimates are **net repo impact**, not just file-local impact.

### 1) Delete `submitCommandType()` and its test

Why this is real:

- `submitCommandType()` always returns `'prompt'`
- both parameters are unused
- `src/client/cli.test.ts` spends a whole test proving that the constant wrapper returns a constant

Impact:

- `cli.ts`: about **-5 to -7**
- `cli.test.ts`: about **-8 to -12**
- Net repo impact: about **-13 to -19**

Risk/tests:

- Very low risk
- Watch `src/client/cli.test.ts`

### 2) Inline the local `/raw` interception into `submit()`

Why this is real:

- `handleLocalCommand()` is a single-use wrapper
- it only checks one exact command: `/raw`

Impact:

- `cli.ts`: about **-4 to -6**

Risk/tests:

- Low risk
- Watch raw-mode tests in `src/client/cli.test.ts`

### 3) Delete `handlePopupKey()`

Why this is real:

- it is only:
  - `if (!popup.state.active) return false`
  - `return popup.handleKey(k)`
- no extra policy lives there

Impact:

- `cli.ts`: about **-3 to -5**

Risk/tests:

- Very low risk
- Watch `src/client/popup.test.ts`
- Watch kitty model picker behavior in `tests/main.test.ts`

### 4) Merge `setTabStops()` and `restoreDefaultTabStops()` into one helper

Why this is real:

- same algorithm twice
- only the step differs: configured tab width vs terminal default `8`

Best shape:

- `writeTabStops(cols, step)`

Impact:

- `cli.ts`: about **-6 to -10**

Risk/tests:

- Low/medium risk because terminal behavior is fragile
- Watch `tests/main.test.ts`
- Watch `tests/tabs.test.ts`
- Re-read `docs/terminal.md` before changing behavior

### 5) Dedupe the max-tab guard and error text

Why this is real:

Current duplication exists in:

- ctrl-t open
- ctrl-shift-t resume
- ctrl-f fork

Best shape:

- a tiny helper like `sendTabCommandIfRoom(...)`
- or `hasRoomForNewTab()` plus one shared error emitter

Impact:

- `cli.ts`: about **-6 to -10**

Risk/tests:

- Low risk
- Watch `src/client/cli.test.ts`
- Watch `tests/tabs.test.ts`

### 6) Simplify `handleAppKey()` only after the deletions above

Why this is real:

- the function repeats the same modifier checks many times
- several branches are ctrl-only shortcuts
- the `t` shortcut family is already a grouped case conceptually

Best shape:

- a `ctrl-only` block plus a `switch (k.key)`
- preserve explicit special cases where ordering matters

Impact:

- `cli.ts`: about **-8 to -18** if done cleanly

Risk/tests:

- Medium risk
- Sensitive behavior:
  - ctrl-t vs ctrl-shift-t
  - ctrl-d only when prompt is empty
  - enter continue vs submit
  - alt-m fallback must still work
  - escape abort only while busy
- Watch `src/client/cli.test.ts`
- Watch `tests/main.test.ts`
- Watch `tests/tabs.test.ts`

### 7) Inline trivial stdin locals and repeated one-liners opportunistically

Grounded examples from current code:

- `const contentWidth = cols` is redundant
- `data.toString('utf-8')` is effectively parsed twice in the data handler
- `client.setOnChange((force) => draw(force))` should be checked for direct pass-through

Impact:

- small, but real: about **-2 to -5**

Risk/tests:

- Very low risk

### 8) Add a shared `syncAndDraw()` helper only if it produces a net deletion

Important nuance:

- repeated `syncPromptToClient(); draw()` pairs are real duplication
- but a helper here is only worth it if it deletes more lines than it adds
- if it turns into another thin wrapper that every callsite must special-case, skip it

Impact:

- likely **small**: about **0 to -6** repo LOC depending on final shape

Risk/tests:

- Low risk
- Watch `src/client-startup.test.ts`
- Watch `tests/main.test.ts`
- Watch render tests if touched indirectly

## Ideas that are real, but should **not** be phase 1

These were the places where the earlier plan leaned too much toward re-homing logic.

### Move completion key handling into `src/cli/completion.ts`

This is **plausible**, but not a strong first-pass LOC attack.

Why it is not phase 1:

- `completion.ts` currently owns low-level completion state and helpers, not the full modal key-routing policy
- moving that policy there introduces a new cross-module contract
- if the old API surface stays, this easily becomes split-and-add-glue

Use this only if:

- the old `completion` API gets smaller at the same time, or
- it is part of a larger merge with popup ownership

Expected net repo impact:

- probably **small win or neutral** in a standalone pass

### Move help-bar key canonicalization into `src/cli/help-bar.ts`

This is grounded but tiny.

Why it is not phase 1:

- the current helper is very small
- the likely savings are marginal
- it risks adding another narrow cross-module method for almost no payoff

Expected net repo impact:

- about **0 to -3** in a good pass

### Push tab/draft sync ownership into `client.ts` or `prompt.ts`

This may be a design cleanup later, but it is **not yet a proven LOC win**.

Why it is not phase 1:

- the current callbacks are subtle startup/state-sync behavior
- easy to add glue and regressions without deleting much
- `src/client-startup.test.ts` suggests this area is behavior-dense

Expected net repo impact:

- **unclear / likely neutral** unless a larger simplification falls out

### Extract terminal lifecycle into another module

Do **not** count this as reduction unless it deletes duplication at the same time.

Simple extraction would only move lines around.

## Bigger cuts that would produce real repo reduction

These are real, but they are separate scope decisions, not the strongest path to "under 400 in one pass".

### Delete local `/raw` mode

This is the biggest credible repo reduction around this file.

Why:

- it is a debug feature, not core interaction flow
- it adds local command interception, formatter logic, batching state, tests, and completion knowledge

Impact:

- Net repo impact: roughly **-70 to -100**

Risk:

- product/UX risk, not technical risk
- needs an explicit product decision

### Merge completion behavior into the popup/selectable-list system

This is the best adjacent structural simplification, but not the safest first pass.

Why:

- `popup.ts` and `completion.ts` both have active state, items, selection, cycling, accept/dismiss behavior
- today `cli.ts` pays for two overlapping modal-selection systems

Impact:

- Credible net repo win if old duplicated behavior disappears for real
- But it is too much surface area for the "just get `cli.ts` under 400" pass

Risk:

- Medium/high
- Must watch popup, completion, cursor, and render behavior together

## Strongest execution path

This should be the default execution plan if the goal is **real reduction, minimal risk, repo cloc flat/down**.

### Phase 1: delete obvious dead weight

1. Delete `submitCommandType()`
2. Delete its test in `src/client/cli.test.ts`
3. Inline local `/raw` handling into `submit()`
4. Delete `handlePopupKey()`

Expected result:

- real repo LOC down immediately
- probably lands around **405-395** already, depending on final edits

### Phase 2: dedupe concrete repeated code inside `cli.ts`

5. Merge the tab-stop functions
6. Dedupe the max-tab guard/error text
7. Inline trivial locals / repeated one-liners
8. Add `syncAndDraw()` only if the diff is clearly net-negative in LOC

Expected result:

- very likely enough to get `src/client/cli.ts` **under 400**
- repo LOC still down

### Phase 3: only if more reduction is still wanted after measuring

9. Simplify `handleAppKey()` into grouped modifier cases
10. Stop and re-run `bun cloc`

Expected result:

- likely lands around **385-395** with a conservative pass
- maybe **high 370s / low 380s** if the app-key cleanup collapses nicely

## What should explicitly *not* happen in the first pass

To keep this a real reduction pass, avoid these unless they delete old code in the same diff:

- extracting terminal lifecycle to a new helper module
- extracting keybindings to a new helper module
- moving completion handling into `completion.ts` without shrinking the public surface there
- moving help-bar canonicalization just to relocate a tiny helper
- moving draft/tab-switch ownership without a measured repo-LOC win

## Is under 400 reachable in one pass with repo cloc flat/down?

**Yes.**

A conservative, grounded path is:

- delete `submitCommandType()` and its test
- inline local `/raw` handling
- delete `handlePopupKey()`
- merge the tab-stop functions
- dedupe max-tab guard logic
- take the small trivial inlines that fall out naturally

That should be enough without any module splits.

## Tests / risks to call out in the execution plan

### Terminal lifecycle / tab stops

Watch:

- `tests/main.test.ts`
- `tests/tabs.test.ts`
- render tests if behavior changes spill into paint timing

Main risks:

- terminal left in wrong mode
- default tab stops not restored on exit/resume
- redraw timing regressions on resize or resume

### Keybinding cleanup

Watch:

- `src/client/cli.test.ts`
- `tests/main.test.ts`
- `tests/tabs.test.ts`

Main risks:

- ctrl-t vs ctrl-shift-t collision
- ctrl-d quitting too eagerly
- alt-m fallback broken
- escape abort too broad
- enter continue vs submit changed

### Draft/prompt sync touches

Watch:

- `src/client-startup.test.ts`
- `tests/main.test.ts`

Main risks:

- prompt state and client state diverge
- active-tab draft restore regresses
- multi-client draft arrival stops updating the prompt

## Bottom line

- The file is **only 17 LOC over 400**, so the first pass should be **deletion and dedupe**, not architecture churn.
- The strongest one-pass route is: **delete dead wrappers/tests, dedupe tab stops and max-tab checks, then lightly simplify `handleAppKey()` if needed**.
- Ideas like moving completion ownership or extracting terminal/session helpers are **not good first-pass LOC tactics** unless they also delete old API surface in the same diff.
- If the project wants a materially larger cut than that, the two real levers are:
  - **delete `/raw`**, or
  - **merge completion with popup selection behavior**

## Ready for execution?

**Yes.**

But the execution should be constrained to the strong path above. If the change starts turning into "split `cli.ts` into more files", it has drifted away from the stated LOC-reduction goal.
