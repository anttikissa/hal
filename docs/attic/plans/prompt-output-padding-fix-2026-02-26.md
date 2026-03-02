# Prompt/output horizontal padding fix (2026-02-26)

## Problem

- Prompt editor text wraps all the way to the right border (no guaranteed right gutter).
- Prompt echo lines in the main output viewport are also missing consistent left/right padding.
- We want one reusable padding mechanism so other output kinds can adopt it later.

## Plan

1. Add a shared horizontal-padding helper for plain wrapped text:
	- compute content width from terminal columns + left/right padding
	- wrap text to content width
	- apply left/right space padding per visual line
2. Use the helper for prompt echo formatting (`buildPromptBlockFormatter`) so prompt output lines get 1-column left/right padding and wrap to fit.
3. Use the same helper in TUI input layout width calculation to guarantee a right-side gutter while editing.
4. Add focused unit tests for the shared helper and prompt formatter wrapping behavior.
5. Update `docs/tui.md` to document the new side-padding behavior.
6. Run tests (`bun run test:quick` and targeted CLI tests), then commit only the intended files.
