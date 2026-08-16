# TODO

Random ideas, in no particular order. Nothing here is a promise.

## Hal itself

- AGENTS.md change - should send a summary of changes to agent at start of next turn (like /cd,
  model changes, etc)
- colgrep https://github.com/lightonai/next-plaid?tab=readme-ov-file#colgrep
- IPC log truncation / compaction
- Autocomplete should be better: at minimum, if completion is not unique, show/print all available
  completions instead of appearing to do nothing.
- Verify the `grok/` provider against a real `GROK_API_KEY`. Anthropic, OpenAI, OpenRouter, and
  Gemini were probed live and work; Grok uses the same compat path but is untested.

## README

- Add a screenshot or short terminal recording near the top so readers immediately see the UI.
- Add a command reference table for `/model`, `/login`, `/cd`, `/go`, `/self`, `/rebase`, and `/queue`.
- Add a "Development" section with `bun install`, `./test`, `bun cloc`, and the module/export
  conventions from [`AGENTS.md`](AGENTS.md).
- Add a "Security model" section that explains local file access, confirmation prompts, auth
  storage, `eval`, and the current lack of sandboxing.
- Add a "Configuration" section linking [`config-template.ason`](config-template.ason), local
  `config.ason`, and provider environment variables.
