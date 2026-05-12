# `src/cli/prompt.ts` under-500 plan

Current measurement on 2026-05-12:

- `src/cli/prompt.ts`: **580 bun-cloc LOC**
- repo total from full `bun cloc`: **14981 LOC**
- `./test`: **701 pass, 0 fail** before planning

This is a planning document only. The user should review/refine before implementation.

## Why this file keeps growing

`prompt.ts` combines editor behavior and rendering:

- word wrapping
- cursor-to-row/col mapping
- row/col-to-cursor mapping
- vertical movement across wrapped rows
- simple word movement
- option/cmd word movement with punctuation rules
- editor state
- selection
- undo/redo
- submitted-history browsing
- kill/yank
- OS clipboard write/paste
- async paste placeholder replacement
- key dispatch
- prompt rendering with selection highlighting
- public API

The file grew because correctness fixes naturally land in the only module that understands both editing state and wrapped layout.

## Current large chunks

Large current functions/regions by physical line count:

- layout/wrap/cursor functions — roughly 65 physical lines
- `optionWordLeft()` + `optionWordRight()` — roughly 58
- history browse helpers — roughly 45
- clipboard/paste helpers — roughly 35
- `handleCmdKey()` + `handleKey()` — roughly 119
- rendering/public API — roughly 105

The file is only about 80 LOC over target, so it does not need a broad editor framework.

## Architecture alternatives

### Alternative A — Extract wrapped layout/cursor mapping

Move layout-specific code into `src/cli/prompt-layout.ts`:

- `wordWrapLines()`
- `getLayout()`
- `cursorToRowCol()`
- `rowColToCursor()`
- `verticalMove()`
- possibly selection rendering spans later

`prompt.ts` keeps editor state and key handling.

Pros:

- clean conceptual boundary
- likely enough to put `prompt.ts` below 500
- makes future width-correctness work easier

Cons:

- can be repo-LOC flat/up if moved without simplifying
- current code is `.length`-based; a full `visLen()` rewrite needs tests and may grow first

Verdict: recommended first architecture, with behavior-locking tests.

### Alternative B — Extract keymap/action table

Keep layout local, but make key handling declarative:

- action helpers remain in prompt
- key dispatch becomes a small table or grouped helper functions

Pros:

- low risk
- can save LOC without new module boilerplate

Cons:

- previous passes already shrank key handling somewhat
- does not address layout ownership

Verdict: good fallback or second step if layout extraction is not desired.

### Alternative C — Extract editor core shared with `line-editor.ts`

Create a tiny shared primitive module for:

- clamp
- selection range
- move with optional selection
- replace selection
- delete selection

Pros:

- real shared domain

Cons:

- `line-editor.ts` is only 134 LOC, so savings ceiling is low
- generic editor core can become abstraction-heavy fast

Verdict: only do if the helper is tiny and repo LOC goes down.

## Recommended execution path

### Step 1 — Add/verify behavior-locking tests before risky layout/key changes

Add or verify tests for:

- history browse restores draft after up/down
- redo after grouped typing undo
- wrapped selection rendering
- exact-width blank-line cursor after edits
- emoji/CJK prompt width behavior if touching layout
- cmd/option word movement around punctuation
- async placeholder replacement when the placeholder is missing or cursor moved

Expected impact:

- tests add LOC, but protect behavior

### Step 2 — Extract layout/cursor mapping to `src/cli/prompt-layout.ts`

Move the layout functions and keep them pure:

```ts
export const promptLayout = {
	wordWrapLines,
	getLayout,
	cursorToRowCol,
	rowColToCursor,
	verticalMove,
}
```

Potential improvement:

- use `visLen()` / width-aware helpers where practical
- if a full width-correct rewrite grows too much, defer it and move current behavior first

Expected impact:

- `prompt.ts`: -70 to -90 LOC
- new module: +60 to +85 LOC
- repo net: flat/slightly down

This alone should bring `prompt.ts` below 500.

### Step 3 — Compact word movement helpers

Current option/cmd word movement is behavior-heavy but has repeated scanning loops. Consider tiny local scanner helpers:

- `skipLeft()`
- `skipRight()`
- `isSeparator()`
- token-vs-punctuation predicates

Keep comments for tricky punctuation behavior.

Expected impact:

- `prompt.ts`: -10 to -20 LOC
- repo net: down if helpers are smaller than repeated loops

### Step 4 — Move clipboard write into `src/cli/clipboard.ts`

`prompt.ts` owns `writeToClipboard()` while `clipboard.ts` already owns paste behavior.

Move a tiny `clipboard.copy(text)` helper.

Expected impact:

- `prompt.ts`: -7 to -9 LOC
- `clipboard.ts`: +4 to +7 LOC
- repo net: small down/flat

### Step 5 — Final key dispatch cleanup if still needed

If still over 500 after steps 2–4:

- split `handleKey()` into `handleCtrlKey`, `handleNavigationKey`, `handleTextInput`
- or use a very small action table for simple ctrl keys

Avoid overengineering; current `handleKey()` is readable and already partly compacted.

Expected impact:

- `prompt.ts`: -10 to -25 LOC

## Expected outcome

Conservative:

- layout extraction: 580 → ~500
- clipboard: ~500 → ~492

Aggressive:

- layout extraction + word scanner cleanup + key cleanup: **430–470 LOC**

## Tests to watch

- `tests/prompt.test.ts`
- `src/cli/line-editor.test.ts` if shared primitives are touched
- `tests/render.test.ts`
- `tests/render-width.test.ts`
- `tests/render-single-pass.test.ts`

## Must not happen

- Do not push prompt state into `client.ts`; it is already the biggest offender.
- Do not create a broad editor framework.
- Do not rewrite width behavior without tests.
- Do not trade 80 removed LOC for 120 LOC of abstraction.
- Do not violate terminal width rules in new code: use `visLen()` / width-aware utilities for new width logic.
