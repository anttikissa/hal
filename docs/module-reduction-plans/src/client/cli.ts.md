# LOC reduction plan for `src/client/cli.ts`

## Current size

- Current `bun cloc` LOC for `src/client/cli.ts`: **417**
- Command run: `bun cloc src/client/cli.ts`
- Credible path under 400 LOC: **yes, easily**
- Credible path to a more meaningful drop in one pass: **probably to ~360-380 with low/medium risk; below ~330 likely needs feature cuts or a completion/popup merge**

## Files/read paths reviewed

- `src/client/cli.ts`
- `src/client/cli.test.ts`
- `src/main.ts`
- `src/client-startup.test.ts`
- `src/client/popup.ts`
- `src/cli/completion.ts`
- `src/cli/prompt.ts`
- `src/client/render.ts`
- `src/client/render-status.ts`
- `src/cli/help-bar.ts`
- `src/cli/keys.ts`
- `docs/terminal.md`

## Responsibilities currently mixed together

`src/client/cli.ts` is not just “CLI input”. It currently mixes at least these jobs:

1. Terminal lifecycle
- kitty keyboard protocol enable/disable
- bracketed paste enable/disable
- custom tab stop install/restore
- raw mode on stdin
- suspend/resume signal handling
- final cleanup on exit

2. Paint scheduling
- throttled redraw policy during streaming
- immediate force redraw path for resize/tab switch/ctrl-l

3. Submission policy
- prompt submission
- local-only `/raw` interception
- prompt history updates
- popup/completion dismissal on submit

4. Raw debug mode
- raw-mode state
- token formatting
- batching/coalescing output
- raw-mode test hooks

5. Key routing
- popup ownership of the keyboard
- completion ownership of tab/up/down/enter/escape
- app-level shortcuts
- fallback to prompt editing

6. Small bits of presentation/help logic
- canonical help-bar key naming
- max-tabs error text

7. Startup wiring / state synchronization
- client onChange hook
- prompt render callback
- draft load/save on tab switch
- draft sync from other clients
- stdin data event loop

That is why the file feels large: it is a coordination module plus three small feature modules living inline.

## Plausible reduction ideas

Grouped by type. Estimates are net repo-cloc impact, not just “move lines elsewhere”, unless noted.

### A. Delete dead or near-dead wrappers first

#### 1) Delete `submitCommandType()` and inline `'prompt'`
Why:
- It always returns `'prompt'`
- Both parameters are unused
- The test only proves that a constant-return wrapper returns a constant

Impact:
- `cli.ts`: about **-6 to -8**
- `cli.test.ts`: about **-8 to -12**
- Net repo impact: about **-14 to -20**

Risk/tests:
- Very low risk
- Watch `src/client/cli.test.ts`
- Watch for any future code path that wanted busy-sensitive routing; none exists now

#### 2) Inline `handleLocalCommand()` into `submit()`
Why:
- Single-use wrapper
- Only supports one command: `/raw`

Impact:
- `cli.ts`: about **-4 to -6**

Risk/tests:
- Low risk
- Watch raw-mode tests in `src/client/cli.test.ts`
- Watch `/raw` help/completion behavior manually through tests already covering formatting/raw mode

#### 3) Delete `handlePopupKey()` wrapper
Why:
- It is just `if (!popup.state.active) return false; return popup.handleKey(k)`
- No extra policy, no extra abstraction value

Impact:
- `cli.ts`: about **-3 to -5**

Risk/tests:
- Very low risk
- Watch popup-related tests and model picker behavior (`src/client/popup.test.ts`, `tests/main.test.ts` kitty model picker case)

#### 4) Inline trivial local vars in the stdin handler
Examples:
- `const cols = process.stdout.columns || 80`
- `const contentWidth = cols`

Impact:
- `cli.ts`: about **-2 to -4**

Risk/tests:
- Very low risk
- Mostly mechanical

### B. Simplify repeated local patterns

#### 5) Add one helper for the repeated `syncPromptToClient(); draw()` sequence
Likely helper shape:
- `syncAndDraw(force = false)`

Why:
- The pair appears repeatedly in prompt render callback, popup callback, tab-switch handling, draft-arrival handling, popup/completion/prompt key paths
- This is coordination logic, but right now it is copied inline many times

Impact:
- `cli.ts`: about **-5 to -9**

Risk/tests:
- Low risk
- Watch prompt state/render coupling tests:
	- `src/client-startup.test.ts`
	- `tests/main.test.ts`
	- `tests/render*.test.ts`

#### 6) Merge `setTabStops()` and `restoreDefaultTabStops()` into one parameterized helper
Why:
- Same algorithm twice
- Only step/start differ (`tabWidth` vs 8)

Possible shape:
- `writeTabStops(cols, step)`
- `writeTabStops(cols, blocks.config.tabWidth)`
- `writeTabStops(cols, 8)`

Impact:
- `cli.ts`: about **-6 to -10**

Risk/tests:
- Low/medium risk because terminal behavior is fragile
- Watch terminal startup/exit/resume paths indirectly via:
	- `tests/main.test.ts`
	- `tests/tabs.test.ts`
	- manual bounded startup if needed later
- Also re-read `docs/terminal.md` before touching behavior, not just code shape

#### 7) Factor “max tab cap” handling into one helper
Current duplication:
- ctrl-t open
- ctrl-shift-t resume
- ctrl-f fork

Possible helper shape:
- `sendTabCommandIfRoom(type, text?)`
- or `hasRoomForNewTab()` + one shared error emitter

Impact:
- `cli.ts`: about **-6 to -10**

Risk/tests:
- Low risk
- Watch `src/client/cli.test.ts`
- Watch `tests/tabs.test.ts`
- Important detail: fork needs current tab session id, resume/open do not

#### 8) Collapse the long `handleAppKey()` if-chain by grouping by modifier class
Why:
- Most branches are `ctrl` shortcuts
- Many checks repeat `!alt && !cmd` or similar gating
- A `switch (k.key)` inside a `ctrl-only` block would save repeated boilerplate

Impact:
- `cli.ts`: about **-12 to -25** depending on how aggressively cleaned up

Risk/tests:
- Medium risk: ordering matters
- Sensitive cases:
	- ctrl-t vs ctrl-shift-t
	- ctrl-d only when prompt empty
	- enter continue vs submit
	- alt-m fallback must remain
	- escape abort only while busy
- Watch `src/client/cli.test.ts`, `tests/main.test.ts`, `tests/tabs.test.ts`

### C. Dedupe by moving ownership to the module that already owns the state

#### 9) Move completion key handling into `src/cli/completion.ts`
Why:
- `completion.ts` already owns completion state and mutation helpers
- `cli.ts` currently reaches inside `completion.state` directly and manually orchestrates activation, cycling, selection, dismissal
- That is a strong sign the ownership boundary is wrong

Possible end state:
- `completion.handleKey(k, promptText, cursor)` returns either `false` or an apply-result describing new prompt text/cursor/dismissed state

Impact:
- `cli.ts`: about **-25 to -40**
- `completion.ts`: about **+15 to +25**
- Net repo impact: about **-10 to -15**

Risk/tests:
- Medium risk
- Watch `src/cli/completion.test.ts`
- Watch `src/client/cli.test.ts`
- Watch prompt rendering/tests if accepted completions affect cursor placement

#### 10) Move help-bar key canonicalization into `src/cli/help-bar.ts`
Why:
- `canonicalKeyName()` exists only to support help-bar usage tracking
- The filtering policy (“only log modifier/special keys”) is also local to this concern
- `prev/src/cli/key-usage.ts` already had this concept as module-owned behavior

Possible end state:
- `helpBar.logEvent(k)` instead of `helpBar.logKey(canonicalKeyName(k))`

Impact:
- `cli.ts`: about **-8 to -12**
- `help-bar.ts`: about **+6 to +10**
- Net repo impact: about **-2 to -4**

Risk/tests:
- Low risk
- No strong direct tests today, so behavior drift is easy to miss
- Watch help-bar text indirectly in render tests if usage learning affects visibility later

#### 11) Move terminal mode setup/teardown into a tiny helper module only if it also deletes duplication
Why:
- `cleanupTerminal()`, `suspend()`, `onSigcont()`, startup tty setup, kitty/paste/tab-stop toggles are one conceptual unit
- But extraction alone does not reduce repo LOC

Net impact:
- **Neutral or small win only if paired with dedupe**
- Likely **0 to -8** if the API is tighter than the current duplicated branches
- If it is just “move lines elsewhere”, skip it

Risk/tests:
- Medium/high because terminal state bugs are miserable
- Good cleanup target eventually, but not the best first LOC win

### D. Merge overlapping features instead of just extracting them

#### 12) Merge completion selection behavior into `popup.ts` as a generic selectable list layer
Why:
- `popup.ts` and `completion.ts` both own:
	- active state
	- items
	- selected index
	- cycle up/down
	- enter/escape/tab handling
- Right now `cli.ts` pays for two modal-selection systems
- A shared “selectable list + optional editor” could remove duplicate behavior from both modules

Net impact:
- `cli.ts`: about **-30 to -50**
- `completion.ts`: about **-10 to -20** or file deletion if fully absorbed
- `popup.ts`: about **+15 to +30**
- Net repo impact: about **-20 to -40**

Risk/tests:
- Medium/high
- Biggest behavioral question: completion today is stateful but not obviously rendered as a popup; merging may subtly change UX
- Watch:
	- `src/client/popup.test.ts`
	- `src/cli/completion.test.ts`
	- `src/client/cli.test.ts`
	- prompt/render tests

This is the best structural reduction idea if the goal is repo-cloc, not just this file.

#### 13) Push tab/draft sync ownership down into `client.ts` or `prompt.ts`
Why:
- `cli.ts` currently wires:
	- save draft on tab switch
	- restore per-tab draft/history
	- show draft when another client saves one
- Some of this may belong in `client.ts` as higher-level tab lifecycle, or in `prompt.ts` as prompt lifecycle

Net impact:
- Highly variable; likely **small or neutral unless it deletes cross-module glue**
- Estimate: **0 to -10** repo LOC in a good pass

Risk/tests:
- Medium risk because startup behavior is subtle
- Watch `src/client-startup.test.ts` especially
- Do not do this only to shuffle lines

### E. Feature cuts / optional deletions if the project wants a harder prune

#### 14) Delete local `/raw` mode entirely
Why:
- It is a debug feature, not core product behavior
- It adds local-command interception, formatter logic, batching state, test hooks, completion special-casing, docs/help text
- The command is documented in runtime command help, but its behavior is local-only, which is already a smell

Net impact:
- `cli.ts`: about **-45 to -70**
- `cli.test.ts`: about **-25 to -40**
- `cli/completion.ts`: tiny win (remove `/raw` special-case comment/union handling if simplified)
- `runtime/commands.ts`: small doc/help win
- Net repo impact: about **-70 to -100**

Risk/tests:
- Product/UX risk, not technical risk
- If someone relies on `/raw` to debug terminal protocol issues, this removal hurts
- If kept, it should at least be isolated better

This is the single biggest credible repo-cloc win around this file.

#### 15) Trim restart/suspend special handling only if product scope allows it
Candidates:
- ctrl-r restart path
- custom tab-stop restoration on exit/resume
- maybe even suspend support if not a project requirement

Net impact:
- Potentially **-15 to -40** depending on scope

Risk/tests:
- High product-risk
- These are normal terminal affordances; deleting them may make the app feel broken/unix-hostile
- Not recommended unless there is an explicit simplification mandate

## Ideas I would *not* count as real reduction wins

These may make the file shorter, but they do not obviously reduce repo cloc:

- Extract raw mode to `src/cli/raw-mode.ts` without deleting anything
- Extract terminal lifecycle to `src/cli/terminal-session.ts` without deleting duplication
- Extract app keybindings to `src/client/keybindings.ts` without shrinking logic

Those are organization changes, not actual simplifications, unless paired with deletion/merging.

## Risks / tests to watch by area

### Terminal lifecycle changes
Watch:
- `tests/main.test.ts`
- `tests/tabs.test.ts`
- `tests/render*.test.ts`
- anything touching startup/exit/suspend/model picker on kitty terminals

Main risks:
- terminal left in kitty mode/raw mode
- broken tab stops after exit/resume
- repaint timing regressions after signal handling cleanup

### Completion / popup changes
Watch:
- `src/cli/completion.test.ts`
- `src/client/popup.test.ts`
- `src/client/cli.test.ts`
- render tests for prompt/cursor placement

Main risks:
- enter/tab/shift-tab precedence changes
- completion accepted when it should cycle
- popup stealing keys incorrectly

### App keybinding cleanup
Watch:
- `src/client/cli.test.ts`
- `tests/tabs.test.ts`
- `tests/main.test.ts`

Main risks:
- ctrl-t vs ctrl-shift-t collision
- ctrl-d empty-prompt quit behavior
- alt-m fallback accidentally broken
- escape abort firing too broadly

### Draft/startup ownership changes
Watch:
- `src/client-startup.test.ts`
- `tests/main.test.ts`

Main risks:
- draft not restored on startup/tab switch
- prompt/client state diverging
- multi-client draft pickup regressing

## Recommended execution sequence

Aim: reduce **repo** cloc, not just relocate code.

### Phase 1: easy, low-risk wins
1. Delete `submitCommandType()` and its tests
2. Inline `handleLocalCommand()` into `submit()`
3. Delete `handlePopupKey()`
4. Add `syncAndDraw()` helper for repeated sync+paint pairs
5. Merge the two tab-stop functions
6. Add one helper for tab-cap checks / shared error text

Expected result:
- Very likely enough to push `src/client/cli.ts` **under 400 LOC**
- Expected net repo reduction: roughly **20-40 LOC**
- Low regression risk

### Phase 2: medium-risk, still practical
7. Rewrite `handleAppKey()` into grouped modifier blocks / switch statements
8. Move completion key ownership into `completion.ts`
9. Move help-bar key canonicalization into `help-bar.ts`

Expected result:
- Likely lands `cli.ts` around **360-380 LOC**
- Repo reduction maybe **another 15-30 LOC** if done carefully

### Phase 3: bigger structural simplification
10. Decide whether completion should be absorbed by `popup.ts`
11. Decide whether `/raw` should survive at all

Expected result:
- If completion merges into popup: real repo simplification, not just file shuffling
- If `/raw` is removed: this area can shrink a lot in one pass

## Is under 400 credible?

Yes.

A very believable under-400 route without changing product behavior much is:
- delete `submitCommandType`
- inline `handleLocalCommand`
- delete `handlePopupKey`
- add a shared `syncAndDraw`
- dedupe tab-stop functions
- dedupe tab-cap logic

That should be enough.

## Is a major reduction reachable in one pass?

- **Under 400:** yes, comfortably
- **Around 360-380:** yes, with moderate refactoring
- **Around 320-340:** only if you are willing to merge completion into popup and/or delete `/raw`
- **Much below that:** not credibly without feature cuts or broader ownership changes

## Opportunities that would also reduce other large files

### Completion/popup merge
This is the clearest adjacent repo win.
- Could reduce `src/client/cli.ts`
- Could reduce or delete chunks of `src/cli/completion.ts` (181 LOC)
- Could modestly simplify `src/client/popup.ts` by making it the single selection UI system

### Remove `/raw`
Would shrink more than one file.
- `src/client/cli.ts`
- `src/client/cli.test.ts`
- `src/cli/completion.ts` special-case knowledge/comments
- `src/runtime/commands.ts` help/usage text

### Better ownership of prompt/client sync
If done carefully, it could trim glue in both:
- `src/client/cli.ts`
- `src/client.ts` (954 LOC) by clarifying which module owns draft/history transitions

But this one is easy to get wrong; treat it as a cleanup follow-up, not a first-pass LOC attack.

## Bottom line

Best immediate reduction ideas:
- delete `submitCommandType`
- remove trivial wrappers (`handleLocalCommand`, `handlePopupKey`)
- collapse repeated `syncPromptToClient(); draw()` pairs
- dedupe tab-stop logic
- dedupe max-tab guard logic
- then simplify `handleAppKey()`

Best bigger structural win:
- merge completion behavior into the existing popup/selectable-list system

Best high-impact optional cut:
- delete `/raw` if the project is serious about stripping debug-only surface area
