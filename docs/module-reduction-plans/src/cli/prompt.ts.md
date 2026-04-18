# LOC reduction review for `src/cli/prompt.ts`

## Review verdict

**Verdict: tighten before execution.**

The old direction was partly right, but two parts were too optimistic on the current branch:

- it overvalued cross-file extraction as the first move for a file that is only **15 LOC** over target
- it treated width-logic dedupe as a near-term LOC win even though the current prompt code also owns cursor↔row/col mapping, not just wrapping

Verified on the live branch:

- `./test`: **passes**
- `bun cloc src/cli/prompt.ts`: **515 LOC**
- `bun cloc`: **12,782 LOC** total
- Current files still above 500 LOC:
	- `src/client.ts` — 954
	- `src/runtime/commands.ts` — 656
	- `src/server/runtime.ts` — 580
	- `src/cli/prompt.ts` — 515

Reviewed against:

- `src/cli/prompt.ts`
- `tests/prompt.test.ts`
- `src/cli/line-editor.ts`
- `src/cli/line-editor.test.ts`
- `src/client/cli.ts`
- `src/client/render-status.ts`
- `tests/render.test.ts`
- `tests/render-width.test.ts`
- `docs/terminal.md`
- `src/utils/strings.ts`

## What is true on the current branch

`src/cli/prompt.ts` still mixes several jobs:

- wrapped prompt layout
- cursor mapping across wrapped rows
- editor state
- selection primitives
- undo / redo
- submitted-history browsing
- clipboard glue
- placeholder resolution for async paste
- prompt rendering with highlighted selection
- a large key dispatcher

That mix is real. But from the current file shape, the **largest credible one-pass LOC win is still inside `prompt.ts` itself**, especially `handleKey()` and a few nearby state helpers.

## Strongest execution path, ordered by credible net LOC reduction

This order is about **real repo-wide savings from the current code**, not abstract elegance.

### 1. Collapse `handleKey()` first

This is the best first move now.

Why it is first:

- it is entirely inside the 515-line file
- it can plausibly save **20–35 LOC** by deleting duplication, which is already enough to get under 500
- it avoids helper-module overhead
- it keeps API churn near zero for `src/client/cli.ts` and `src/client/render-status.ts`

Where the live duplication still is:

- repeated cmd-key branches with identical `return true`
- repeated home/end movement paths
- repeated left/right structure
- repeated backspace/delete/ctrl-d structure
- repeated selection-anchor-or-clear patterns
- repeated goal-column reset paths

Good shape:

- early `if (k.cmd) return handleCmdKey(...)`
- normal-path `switch` or equivalent grouped dispatch
- one helper for horizontal movement
- one helper for delete direction / word delete vs char delete
- keep history browse vs wrapped vertical move in prompt; that part is still prompt-specific

**Expected result:** most likely enough by itself to cross 500.

### 2. Do small prompt-local cleanup immediately after

Take the obvious local deletes before introducing a new shared module.

Targets:

- fold repeated “load text + move cursor to end + clear selection/goal” paths
- tighten tiny reset helpers around selection / goal / history state
- remove one-use helpers that become dead after key-handler cleanup

Realistic savings:

- `prompt.ts`: **-5 to -10 LOC**
- repo net: same

This is the cheapest follow-up after step 1.

### 3. Only then consider a tiny shared editor primitive layer with `line-editor.ts`

There is real duplication with `src/cli/line-editor.ts`, but this should be a **second move**, not the first one.

Shared seams that really exist today:

- clamp cursor to text bounds
- selection range from `{ cursor, selAnchor }`
- move with optional selection
- replace selection
- delete selection
- inverse-video rendering of the selected span

Hard boundary for the helper:

- plain text state only
- no undo / redo
- no prompt history
- no wrapped layout
- no clipboard
- no async placeholder logic
- no viewport logic

Updated savings estimate from the live code:

- likely repo net: **about -5 to -20 LOC**
- not the earlier `-20 to -40` unless the helper stays extremely small

Why the estimate is lower than the older draft:

- `line-editor.ts` is only **134 LOC**, so there is less duplicate bulk to harvest than the old framing implied
- a new shared module has real boilerplate cost in this codebase
- if the helper starts carrying behavior branches for both editors, savings evaporate fast

**Stop condition for this step:** if the helper grows close to the code it replaces, abandon it.

### 4. Clipboard write glue is optional cleanup, not a main reduction path

`prompt.ts` still owns `pbcopy` writing while `clipboard.ts` owns paste cleanup and async replacement entry.

That move is fine only if it stays tiny.

Expected savings:

- `prompt.ts`: **-7 to -9 LOC**
- repo net: **tiny**

Do not take this before steps 1–2.

### 5. Treat width-logic dedupe as a separate correctness pass unless still needed

This should **not** be the first-pass LOC plan.

Why the old draft was too optimistic here:

- `prompt.ts` does not just wrap text; it also computes `starts`, `cursorToRowCol()`, `rowColToCursor()`, and `verticalMove()`
- `src/utils/strings.ts` gives shared width primitives like `visLen()` and `wordWrap()`, but not the cursor-mapping machinery prompt currently needs
- a real width-correct rewrite may end up **flat or up** in LOC before later cleanup pays it back

So:

- yes, the current `.length`-based prompt layout conflicts with the terminal rules in `docs/terminal.md`
- no, this is not the strongest first pass if the immediate goal is “under 500 with net LOC down”

This is a good **second pass** for correctness once prompt is already below target.

## What must NOT happen during execution

Do **not** do any of these:

- do **not** push prompt ownership into `src/client.ts`
	- it is already **954 LOC**
	- that would reduce one target by bloating a worse one
- do **not** create a generic “editor framework” to share prompt and line-editor logic
- do **not** count split-and-glue as reduction
	- adding a helper module is only valid if repo `cloc` goes down
- do **not** mix the width-correctness rewrite into the first shrink pass unless tests land first
- do **not** change prompt’s public surface more than necessary
	- `src/client/cli.ts`, `src/client/render-status.ts`, and `src/client/render.ts` already depend on it directly
- do **not** regress these behaviors:
	- grouped typing undo / redo
	- history draft enter / exit
	- exact-width blank-line cursor behavior
	- selection highlighting in rendered prompt lines
	- cmd-word motion around punctuation
	- async placeholder replacement when the placeholder is still present

## Coverage reality on the current branch

Already covered today:

- shift-enter inserts newline
- alt-left / alt-right word motion
- cmd-left / cmd-right punctuation-aware motion
- cmd-a + backspace clears multiline selection
- grouped typing undo
- exact-width initial blank-line cursor case in `buildPrompt()`

Still missing before risky prompt surgery:

1. history browse enters with `up`, preserves `historyDraft`, and exits back to draft with `down`
2. redo after grouped typing undo
3. selection rendering across a wrapped prompt line
4. exact-width blank-line cursor after edits, not just after `setText()`
5. emoji / CJK width in `buildPrompt()` and wrapped vertical movement
6. async placeholder resolution when the placeholder is gone or the user typed after it

Important nuance:

- `tests/render-width.test.ts` currently checks clipped frame width, but it does **not** directly prove prompt wrapping is width-correct for wide characters
- if step 5 ever starts, add prompt-focused tests first

## Overlap and merge risk

### `src/client.ts`

High risk only if the execution cheats.

Safe rule:

- reduce prompt internals
- keep prompt ownership inside `prompt.ts`
- avoid moving draft/history state into `client.ts`

### `src/cli/line-editor.ts`

Medium risk if shared-primitives work is attempted.

Safe rule:

- coordinate if someone else is actively changing line-editor
- keep any shared module tiny enough that both callers get simpler

### `src/client/render-status.ts` and render tests

Moderate correctness risk, low merge risk.

Reason:

- `render-status.ts` calls `prompt.buildPrompt(cols)` directly
- prompt line count feeds chrome height
- prompt line content is rendered straight into the frame

So prompt rendering changes can break terminal invariants even when prompt tests pass.

## Stop conditions

After each real step, run:

- `./test`
- `bun cloc src/cli/prompt.ts`
- `bun cloc`

Stop the pass when **all** of these are true:

- `src/cli/prompt.ts < 500 LOC`
- repo `cloc` is down, not up
- no extra helper module was introduced just to move code around

Abort the shared-helper direction if either happens:

- the new helper grows close to the lines it replaces
- prompt and line-editor need diverging branches inside the helper

Abort the width-rewrite direction for this pass if either happens:

- cursor-mapping complexity expands instead of shrinking
- new tests reveal wide-char behavior gaps that need a dedicated correctness pass

## Is under-500 in one pass still realistic?

**Yes.**

But the realistic one-pass route from the current branch is:

1. add the few missing prompt tests that protect history / redo / wrap behavior
2. simplify `handleKey()` hard
3. take the small prompt-local helper cleanup that falls out of that rewrite
4. stop as soon as `prompt.ts` is under 500 and repo `cloc` is lower

What is **not** realistic as the first pass:

- replaying stale “cheap deletes” that are already gone
- assuming the width rewrite is a free LOC win
- winning by moving code into `src/client.ts`

## Ready-for-execution verdict

**Yes, after this tightening the plan is ready for execution.**

Recommended first pass:

- **prompt-local simplification first**
- **cross-file dedupe only if still useful after that**
- **width-correctness rewrite as a separate pass unless the file somehow still stays above 500**
