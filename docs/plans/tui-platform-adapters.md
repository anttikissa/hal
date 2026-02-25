# TUI Platform/Terminal Adapters (Minimal)

## Goal

Move platform/terminal-specific code out of `src/cli/tui.ts` / `src/cli/clipboard.ts` into small modules, and only load special-case code when detected.

## Scope (this pass)

- Extract Kitty terminal integration (keyboard protocol enable/disable + Kitty key normalization) to its own module.
- Add a tiny terminal integration loader that detects terminal flavor and dynamically imports Kitty support only when needed.
- Extract Darwin clipboard commands (`pbcopy`, `pbpaste`, `osascript`) to a clipboard host module.
- Add a clipboard host loader that dynamically imports the platform module on demand.
- Keep behavior minimal: prefer existing `pbcopy`/`pbpaste` path, no extra clipboard mechanisms.

## Non-goals (this pass)

- Full Kitty keyboard protocol support (only what HAL already needs).
- New Linux/iTerm clipboard features.
- Architecture changes in `client.ts` transcript bootstrapping.
